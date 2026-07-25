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
    await vi.waitFor(() => expect(runner.tick).toHaveBeenCalledOnce());
    await daemon.tick();
    expect(onError).toHaveBeenCalledTimes(2);
    await daemon.stop();
    expect(runner.shutdown).toHaveBeenCalledOnce();
  });

  it("joins an in-flight observation before shutdown and refuses ticks after stop", async () => {
    let finishTick!: () => void;
    const tickFinished = new Promise<void>((resolve) => { finishTick = resolve; });
    const events: string[] = [];
    const runner: ObserveRunner = {
      shutdown: vi.fn(async () => { events.push("shutdown"); }),
      tick: vi.fn(async () => {
        events.push("tick-start");
        await tickFinished;
        events.push("tick-end");
        return "sampled" as const;
      })
    };
    const daemon = startObserveDaemonTimer(runner, 300_000, vi.fn());
    await vi.waitFor(() => expect(runner.tick).toHaveBeenCalledOnce());

    const stopping = daemon.stop();
    await Promise.resolve();
    expect(runner.shutdown).not.toHaveBeenCalled();
    finishTick();
    await stopping;

    expect(events).toEqual(["tick-start", "tick-end", "shutdown"]);
    await daemon.tick();
    expect(runner.tick).toHaveBeenCalledOnce();
    await daemon.stop();
    expect(runner.shutdown).toHaveBeenCalledOnce();
  });

  it("makes concurrent stop callers join the same blocked shutdown", async () => {
    let finishShutdown!: () => void;
    const shutdownFinished = new Promise<void>((resolve) => { finishShutdown = resolve; });
    const runner: ObserveRunner = {
      shutdown: vi.fn(async () => { await shutdownFinished; }),
      tick: vi.fn(async () => "ignored" as const)
    };
    const daemon = startObserveDaemonTimer(runner, 300_000, vi.fn());
    await daemon.tick();
    const resolved: string[] = [];

    const first = daemon.stop().then(() => { resolved.push("first"); });
    const second = daemon.stop().then(() => { resolved.push("second"); });
    await vi.waitFor(() => expect(runner.shutdown).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(resolved).toEqual([]);

    finishShutdown();
    await Promise.all([first, second]);
    expect(resolved.sort()).toEqual(["first", "second"]);
    expect(runner.shutdown).toHaveBeenCalledOnce();
  });
});
