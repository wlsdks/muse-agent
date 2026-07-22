import { describe, expect, it, vi } from "vitest";

const execFileSync = vi.hoisted(() => vi.fn(() => "nominal\n"));

vi.mock("node:child_process", () => ({ execFileSync }));

import {
  MAC_THERMAL_JXA_SCRIPT,
  readMacThermalState
} from "../src/system-resource-observation.js";

describe("macOS thermal production probe", () => {
  it("uses execFileSync without a shell and captures bounded stderr", () => {
    expect(readMacThermalState(undefined, "darwin")).toBe("nominal");
    expect(execFileSync).toHaveBeenCalledWith(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", MAC_THERMAL_JXA_SCRIPT],
      {
        encoding: "utf8",
        maxBuffer: 1_024,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 250
      }
    );
  });
});
