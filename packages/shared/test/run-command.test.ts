import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { runCommandWithTimeout } from "../src/run-command.js";

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter & { write: (chunk: unknown) => void; end: () => void };
  kill: () => boolean;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), { end: () => undefined, write: () => undefined });
  child.kill = () => true;
  return child;
}

describe("runCommandWithTimeout stream limits", () => {
  it("reports truncation instead of making a partial stdout capture look complete", async () => {
    const child = makeFakeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof spawn;
    const pending = runCommandWithTimeout({ command: "echo", maxStdoutBytes: 3, spawnImpl, timeoutMs: 5_000 });

    child.stdout.emit("data", Buffer.from("abcd"));
    child.emit("close", 0, null);

    await expect(pending).resolves.toMatchObject({ stdout: "abc", truncated: true });
  });

  it("cleans up a live abort listener after an asynchronous spawn error without a second rejection", async () => {
    const child = makeFakeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof spawn;
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const pending = runCommandWithTimeout({
      abortSignal: controller.signal,
      command: "missing-runner",
      spawnImpl,
      timeoutMs: 5_000
    });

    child.emit("error", new Error("spawn missing-runner ENOENT"));

    await expect(pending).rejects.toThrow("ENOENT");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(remove).toHaveBeenCalledOnce();
  });
});
