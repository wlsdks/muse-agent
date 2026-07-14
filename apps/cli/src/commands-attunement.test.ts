import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeTasks, type PersistedTask } from "@muse/stores";
import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { registerAttunementCommands, type AttunementCommandDeps } from "./commands-attunement.js";
import type { McpToolCaller } from "./attunement-mcp-resource.js";

interface Fixture {
  readonly attunementFile: string;
  readonly notesDir: string;
  readonly taskFile: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "muse-attunement-cli-"));
  const notesDir = join(root, "notes");
  mkdirSync(notesDir);
  return { attunementFile: join(root, "attunement.json"), notesDir, taskFile: join(root, "tasks.json") };
}

async function run(fixture: Fixture, args: string[], deps?: AttunementCommandDeps): Promise<{ readonly exitCode: number | undefined; readonly stderr: string; readonly stdout: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previous = {
    MUSE_ATTUNEMENT_FILE: process.env.MUSE_ATTUNEMENT_FILE,
    MUSE_NOTES_DIR: process.env.MUSE_NOTES_DIR,
    MUSE_TASKS_FILE: process.env.MUSE_TASKS_FILE
  };
  process.env.MUSE_ATTUNEMENT_FILE = fixture.attunementFile;
  process.env.MUSE_NOTES_DIR = fixture.notesDir;
  process.env.MUSE_TASKS_FILE = fixture.taskFile;
  let exitCode: number | undefined;
  try {
    const program = new Command();
    program.exitOverride();
    registerAttunementCommands(program, { stderr: (line: string) => stderr.push(line), stdout: (line: string) => stdout.push(line) }, deps ?? {});
    await program.parseAsync(["node", "muse", ...args]);
  } catch (cause) {
    exitCode = (cause as { exitCode?: number }).exitCode ?? 1;
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return { exitCode, stderr: stderr.join(""), stdout: stdout.join("") };
}

function threadId(output: string): string {
  const id = output.match(/thread_[\w-]+/u)?.[0];
  expect(id).toBeTruthy();
  return id!;
}

const TASK: PersistedTask = {
  createdAt: "2026-07-14T00:00:00.000Z",
  id: "task_8f046e20-cb0b-4c75-82ac-9fc357cfe9b1",
  notes: "Ask Jamie which flowers they prefer.",
  status: "open",
  title: "Send the flower options"
};

describe("muse thread / continue — Personal Continuity", () => {
  it("requires an explicit equal life/work kind — there is no hidden default", async () => {
    const f = fixture();
    const missing = await run(f, ["thread", "start", "Plan", "the", "week"]);
    expect(missing.exitCode).toBe(1);

    const life = await run(f, ["thread", "start", "Plan", "a", "birthday", "--kind", "life"]);
    const work = await run(f, ["thread", "start", "Prepare", "the", "launch", "--kind", "work"]);
    expect(life.stdout).toContain("Started life thread");
    expect(work.stdout).toContain("Started work thread");
    expect((await run(f, ["thread", "list"])).stdout).toContain("[life]");
    expect((await run(f, ["thread", "list"])).stdout).toContain("[work]");
  });

  it("links canonical local sources, opens a grounded pack, and applies outcome without a model", async () => {
    const f = fixture();
    await writeTasks(f.taskFile, [TASK]);
    writeFileSync(join(f.notesDir, "birthday.md"), "# Birthday ideas\nJamie likes a small garden dinner.\n", "utf8");
    const started = await run(f, ["thread", "start", "Plan", "a", "birthday", "--kind", "life"]);
    const id = threadId(started.stdout);

    // Task prefix is accepted at the CLI boundary, but status/pack output uses
    // the canonical full ID persisted by the store.
    expect((await run(f, ["thread", "link", id, "task", TASK.id.slice(0, 13), "--role", "next-step"])).stdout)
      .toContain(TASK.id);
    expect((await run(f, ["thread", "link", id, "note", "birthday.md", "--role", "context"])).stdout)
      .toContain("note:birthday.md");

    const continued = await run(f, ["continue", id]);
    expect(continued.exitCode).toBeUndefined();
    expect(continued.stdout).toContain("Plan a birthday [life]");
    expect(continued.stdout).toContain(`[task:${TASK.id}] Send the flower options`);
    expect(continued.stdout).toContain("Birthday ideas");
    const deliveryId = continued.stdout.match(/Delivery: (delivery_[\w-]+)/u)?.[1];
    expect(deliveryId).toBeTruthy();

    const outcome = await run(f, ["thread", "outcome", deliveryId!, "ignored"]);
    expect(outcome.stdout).toContain("Recorded ignored");
    const next = await run(f, ["thread", "continue", id]);
    expect(next.stdout).toContain("Previous pack: ignored");
  });

  it("an OPEN task linked as context (not next-step) names the gap + the exact fix, not a misleading 'no task linked' (dogfood)", async () => {
    const f = fixture();
    await writeTasks(f.taskFile, [TASK]);
    const started = await run(f, ["thread", "start", "Ship", "the", "migration", "--kind", "work"]);
    const id = threadId(started.stdout);
    await run(f, ["thread", "link", id, "task", TASK.id.slice(0, 13), "--role", "context"]);

    const continued = await run(f, ["continue", id]);
    // The old copy claimed "no open local task is linked" even though one is —
    // the accurate message names the LINKED task and the role change that sets it.
    // Assert the full next-step line (the task id also appears in the evidence
    // list, so a substring-only check wouldn't guard the contextTask branch).
    expect(continued.stdout).not.toContain("no open local task is linked");
    expect(continued.stdout).toContain(`Next step: none set — task ${TASK.id} is linked as context; re-link it with \`--role next-step\``);
  });

  it("fails closed rather than choosing a thread or escaping the notes vault", async () => {
    const f = fixture();
    const started = await run(f, ["thread", "start", "Keep", "a", "secret", "--kind", "life"]);
    const id = threadId(started.stdout);
    expect((await run(f, ["continue"])).stderr).toContain("thread id is required outside an interactive terminal");
    expect((await run(f, ["thread", "link", id, "note", "../secret.md", "--role", "context"])).stderr).toContain("must not contain '..'");

    const outside = join(tmpdir(), `muse-attunement-outside-${Date.now().toString()}.md`);
    writeFileSync(outside, "not in this vault", "utf8");
    symlinkSync(outside, join(f.notesDir, "escaped.md"));
    const escaped = await run(f, ["thread", "link", id, "note", "escaped.md", "--role", "context"]);
    expect(escaped.stderr).toContain("escapes the local notes vault");
  });
});

const CANNED_ISSUE = { body: "Concurrent renders drop updates.", number: 7, state: "open", title: "Fix the render loop" };

function githubFakeCaller(reachable = true): McpToolCaller {
  return async (server, tool, args) => {
    if (!reachable) throw new Error("ECONNREFUSED");
    if (server === "github" && tool === "get_issue" && args["owner"] === "facebook" && args["repo"] === "react" && args["issue_number"] === 7) {
      return CANNED_ISSUE;
    }
    throw new Error("resource not found");
  };
}

describe("muse thread — external MCP resource links", () => {
  it("links a known github resource with the canonical id and shows it as evidence; rejects unknown + next-step", async () => {
    const f = fixture();
    const deps: AttunementCommandDeps = { mcpResourceCaller: githubFakeCaller() };
    const started = await run(f, ["thread", "start", "Ship", "the", "adapter", "--kind", "work"], deps);
    const id = threadId(started.stdout);

    const linked = await run(f, ["thread", "link", id, "resource", "github/facebook/react/issues/7", "--role", "context"], deps);
    expect(linked.stdout).toContain("mcp:github:resource:facebook/react/issues/7");

    // Unknown resource ⇒ fail-closed, no link.
    const unknown = await run(f, ["thread", "link", id, "resource", "github/facebook/react/issues/999", "--role", "context"], deps);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("could not read resource");

    // A resource can never be a next-step.
    const asNext = await run(f, ["thread", "link", id, "resource", "github/facebook/react/issues/7", "--role", "next-step"], deps);
    expect(asNext.exitCode).toBe(1);
    expect(asNext.stderr).toContain("context-only");

    const continued = await run(f, ["continue", id], deps);
    expect(continued.stdout).toContain("[resource:facebook/react/issues/7] Fix the render loop");
    expect(continued.stdout).toContain("Concurrent renders drop updates.");
  });

  it("marks a resource unavailable when the MCP server is unreachable — no fabricated title", async () => {
    const f = fixture();
    // Link while reachable, then resolve while the server is down.
    const started = await run(f, ["thread", "start", "Ship", "the", "adapter", "--kind", "work"], { mcpResourceCaller: githubFakeCaller(true) });
    const id = threadId(started.stdout);
    await run(f, ["thread", "link", id, "resource", "github/facebook/react/issues/7", "--role", "context"], { mcpResourceCaller: githubFakeCaller(true) });

    const continued = await run(f, ["continue", id], { mcpResourceCaller: githubFakeCaller(false) });
    expect(continued.stdout).toContain("[resource:facebook/react/issues/7] unavailable");
    expect(continued.stdout).not.toContain("Fix the render loop");
  });

  it("fails closed with 'connect the MCP server first' when no MCP runtime is wired", async () => {
    const f = fixture();
    const deps: AttunementCommandDeps = { mcpResourceCaller: undefined };
    const started = await run(f, ["thread", "start", "Ship", "the", "adapter", "--kind", "work"], deps);
    const id = threadId(started.stdout);
    const linked = await run(f, ["thread", "link", id, "resource", "github/facebook/react/issues/7", "--role", "context"], deps);
    expect(linked.exitCode).toBe(1);
    expect(linked.stderr).toContain("connect the MCP server 'github' first");
  });
});

describe("muse thread stats — kill-criterion instrument", () => {
  it("counts outcomes across deliveries and reports the first-20 window", async () => {
    const f = fixture();
    await writeTasks(f.taskFile, [TASK]);
    const started = await run(f, ["thread", "start", "Track", "outcomes", "--kind", "work"]);
    const id = threadId(started.stdout);
    await run(f, ["thread", "link", id, "task", TASK.id.slice(0, 13), "--role", "next-step"]);

    for (const outcome of ["used", "used", "rejected", "ignored"]) {
      const continued = await run(f, ["continue", id]);
      const deliveryId = continued.stdout.match(/Delivery: (delivery_[\w-]+)/u)?.[1];
      expect(deliveryId).toBeTruthy();
      await run(f, ["thread", "outcome", deliveryId!, outcome]);
    }
    // One more pack opened but left without feedback.
    await run(f, ["continue", id]);

    const stats = await run(f, ["thread", "stats", "--json"]);
    const parsed = JSON.parse(stats.stdout) as {
      totalDeliveries: number;
      withOutcome: number;
      outcomes: Record<string, number>;
      firstPacks: { considered: number; used: number; rejected: number };
    };
    expect(parsed.totalDeliveries).toBe(5);
    expect(parsed.withOutcome).toBe(4);
    expect(parsed.outcomes).toEqual({ adjusted: 0, ignored: 1, rejected: 1, used: 2 });
    expect(parsed.firstPacks).toEqual({ considered: 5, rejected: 1, used: 2 });

    const text = await run(f, ["thread", "stats"]);
    expect(text.stdout).toContain("used: 2");
    expect(text.stdout).toContain("rejected 1/5");
  });

  it("reports zeros on empty state without crashing", async () => {
    const f = fixture();
    const stats = await run(f, ["thread", "stats", "--json"]);
    expect(stats.exitCode).toBeUndefined();
    const parsed = JSON.parse(stats.stdout) as { totalDeliveries: number; firstPacks: { considered: number } };
    expect(parsed.totalDeliveries).toBe(0);
    expect(parsed.firstPacks.considered).toBe(0);
  });
});
