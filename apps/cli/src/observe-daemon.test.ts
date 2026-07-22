import { describe, expect, it, vi } from "vitest";

import { startObserveDaemonTimer, type ObserveRunner } from "./observe-daemon.js";

describe("CLI Observe daemon composition", () => {
  it("keeps Observe failures off the unrelated daemon loop and joins shutdown", async () => {
    const failure = new Error("lease conflict");
    const runner: ObserveRunner = {
      shutdown: vi.fn(async () => undefined),
      tick: vi.fn(async () => { throw failure; })
    };
    const onError = vi.fn();
    const daemon = startObserveDaemonTimer(runner, 300_000, onError);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
    await daemon.tick();
    expect(onError).toHaveBeenCalledTimes(2);
    await daemon.stop();
    expect(runner.shutdown).toHaveBeenCalledOnce();
  });
});
