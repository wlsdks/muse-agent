/**
 * Regression guard for `muse.skills.{list,read,run}`.
 *
 * The `run` tool can spawn arbitrary subprocesses, so the allowlist
 * + tokenizer + timeout behaviour are security-critical. These
 * tests pin the contract so a future refactor cannot silently let
 * the agent shell out to a binary the skill author didn't approve.
 */

import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSkillListTool,
  createSkillReadTool,
  createSkillRunTool,
  type SkillCatalogToolEntry,
  type SkillRegistryView
} from "../src/muse-tools-skills.js";

function makeRegistry(entries: SkillCatalogToolEntry[]): SkillRegistryView {
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  return {
    get: (name) => byName.get(name),
    list: () => entries
  };
}

const codex: SkillCatalogToolEntry = {
  body: "# Codex\nRun with `codex exec ...`.",
  description: "OpenAI Codex CLI delegation",
  emoji: "🧩",
  name: "codex",
  requiresAnyBins: ["codex"]
};

const gh: SkillCatalogToolEntry = {
  body: "# gh\nUse the GitHub CLI.",
  description: "GitHub CLI",
  name: "gh",
  requiresBins: ["gh"]
};

const noBins: SkillCatalogToolEntry = {
  body: "Docs only",
  description: "Pure documentation skill (no executable bins)",
  name: "docs"
};

describe("muse.skills.list", () => {
  it("returns each registered skill's metadata", async () => {
    const tool = createSkillListTool(makeRegistry([codex, gh]));
    const out = (await tool.execute({}, { runId: "r-1" })) as { readonly skills: ReadonlyArray<Record<string, unknown>> };
    expect(out.skills).toHaveLength(2);
    expect(out.skills[0]?.name).toBe("codex");
    expect(out.skills[0]?.emoji).toBe("🧩");
    expect(out.skills[1]?.name).toBe("gh");
    expect(out.skills[1]?.requiresBins).toEqual(["gh"]);
  });
});

describe("muse.skills.read", () => {
  it("returns the markdown body for a known skill", async () => {
    const tool = createSkillReadTool(makeRegistry([codex]));
    const out = (await tool.execute({ name: "codex" }, { runId: "r-1" })) as { readonly body: string };
    expect(out.body).toContain("# Codex");
  });

  it("returns an error for unknown skills", async () => {
    const tool = createSkillReadTool(makeRegistry([codex]));
    const out = (await tool.execute({ name: "missing" }, { runId: "r-1" })) as { readonly error?: string };
    expect(out.error).toMatch(/skill not found/u);
  });
});

