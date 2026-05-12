import { describe, expect, it } from "vitest";

import {
  MacosNotificationProvider,
  MessagingProviderError,
  MessagingValidationError,
  type OsascriptRunner
} from "../src/index.js";

function fakeRunner(): { runner: OsascriptRunner; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    runner: async (script: string) => {
      calls.push(script);
      return { exitCode: 0, stderr: "" };
    }
  };
}

describe("MacosNotificationProvider", () => {
  it("fires an osascript with title=Muse, subtitle=destination, body=text", async () => {
    const { runner, calls } = fakeRunner();
    const provider = new MacosNotificationProvider({ runner });
    const receipt = await provider.send({ destination: "@stark", text: "meeting in 5" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('display notification "meeting in 5"');
    expect(calls[0]).toContain('with title "Muse"');
    expect(calls[0]).toContain('subtitle "@stark"');
    expect(receipt.providerId).toBe("macos-notification");
    expect(receipt.destination).toBe("@stark");
    expect(receipt.messageId).toMatch(/^macos-notification-\d+$/);
  });

  it("escapes double quotes and backslashes so the AppleScript stays valid", async () => {
    const { runner, calls } = fakeRunner();
    const provider = new MacosNotificationProvider({ runner });
    await provider.send({ destination: "@stark", text: 'has "quotes" and a \\ backslash' });
    expect(calls[0]).toContain('"has \\"quotes\\" and a \\\\ backslash"');
  });

  it("flattens newlines to a single space (Notification Center collapses them anyway)", async () => {
    const { runner, calls } = fakeRunner();
    const provider = new MacosNotificationProvider({ runner });
    await provider.send({ destination: "@stark", text: "line one\nline two" });
    expect(calls[0]).toContain('"line one line two"');
  });

  it("supports a custom title", async () => {
    const { runner, calls } = fakeRunner();
    const provider = new MacosNotificationProvider({ runner, title: "Jarvis" });
    await provider.send({ destination: "@stark", text: "hi" });
    expect(calls[0]).toContain('with title "Jarvis"');
  });

  it("throws MessagingProviderError when osascript exits non-zero", async () => {
    const runner: OsascriptRunner = async () => ({ exitCode: 1, stderr: "syntax error" });
    const provider = new MacosNotificationProvider({ runner });
    await expect(provider.send({ destination: "@stark", text: "hi" })).rejects.toBeInstanceOf(MessagingProviderError);
  });

  it("rejects empty text via validateOutboundMessage", async () => {
    const { runner } = fakeRunner();
    const provider = new MacosNotificationProvider({ runner });
    await expect(provider.send({ destination: "@stark", text: "" })).rejects.toBeInstanceOf(MessagingValidationError);
  });

  it("describes itself as local with the macos-notification id", () => {
    const { runner } = fakeRunner();
    const provider = new MacosNotificationProvider({ runner });
    const info = provider.describe();
    expect(info.id).toBe("macos-notification");
    expect(info.local).toBe(true);
    expect(info.displayName).toMatch(/macOS notification/i);
  });
});
