import { describe, expect, it } from "vitest";

import { resolvePlatformCapabilities } from "./platform-capabilities.js";

describe("resolvePlatformCapabilities", () => {
  it("darwin reproduces today's choices exactly", () => {
    expect(resolvePlatformCapabilities("darwin")).toEqual({
      audioPlayer: "afplay",
      daemonAutostart: "launchd",
      os: "darwin",
      osIntegrations: "macos",
      secretsChain: ["env", "keychain", "store"]
    });
  });

  it("win32 gets powershell audio, schtasks autostart, no keychain, no macOS integrations", () => {
    expect(resolvePlatformCapabilities("win32")).toEqual({
      audioPlayer: "powershell",
      daemonAutostart: "schtasks",
      os: "win32",
      osIntegrations: "none",
      secretsChain: ["env", "store"]
    });
  });

  it("linux keeps aplay and has no autostart manager yet", () => {
    expect(resolvePlatformCapabilities("linux")).toEqual({
      audioPlayer: "aplay",
      daemonAutostart: "none",
      os: "linux",
      osIntegrations: "none",
      secretsChain: ["env", "store"]
    });
  });

  it("an unknown platform degrades to no audio player", () => {
    const caps = resolvePlatformCapabilities("freebsd");
    expect(caps.os).toBe("other");
    expect(caps.audioPlayer).toBeNull();
    expect(caps.daemonAutostart).toBe("none");
  });

  it("defaults to process.platform without throwing", () => {
    expect(() => resolvePlatformCapabilities()).not.toThrow();
    if (process.platform === "darwin") {
      expect(resolvePlatformCapabilities().os).toBe("darwin");
    }
  });
});
