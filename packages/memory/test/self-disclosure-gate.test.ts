import { describe, expect, it } from "vitest";

import { hasSelfDisclosure } from "../src/memory-auto-extract.js";
import { isEphemeralValue } from "../src/memory-ephemeral-value-guard.js";

describe("self-disclosure pre-filter — the gate that decides whether Muse gets to learn at all", () => {
  // The auto-extractor is the ONE learning surface that is live for a default user,
  // and it was throttled by a content-BLIND 60-second cooldown: one extraction per
  // user per minute, whichever turn happened to land in the window. Measured on a
  // realistic conversation at ordinary typing pace (~15s per turn), that dropped
  // SEVEN of seven memory-bearing turns. "I'm allergic to penicillin" and "lol" had
  // the same chance of surviving, because the gate never looked at either. That is
  // why the user model was empty — not bad extraction, but almost no extraction.
  it.each([
    "I'm allergic to penicillin",
    "I prefer short answers",
    "my brother lives in Berlin",
    "I don't eat meat",
    "remember that I go to the gym on Fridays",
    "always cite the file path",
    "나는 채식주의자야",
    "제가 페니실린 알레르기가 있어요",
    "내 동생은 베를린에 살아",
    "고수는 못 먹어",
    "앞으로는 짧게 답해줘",
    "기억해줘, 나 금요일 오후엔 운동해"
  ])("never rate-limits a turn that discloses something about the user: %s", (turn) => {
    expect(hasSelfDisclosure(turn)).toBe(true);
  });

  it.each([
    "What's the capital of Portugal?",
    "lol",
    "ㅋㅋㅋ",
    "고마워!",
    "what is the default MTU for WireGuard?",
    "그거 언제였지?"
  ])("lets an ordinary turn stay behind the throttle: %s", (turn) => {
    expect(hasSelfDisclosure(turn)).toBe(false);
  });
});

describe("ephemeral-value guard — a relative time is not a durable fact", () => {
  // A user who mentioned being in Lisbon LAST WEEK had `recent_location: "Lisbon"`
  // written as a durable fact. Six months on, recall cites it as where he lives.
  // That is a fabrication carrying a citation, in the one product whose release gate
  // is fabrication = 0. The guard existed; it was Korean-only.
  it.each([
    "he was in Lisbon last week",
    "tried Bun recently",
    "the other day",
    "tonight",
    "currently in Seoul",
    "these days",
    "오늘 저녁 7시",
    "지난 주에 갔던 곳"
  ])("rejects a relative-time value: %s", (value) => {
    expect(isEphemeralValue(value)).toBe(true);
  });

  it.each([
    "vegetarian",
    "Berlin",
    "1990-03-14",
    "8월 5일",
    "allergic to penicillin",
    "Friday afternoons",
    "prefers short answers"
  ])("keeps a durable value — the guard must never clip a real fact: %s", (value) => {
    expect(isEphemeralValue(value)).toBe(false);
  });
});
