import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  readTimingState: vi.fn()
}));

vi.mock("@muse/attunegraph/continuity-durable-projection", () => ({
  createContinuityAttuneGraphProjector: vi.fn()
}));

vi.mock("@muse/attunegraph/continuity-observations", () => ({
  captureContinuityObservation: vi.fn()
}));

vi.mock("@muse/attunegraph/continuity-shadow-returns", () => ({
  captureContinuityShadowReturnObservation: vi.fn(),
  inspectContinuityShadowReturns: mocks.inspect
}));

vi.mock("@muse/attunement", () => ({
  readAttunementState: vi.fn(),
  readTimingState: mocks.readTimingState
}));

import { readConfiguredContinuityShadowReturns } from "./continuity-attunegraph-composition.js";

describe("readConfiguredContinuityShadowReturns", () => {
  const timingFile = "/private/muse/attunement.timing.json";
  const timingState = Object.freeze({ version: 3 });

  beforeEach(() => {
    mocks.inspect.mockReset();
    mocks.readTimingState.mockReset();
    mocks.readTimingState.mockResolvedValue(timingState);
    mocks.inspect.mockResolvedValue(Object.freeze({ limit: 20, rows: [], schemaVersion: 1 }));
  });

  it("reads one timing snapshot and delegates only the configured database plus fixed budget", async () => {
    const result = await readConfiguredContinuityShadowReturns({
      MUSE_ATTUNEGRAPH_DATABASE: "/private/muse/attunegraph.sqlite"
    }, {
      limit: 7,
      now: "2026-07-31T00:00:00.000Z",
      timingFile
    });

    expect(result).toEqual({ limit: 20, rows: [], schemaVersion: 1 });
    expect(mocks.readTimingState).toHaveBeenCalledTimes(1);
    expect(mocks.readTimingState).toHaveBeenCalledWith(timingFile);
    expect(mocks.inspect).toHaveBeenCalledTimes(1);
    expect(mocks.inspect).toHaveBeenCalledWith({
      databasePath: "/private/muse/attunegraph.sqlite",
      limit: 7,
      maxEstimatedTokens: 12_000,
      now: "2026-07-31T00:00:00.000Z",
      timingState
    });
  });

  it("defaults the bound and rejects hostile or structural caller input before a ledger read", async () => {
    await readConfiguredContinuityShadowReturns({}, {
      now: "2026-07-31T00:00:00.000Z",
      timingFile
    });
    expect(mocks.inspect).toHaveBeenCalledWith(expect.objectContaining({ databasePath: undefined, limit: 20 }));

    for (const input of [
      { limit: 0, now: "2026-07-31T00:00:00.000Z", timingFile },
      { limit: 21, now: "2026-07-31T00:00:00.000Z", timingFile },
      { now: "2026-07-31T00:00:00.000Z", receipt: {}, timingFile },
      { now: "2026-07-31T00:00:00.000Z", timingFile, timingState: {} },
      Object.create({ now: "2026-07-31T00:00:00.000Z", timingFile })
    ]) {
      await expect(readConfiguredContinuityShadowReturns({}, input as never)).rejects.toThrow(TypeError);
    }
    expect(mocks.readTimingState).toHaveBeenCalledTimes(1);
  });
});
