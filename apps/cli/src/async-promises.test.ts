import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { waitForChildProcessResult } from "./async-promises.js";

function fakeChildProcess(): ChildProcess {
  return new EventEmitter() as ChildProcess;
}

describe("waitForChildProcessResult", () => {
  it("resolves only when the child exits with code zero", async () => {
    const child = fakeChildProcess();
    const result = waitForChildProcessResult(child, "player");
    child.emit("close", 0, null);

    await expect(result).resolves.toBeUndefined();
  });

  it("rejects when the child is terminated by a signal", async () => {
    const child = fakeChildProcess();
    const result = waitForChildProcessResult(child, "player");
    child.emit("close", null, "SIGTERM");

    await expect(result).rejects.toThrow("player terminated by SIGTERM");
  });

  it("accepts only a caller-approved signal termination", async () => {
    const child = fakeChildProcess();
    const result = waitForChildProcessResult(child, "rec", undefined, {
      acceptsTerminationSignal: (signal) => signal === "SIGTERM"
    });
    child.emit("close", null, "SIGTERM");

    await expect(result).resolves.toBeUndefined();
  });
});
