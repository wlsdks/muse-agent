import { describe, expect, it, vi } from "vitest";

const macObservation = vi.hoisted(() => ({
  thermal: vi.fn<() => "serious" | undefined>(() => "serious")
}));

vi.mock("@muse/macos/system-resource-observation", () => ({
  readMacAcPower: () => true,
  readMacIdleMs: () => 600_000,
  readMacThermalState: macObservation.thermal
}));

import { readDaemonResourceSnapshot } from "./daemon-resource-admission.js";

describe("readDaemonResourceSnapshot", () => {
  it("carries the production macOS thermal observation into the bounded snapshot", () => {
    expect(readDaemonResourceSnapshot().thermalState).toBe("serious");
    macObservation.thermal.mockReturnValueOnce(undefined);
    expect(readDaemonResourceSnapshot().thermalState).toBe("unavailable");
    expect(macObservation.thermal).toHaveBeenCalledTimes(2);
  });
});
