import { describe, expect, it } from "vitest";
import { resolveAmbientSourceMode } from "../src/index.js";

describe("resolveAmbientSourceMode", () => {
  it("defaults to file for empty / unknown values", () => {
    expect(resolveAmbientSourceMode(undefined)).toBe("file");
    expect(resolveAmbientSourceMode("   ")).toBe("file");
    expect(resolveAmbientSourceMode("weird")).toBe("file");
  });

  it("accepts macOS source only on darwin", () => {
    expect(resolveAmbientSourceMode("macOS", { platform: "darwin" })).toBe("macos");
    expect(resolveAmbientSourceMode("  MaCOS  ", { platform: "darwin" })).toBe("macos");
    expect(resolveAmbientSourceMode("macos", { platform: "win32" })).toBe("file");
  });

  it("accepts Windows source only when requested and on win32", () => {
    expect(resolveAmbientSourceMode("windows", { platform: "win32", windowsEnabled: true })).toBe("windows");
    expect(resolveAmbientSourceMode("WINDOWS", { platform: "win32", windowsEnabled: true })).toBe("windows");
    expect(resolveAmbientSourceMode("windows", { platform: "darwin", windowsEnabled: true })).toBe("file");
    expect(resolveAmbientSourceMode("windows", { platform: "win32", windowsEnabled: false })).toBe("file");
  });
});
