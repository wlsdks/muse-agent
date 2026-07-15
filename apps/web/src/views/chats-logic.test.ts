import { describe, expect, it } from "vitest";

import { originBadgeLabelKey, relativeAgo } from "./chats-logic.js";

import type { Translate } from "../i18n/index.js";

const identityT = ((key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}:${JSON.stringify(vars)}` : key) as unknown as Translate;

describe("originBadgeLabelKey", () => {
  it("maps every known origin to its own badge key", () => {
    expect(originBadgeLabelKey("cli")).toBe("chats.origin.cli");
    expect(originBadgeLabelKey("web")).toBe("chats.origin.web");
    expect(originBadgeLabelKey("telegram")).toBe("chats.origin.telegram");
    expect(originBadgeLabelKey("matrix")).toBe("chats.origin.matrix");
  });

  it("falls back to 'other' for an unrecognized origin — never echoes the raw string as a key", () => {
    expect(originBadgeLabelKey("slack")).toBe("chats.origin.other");
    expect(originBadgeLabelKey("")).toBe("chats.origin.other");
  });
});

describe("relativeAgo", () => {
  const now = new Date("2026-07-15T12:00:00.000Z").getTime();

  it("within a minute either side reads 'now'", () => {
    expect(relativeAgo(new Date(now - 30_000).toISOString(), identityT, now)).toBe("rel.now");
  });

  it("minutes ago", () => {
    expect(relativeAgo(new Date(now - 5 * 60_000).toISOString(), identityT, now)).toBe('rel.agoMinutes:{"n":5}');
  });

  it("hours ago", () => {
    expect(relativeAgo(new Date(now - 3 * 60 * 60_000).toISOString(), identityT, now)).toBe('rel.agoHours:{"n":3}');
  });

  it("days ago", () => {
    expect(relativeAgo(new Date(now - 2 * 24 * 60 * 60_000).toISOString(), identityT, now)).toBe('rel.agoDays:{"n":2}');
  });

  it("a malformed iso returns an empty string, never NaN in the label", () => {
    expect(relativeAgo("not-a-date", identityT, now)).toBe("");
  });
});