describe("muse.skills.run allowlist enforcement", () => {
  let spawnMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    spawnMock = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses a command whose first token is NOT in requires.bins", async () => {
    const tool = createSkillRunTool(makeRegistry([gh]), { spawnImpl: spawnMock as never });
    const out = (await tool.execute({ command: "rm -rf /tmp/anything", name: "gh" }, { runId: "r-1" })) as {
      readonly allowedBins?: readonly string[];
      readonly error?: string;
    };
    expect(out.error).toMatch(/does not start with an allowed binary/u);
    expect(out.allowedBins).toEqual(["gh"]);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("refuses when the skill declared NO bins at all", async () => {
    const tool = createSkillRunTool(makeRegistry([noBins]), { spawnImpl: spawnMock as never });
    const out = (await tool.execute({ command: "anything", name: "docs" }, { runId: "r-1" })) as {
      readonly error?: string;
    };
    expect(out.error).toMatch(/declares no requires.bins/u);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("refuses an empty command", async () => {
    const tool = createSkillRunTool(makeRegistry([gh]), { spawnImpl: spawnMock as never });
    const out = (await tool.execute({ command: "   ", name: "gh" }, { runId: "r-1" })) as {
      readonly error?: string;
    };
    expect(out.error).toMatch(/must not be empty/u);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("accepts requires.anyBins entries", async () => {
    const fakeChild = makeFakeChild({ exitCode: 0, stdout: "codex output\n" });
    spawnMock.mockReturnValueOnce(fakeChild);
    const tool = createSkillRunTool(makeRegistry([codex]), { spawnImpl: spawnMock as never });
    const out = (await tool.execute({ command: "codex --version", name: "codex" }, { runId: "r-1" })) as {
      readonly stdout: string;
      readonly exitCode: number | null;
    };
    expect(spawnMock).toHaveBeenCalledWith("codex", ["--version"], expect.any(Object));
    expect(out.stdout).toContain("codex output");
    expect(out.exitCode).toBe(0);
  });

  it("respects single + double quoted arguments", async () => {
    const fakeChild = makeFakeChild({ exitCode: 0 });
    spawnMock.mockReturnValueOnce(fakeChild);
    const tool = createSkillRunTool(makeRegistry([gh]), { spawnImpl: spawnMock as never });
    await tool.execute(
      { command: `gh pr comment 123 --body "ship it" 'extra arg'`, name: "gh" },
      { runId: "r-1" }
    );
    expect(spawnMock).toHaveBeenCalledWith(
      "gh",
      ["pr", "comment", "123", "--body", "ship it", "extra arg"],
      expect.any(Object)
    );
  });

  it("flags timedOut + kills the child on overshoot", async () => {
    const fakeChild = makeFakeChild({ neverClose: true });
    spawnMock.mockReturnValueOnce(fakeChild);
    const tool = createSkillRunTool(makeRegistry([gh]), { spawnImpl: spawnMock as never });
    const promise = tool.execute({ command: "gh sleep", name: "gh", timeoutMs: 5 }, { runId: "r-1" }) as Promise<{
      readonly timedOut: boolean;
    }>;
    // Advance the timeout — fakeChild will see SIGKILL via .kill, fire close.
    await new Promise((resolve) => setTimeout(resolve, 20));
    fakeChild.fireClose(null, "SIGKILL");
    const out = await promise;
    expect(out.timedOut).toBe(true);
    expect(fakeChild.killed).toBe(true);
  });

  it("survives an EPIPE on the child's stdin (binary exited before consuming stdin) without crashing the parent", async () => {
    // Pre-fix runChild wrote/ended child.stdin with no `error` listener.
    // A binary that exits while the parent is writing closes the pipe and
    // the Writable emits an `error` (EPIPE); EventEmitter's contract is to
    // THROW when an `error` event has no listener, taking down the parent.
    const fakeChild = makeFakeChild({ exitCode: 0, stdinEpipeOnWrite: true, stdout: "ok\n" });
    spawnMock.mockReturnValueOnce(fakeChild);
    const tool = createSkillRunTool(makeRegistry([gh]), { spawnImpl: spawnMock as never });
    const out = (await tool.execute(
      { command: "gh pr list", name: "gh", stdin: "payload" },
      { runId: "r-1" }
    )) as { readonly exitCode: number | null; readonly stdout: string };
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("ok");
  });
});

interface FakeChildOptions {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number | null;
  readonly neverClose?: boolean;
  /** Emit an `error` (EPIPE) on stdin the moment the parent writes/ends it. */
  readonly stdinEpipeOnWrite?: boolean;
}

interface FakeStdin extends EventEmitter {
  write(payload: string): void;
  end(): void;
}

interface FakeChild extends EventEmitter {
  readonly stdout: EventEmitter;
  readonly stderr: EventEmitter;
  readonly stdin: FakeStdin;
  kill(signal?: string): boolean;
  fireClose(code: number | null, signal?: string): void;
  killed: boolean;
}

function makeFakeChild(options: FakeChildOptions): FakeChild {
  const emitter = new EventEmitter() as FakeChild;
  emitter.stdout = new EventEmitter();
  emitter.stderr = new EventEmitter();
  const stdin = new EventEmitter() as FakeStdin;
  const epipe = () => {
    if (options.stdinEpipeOnWrite) {
      stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    }
  };
  stdin.write = () => epipe();
  stdin.end = () => epipe();
  emitter.stdin = stdin;
  emitter.killed = false;
  emitter.kill = (_signal?: string) => {
    emitter.killed = true;
    return true;
  };
  emitter.fireClose = (code, signal) => {
    emitter.emit("close", code, signal);
  };

  // Defer the synthetic output + close so the caller can subscribe.
  setImmediate(() => {
    if (options.stdout) {
      emitter.stdout.emit("data", Buffer.from(options.stdout, "utf8"));
    }
    if (options.stderr) {
      emitter.stderr.emit("data", Buffer.from(options.stderr, "utf8"));
    }
    if (!options.neverClose) {
      emitter.emit("close", options.exitCode ?? 0, null);
    }
  });

  return emitter;
}
