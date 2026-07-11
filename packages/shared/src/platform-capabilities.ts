/**
 * Boot-time platform seam: every OS-dependent choice (audio player, secrets
 * chain, daemon autostart, OS-integration availability) resolves through this
 * one pure function so win32 branches are unit-testable from any OS and
 * `muse doctor` can report the posture honestly.
 */

export type PlatformOs = "darwin" | "win32" | "linux" | "other";

export interface PlatformCapabilities {
  readonly os: PlatformOs;
  readonly secretsChain: readonly ("env" | "keychain" | "store")[];
  readonly audioPlayer: "afplay" | "powershell" | "aplay" | null;
  readonly daemonAutostart: "launchd" | "schtasks" | "none";
  readonly osIntegrations: "macos" | "none";
}

export function resolvePlatformCapabilities(
  platform: NodeJS.Platform = process.platform
): PlatformCapabilities {
  if (platform === "darwin") {
    return {
      audioPlayer: "afplay",
      daemonAutostart: "launchd",
      os: "darwin",
      osIntegrations: "macos",
      secretsChain: ["env", "keychain", "store"]
    };
  }
  if (platform === "win32") {
    return {
      audioPlayer: "powershell",
      daemonAutostart: "schtasks",
      os: "win32",
      osIntegrations: "none",
      secretsChain: ["env", "store"]
    };
  }
  if (platform === "linux") {
    return {
      audioPlayer: "aplay",
      daemonAutostart: "none",
      os: "linux",
      osIntegrations: "none",
      secretsChain: ["env", "store"]
    };
  }
  return {
    audioPlayer: null,
    daemonAutostart: "none",
    os: "other",
    osIntegrations: "none",
    secretsChain: ["env", "store"]
  };
}
