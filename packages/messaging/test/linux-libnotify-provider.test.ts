import { describe, expect, it } from "vitest";

import {
  LinuxLibnotifyProvider,
  MessagingProviderError,
  buildNotifySendArgv,
  type NotifySendRunner
} from "../src/index.js";

function fakeRunner(): { runner: NotifySendRunner; calls: readonly string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runner: async (args: readonly string[]) => {
      calls.push([...args]);
      return { exitCode: 0, stderr: "" };
    }
  };
}

describe("LinuxLibnotifyProvider (goal 093)", () => {
  it("buildNotifySendArgv folds title + subtitle into the summary slot", () => {
    expect(buildNotifySendArgv({
      appName: "libnotify",
      urgency: "normal",
      title: "Muse",
      subtitle: "@stark",
      body: "meeting in 5"
    })).toEqual([
      "--app-name", "libnotify",
      "--urgency", "normal",
      "Muse — @stark",
      "meeting in 5"
    ]);

    // Empty subtitle keeps just the title.
    expect(buildNotifySendArgv({
      appName: "libnotify", urgency: "critical", title: "Muse", subtitle: "", body: "x"
    })).toContain("Muse");
    expect(buildNotifySendArgv({
      appName: "libnotify", urgency: "critical", title: "Muse", subtitle: "", body: "x"
    })).not.toContain("Muse — ");
  });

  it("fires notify-send with the expected argv shape via injected runner", async () => {
    const { runner, calls } = fakeRunner();
    const provider = new LinuxLibnotifyProvider({ runner });
    const receipt = await provider.send({ destination: "@stark", text: "deploy done" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "--app-name", "libnotify",
      "--urgency", "normal",
      "Muse — @stark",
      "deploy done"
    ]);
    expect(receipt.providerId).toBe("libnotify");
    expect(receipt.messageId).toMatch(/^libnotify-\d+$/);
  });

  it("respects custom title + urgency", async () => {
    const { runner, calls } = fakeRunner();
    const provider = new LinuxLibnotifyProvider({
      runner,
      title: "JARVIS",
      urgency: "critical"
    });
    await provider.send({ destination: "@stark", text: "incident" });
    expect(calls[0]).toEqual([
      "--app-name", "libnotify",
      "--urgency", "critical",
      "JARVIS — @stark",
      "incident"
    ]);
  });

  it("throws UPSTREAM_FAILED on non-linux without an injected runner", () => {
    // We mock through process.platform indirectly by relying on the
    // fact that the runner injection bypasses the guard. So testing
    // the negative case: NO runner injected → constructor's
    // platform() check runs against the real OS. On macOS / CI this
    // host hits the guard.
    if (process.platform !== "linux") {
      expect(() => new LinuxLibnotifyProvider({})).toThrow(MessagingProviderError);
    } else {
      // On Linux the no-runner path is actually fine; provider will
      // try to spawn notify-send, which is acceptable.
      expect(() => new LinuxLibnotifyProvider({})).not.toThrow();
    }
  });

  it("surfaces a non-zero exit as a clear MessagingProviderError", async () => {
    const failing: NotifySendRunner = async () => ({ exitCode: 1, stderr: "no display" });
    const provider = new LinuxLibnotifyProvider({ runner: failing });
    await expect(provider.send({ destination: "@stark", text: "x" })).rejects.toThrow(MessagingProviderError);
  });
});
