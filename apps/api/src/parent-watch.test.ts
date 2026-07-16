import { describe, expect, it } from "vitest";

import { watchParentProcess } from "./parent-watch.js";

describe("watchParentProcess", () => {
  it.each([undefined, "", "0", "1", "-2", "1.5", "1e3", " 42", "9007199254740992"])("rejects malformed parent PID %p without starting a watcher", (pid) => {
    expect(watchParentProcess(pid)).toBeUndefined();
  });

  it("accepts the current process's decimal PID and returns a stoppable watcher", () => {
    const watcher = watchParentProcess(process.pid.toString(), 60_000);

    expect(watcher).toBeDefined();
    clearInterval(watcher);
  });
});
