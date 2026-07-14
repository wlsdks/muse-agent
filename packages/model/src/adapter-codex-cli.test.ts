import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  buildCodexExecArgs,
  CodexCliProvider,
  codexModelCapabilities,
  flattenCodexPrompt,
  runCodexExecSafe,
  type CodexSpawnLike
} from "./adapter-codex-cli.js";
import { ModelProviderError } from "./provider-base.js";
import type { ModelRequest } from "./index.js";

/**
 * Contract-faithful fake for `codex exec`: pulls the `-o <outfile>` path out of
 * the argv and writes the canned answer there, exactly like the real CLI, so the
 * read-from-file extraction is exercised end-to-end.
 */
function fakeSpawn(opts: { output?: string; stderr?: string; code?: number; error?: Error; hang?: boolean }): {
  spawn: CodexSpawnLike;
  calls: Array<{ cmd: string; args: readonly string[] }>;
} {
  const calls: Array<{ cmd: string; args: readonly string[] }> = [];
  const spawn = ((cmd: string, args: readonly string[]) => {
    calls.push({ args, cmd });
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: EventEmitter & { write: () => void; end: () => void };
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { end: () => undefined, write: () => undefined });
    child.kill = () => {
      queueMicrotask(() => child.emit("close", null));
    };
    if (!opts.hang) {
      queueMicrotask(() => {
        void (async () => {
          if (opts.error) {
            child.emit("error", opts.error);
            return;
          }
          if ((opts.code ?? 0) === 0) {
            const oIdx = args.indexOf("-o");
            const outFile = oIdx >= 0 ? args[oIdx + 1] : undefined;
            if (outFile) await writeFile(outFile, opts.output ?? "");
          }
          if (opts.stderr) child.stderr.emit("data", Buffer.from(opts.stderr));
          child.emit("close", opts.code ?? 0);
        })();
      });
    }
    return child;
  }) as unknown as CodexSpawnLike;
  return { calls, spawn };
}

describe("buildCodexExecArgs — verified-safe invocation", () => {
  it("includes every safety flag with the prompt last", () => {
    const args = buildCodexExecArgs({ cwd: "/tmp/x", model: "gpt-5.1", outFile: "/tmp/x/out.txt", prompt: "hi" });
    expect(args).toEqual([
      "exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only",
      "-C", "/tmp/x", "-o", "/tmp/x/out.txt", "-m", "gpt-5.1", "hi"
    ]);
  });

  it("omits -m for the codex-default sentinel", () => {
    const args = buildCodexExecArgs({ cwd: "/tmp/x", model: "codex-default", outFile: "/tmp/x/out.txt", prompt: "hi" });
    expect(args).not.toContain("-m");
    expect(args[args.length - 1]).toBe("hi");
  });
});

describe("flattenCodexPrompt", () => {
  it("puts system first then labels each turn by role", () => {
    const prompt = flattenCodexPrompt([
      { content: "You are helpful.", role: "system" },
      { content: "Hi", role: "user" },
      { content: "Hello!", role: "assistant" },
      { content: "Thanks", role: "user" }
    ]);
    expect(prompt).toBe("System:\nYou are helpful.\n\nUser:\nHi\n\nAssistant:\nHello!\n\nUser:\nThanks");
  });
});

describe("runCodexExecSafe", () => {
  it("returns the -o file content and parses token usage from stderr", async () => {
    const { calls, spawn } = fakeSpawn({ code: 0, output: "  answer text  \n", stderr: "tokens used: 1,234\n" });
    const result = await runCodexExecSafe("prompt", { spawn, model: "gpt-5.1" });
    expect(result.output).toBe("answer text");
    expect(result.usage).toEqual({ outputTokens: 1234 });
    const args = calls[0]!.args;
    expect(args).toContain("-o");
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-5.1");
  });

  it("throws a NON-retryable ModelProviderError on a non-zero exit (login hint)", async () => {
    const { spawn } = fakeSpawn({ code: 1, stderr: "Error: not logged in" });
    await expect(runCodexExecSafe("p", { spawn })).rejects.toMatchObject({
      name: "ModelProviderError",
      providerId: "codex",
      retryable: false
    });
    await expect(runCodexExecSafe("p", { spawn })).rejects.toThrow(/codex login/u);
  });

  it("throws NON-retryable when the binary cannot spawn", async () => {
    const { spawn } = fakeSpawn({ error: new Error("spawn codex ENOENT") });
    await expect(runCodexExecSafe("p", { spawn })).rejects.toMatchObject({ retryable: false });
  });

  it("aborts NON-retryably when the caller signal fires", async () => {
    const controller = new AbortController();
    const { spawn } = fakeSpawn({ hang: true });
    const promise = runCodexExecSafe("p", { signal: controller.signal, spawn });
    queueMicrotask(() => controller.abort());
    await expect(promise).rejects.toMatchObject({ providerId: "codex", retryable: false });
  });

  it("rejects immediately (non-retryable) for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runCodexExecSafe("p", { signal: controller.signal })).rejects.toMatchObject({ retryable: false });
  });
});

describe("CodexCliProvider", () => {
  const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({
    messages: [{ content: "hi", role: "user" }],
    model: "codex/gpt-5.1",
    ...over
  });

  it("capabilities: cloud, no tool-calling / structured-output / streaming", () => {
    const caps = codexModelCapabilities();
    expect(caps).toMatchObject({ local: false, streaming: false, structuredOutput: false, toolCalling: false, vision: false, cost: "high", latencyProfile: "batch" });
  });

  it("generate() builds the safe argv and extracts the output; ignores request.tools", async () => {
    const { calls, spawn } = fakeSpawn({ code: 0, output: "codex says hi" });
    const provider = new CodexCliProvider({ model: "gpt-5.1", spawn });
    const response = await provider.generate(req({
      tools: [{ description: "d", inputSchema: {}, name: "some_tool", risk: "read" }]
    }));
    expect(response.output).toBe("codex says hi");
    expect(response.toolCalls).toBeUndefined();
    const args = calls[0]!.args;
    for (const flag of ["--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-C", "-o"]) {
      expect(args, flag).toContain(flag);
    }
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-5.1");
  });

  it("stream() yields one text-delta then done", async () => {
    const { spawn } = fakeSpawn({ code: 0, output: "streamed" });
    const provider = new CodexCliProvider({ model: "gpt-5.1", spawn });
    const events = [];
    for await (const event of provider.stream(req())) {
      events.push(event);
    }
    expect(events[0]).toEqual({ text: "streamed", type: "text-delta" });
    expect(events[events.length - 1]!.type).toBe("done");
  });

  it("propagates a non-zero exit as a ModelProviderError", async () => {
    const { spawn } = fakeSpawn({ code: 2, stderr: "boom" });
    const provider = new CodexCliProvider({ model: "gpt-5.1", spawn });
    await expect(provider.generate(req())).rejects.toBeInstanceOf(ModelProviderError);
  });

  it("listModels() reports one codex model", async () => {
    const provider = new CodexCliProvider({ model: "gpt-5.1" });
    const models = await provider.listModels();
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ modelId: "gpt-5.1", providerId: "codex" });
  });
});
