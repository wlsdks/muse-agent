import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activityLogPath, capContentForSummary, lastChatHistoryPath } from "./chat-history.js";

describe("capContentForSummary (chat-history compaction surrogate-cap)", () => {
  it("returns the slice unchanged for a clean BMP boundary cut", () => {
    expect(capContentForSummary("hello world", 5)).toBe("hello");
  });

  it("returns the input unchanged when cap >= length", () => {
    expect(capContentForSummary("short", 10)).toBe("short");
  });

  it("drops a trailing lone high surrogate when the cap cuts an emoji mid-pair", () => {
    const pre = "x".repeat(399);
    const grin = "😀";
    const input = `${pre}${grin}rest`;
    expect(input.length).toBe(405);
    const head = capContentForSummary(input, 400);
    expect(head).toBe(pre);
    expect(head.length).toBe(399);
    for (let i = 0; i < head.length; i += 1) {
      const c = head.charCodeAt(i);
      expect(c >= 0xd800 && c <= 0xdfff, `index ${i.toString()} must not be a surrogate`).toBe(false);
    }
  });

  it("leaves a complete surrogate-pair cut untouched", () => {
    const input = `abc😀xyz`;
    expect(capContentForSummary(input, 5)).toBe(`abc😀`);
  });

  it("handles an empty input", () => {
    expect(capContentForSummary("", 400)).toBe("");
  });
});

describe("lastChatHistoryPath / activityLogPath — empty-HOME fall-through", () => {
  beforeEach(() => {
    vi.stubEnv("HOME", "/u/jinan");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("roots both files under HOME/.muse when HOME is set", () => {
    expect(lastChatHistoryPath()).toBe(join("/u/jinan", ".muse", "last-chat.jsonl"));
    expect(activityLogPath()).toBe(join("/u/jinan", ".muse", "activity.jsonl"));
  });

  it("falls back to os.homedir() when HOME is whitespace-only — does NOT produce a path with leading whitespace or relative '.muse/...' under CWD", () => {
    vi.stubEnv("HOME", "   ");
    const probe = (resolver: () => string): { kind: "ok"; value: string } | { kind: "err"; message: string } => {
      try {
        return { kind: "ok", value: resolver() };
      } catch (cause) {
        return { kind: "err", message: cause instanceof Error ? cause.message : String(cause) };
      }
    };
    const r1 = probe(lastChatHistoryPath);
    const r2 = probe(activityLogPath);
    for (const [tag, r, suffix] of [
      ["lastChatHistoryPath", r1, "last-chat.jsonl"] as const,
      ["activityLogPath", r2, "activity.jsonl"] as const
    ]) {
      if (r.kind === "err") {
        expect(r.message, `${tag} threw — must be the 'Cannot resolve home directory' error, not anything else`).toMatch(/Cannot resolve home directory/u);
        continue;
      }
      const value = r.value.replaceAll("\\", "/");
      expect(value, `${tag} resolved path must NOT start with whitespace`).not.toMatch(/^\s/u);
      expect(value, `${tag} resolved path must NOT be a bare relative .muse/`).not.toMatch(/^\.muse\//u);
      expect(value).toMatch(new RegExp(`/.muse/${suffix.replace(/\./gu, "\\.")}$`, "u"));
    }
  });
});
