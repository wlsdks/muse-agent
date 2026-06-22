import { describe, expect, it } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordPlaybookStrategy } from "@muse/stores";

import { formatIdleLearnedNotice, idleLearnedNoticeForUser, renderLearnedDigest } from "./commands-learned.js";

describe("formatIdleLearnedNotice — session-start beat", () => {
  it("is undefined when nothing was learned while idle", () => {
    expect(formatIdleLearnedNotice(0)).toBeUndefined();
  });
  it("names the count (singular/plural) and points at `muse learned`", () => {
    expect(formatIdleLearnedNotice(1)).toMatch(/I learned 1 thing while you were away.*muse learned/);
    expect(formatIdleLearnedNotice(3)).toMatch(/I learned 3 things while you were away/);
  });
});

describe("idleLearnedNoticeForUser — counts probation strategies from the playbook", () => {
  it("returns the beat when probation strategies exist, undefined otherwise", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-idle-notice-"));
    const file = join(dir, "playbook.json");
    try {
      const env = { MUSE_PLAYBOOK_FILE: file } as Record<string, string | undefined>;
      expect(await idleLearnedNoticeForUser("u1", env)).toBeUndefined(); // empty
      await recordPlaybookStrategy(file, { createdAt: "2026-01-01T00:00:00Z", id: "p1", probation: true, text: "x", userId: "u1" });
      await recordPlaybookStrategy(file, { createdAt: "2026-01-01T00:00:00Z", id: "g1", reward: 2, text: "graduated", userId: "u1" });
      const notice = await idleLearnedNoticeForUser("u1", env);
      expect(notice).toMatch(/I learned 1 thing while you were away/); // only the probation one counts
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("renderLearnedDigest", () => {
  it("shows an enable hint when nothing has been learned", () => {
    const out = renderLearnedDigest({ reflections: [], skills: [], strategies: [] });
    expect(out).toContain("hasn't learned anything");
    expect(out).toContain("MUSE_PLAYBOOK_DISTILL_ENABLED");
  });

  it("lists trusted strategies/skills (reward ≥ 1, highest first) and hides neutral ones", () => {
    const out = renderLearnedDigest({
      reflections: [],
      skills: [{ name: "vpn-fix", reward: 3 }, { name: "neutral-skill", reward: 0 }],
      strategies: [
        { reward: 1, tag: "email", text: "keep emails short" },
        { reward: 4, text: "summarise in bullets" },
        { reward: 0, text: "neutral strategy" }
      ]
    });
    expect(out).toContain("Trusted strategies");
    expect(out.indexOf("summarise in bullets")).toBeLessThan(out.indexOf("keep emails short")); // +4 before +1
    expect(out).toContain("keep emails short (email)  ⟨+1⟩");
    expect(out).toContain("vpn-fix  ⟨+3⟩");
    expect(out).not.toContain("neutral strategy"); // reward 0 is neither trusted nor avoided
    expect(out).not.toContain("neutral-skill");
  });

  it("lists avoided strategies and skills (reward ≤ −4) under a distinct heading", () => {
    const out = renderLearnedDigest({
      reflections: [],
      skills: [{ name: "bad-skill", reward: -4 }],
      strategies: [{ reward: -5, text: "do the wrong thing" }]
    });
    expect(out).toContain("Learned to avoid");
    expect(out).toContain("strategy: do the wrong thing  ⟨-5⟩");
    expect(out).toContain("skill: bad-skill  ⟨-4⟩");
  });

  it("shows idle-distilled probation strategies under their own heading, not as trusted/avoided", () => {
    const out = renderLearnedDigest({
      reflections: [],
      skills: [],
      strategies: [
        { probation: true, tag: "scheduling", text: "default ambiguous dates to the next business day" },
        { reward: 2, text: "keep emails under four sentences" } // graduated/trusted, not probation
      ]
    });
    expect(out).toContain("on probation");
    expect(out).toContain("default ambiguous dates to the next business day (scheduling)  ⟨probation⟩");
    // a probation strategy is NOT listed as trusted
    const trustedBlock = out.split("on probation")[0];
    expect(trustedBlock).not.toContain("default ambiguous dates");
    // the graduated one still shows as trusted
    expect(out).toContain("keep emails under four sentences");
  });

  it("annotates a repeatedly-raised probation strategy with 'raised N×' (and omits it for a once-observed one)", () => {
    const out = renderLearnedDigest({
      reflections: [],
      skills: [],
      strategies: [
        { probation: true, text: "use a warmer sign-off in personal emails", timesObserved: 3 },
        { probation: true, text: "default ambiguous dates to the next business day", timesObserved: 1 }
      ]
    });
    expect(out).toContain("use a warmer sign-off in personal emails  ⟨probation⟩  · raised 3×");
    expect(out).toContain("default ambiguous dates to the next business day  ⟨probation⟩");
    expect(out).not.toContain("default ambiguous dates to the next business day  ⟨probation⟩  · raised");
  });

  it("the probation section alone is enough to render (not the empty hint)", () => {
    const out = renderLearnedDigest({ reflections: [], skills: [], strategies: [{ probation: true, text: "x" }] });
    expect(out).toContain("on probation");
    expect(out).not.toContain("hasn't learned anything");
  });

  it("flags a trusted strategy as ↓ fading once it goes unreinforced past the window (B1 §2)", () => {
    const nowMs = Date.parse("2026-06-01T00:00:00Z");
    const day = 86_400_000;
    const out = renderLearnedDigest({
      nowMs,
      reflections: [],
      skills: [],
      strategies: [
        { reward: 3, text: "fresh strategy", lastReinforcedAt: new Date(nowMs - 2 * day).toISOString() },
        { reward: 2, text: "stale strategy", lastReinforcedAt: new Date(nowMs - 40 * day).toISOString() }
      ]
    });
    // the recently-reinforced one shows no fading marker
    const freshLine = out.split("\n").find((l) => l.includes("fresh strategy"))!;
    expect(freshLine).not.toContain("fading");
    // the long-unreinforced one is visibly fading, with the day count
    expect(out).toContain("stale strategy  ⟨+2⟩  ↓ fading (last reinforced 40d ago)");
  });

  it("falls back to 'added' wording when a fading strategy has no reinforce timestamp", () => {
    const nowMs = Date.parse("2026-06-01T00:00:00Z");
    const out = renderLearnedDigest({
      nowMs,
      reflections: [],
      skills: [],
      strategies: [{ reward: 2, text: "legacy strategy", createdAt: new Date(nowMs - 50 * 86_400_000).toISOString() }]
    });
    expect(out).toContain("↓ fading (last added 50d ago)");
  });

  it("shows the WHY under a grounded strategy — the correction that taught it (B1 §4)", () => {
    const out = renderLearnedDigest({
      reflections: [],
      skills: [],
      strategies: [
        { reward: 2, text: "answer in bullet points", origin: "grounded", source: "no, that's not what I meant — give me bullets" },
        { probation: true, text: "default dates to next business day", origin: "grounded", source: "I meant the next WORKING day" }
      ]
    });
    expect(out).toContain('↳ learned from your correction: "no, that\'s not what I meant — give me bullets"');
    // the probation strategy also carries its why
    expect(out).toContain('↳ learned from your correction: "I meant the next WORKING day"');
  });

  it("flags a reflected strategy as synthetic and truncates a long source", () => {
    const long = "x".repeat(200);
    const out = renderLearnedDigest({
      reflections: [],
      skills: [],
      strategies: [
        { reward: 1, text: "reflected guess", origin: "reflected" },
        { reward: 1, text: "grounded long", origin: "grounded", source: long }
      ]
    });
    expect(out).toContain("↳ from a reflection (synthetic — ranked below grounded)");
    expect(out).toContain("…"); // the 200-char source is truncated
    expect(out).not.toContain(long);
  });

  it("renders no why line for a legacy/manual strategy without provenance", () => {
    const out = renderLearnedDigest({ reflections: [], skills: [], strategies: [{ reward: 2, text: "manual strategy" }] });
    expect(out).toContain("manual strategy");
    expect(out).not.toContain("↳");
  });

  it("shows a PAUSED banner when learning is paused (B1 §5) — even with nothing learned", () => {
    const withContent = renderLearnedDigest({ paused: true, reflections: [], skills: [], strategies: [{ reward: 2, text: "a trusted one" }] });
    expect(withContent).toContain("Background learning is PAUSED");
    const empty = renderLearnedDigest({ paused: true, reflections: [], skills: [], strategies: [] });
    expect(empty).toContain("Background learning is PAUSED");
    // not shown when not paused
    expect(renderLearnedDigest({ reflections: [], skills: [], strategies: [{ reward: 2, text: "x" }] })).not.toContain("PAUSED");
  });

  it("shows the most recent reflections, newest first, capped at 5", () => {
    const reflections = Array.from({ length: 7 }, (_unused, i) => ({ createdAtMs: i * 1000, insight: `insight ${i.toString()}` }));
    const out = renderLearnedDigest({ reflections, skills: [], strategies: [] });
    expect(out).toContain("insight 6  [1970-01-01]"); // newest
    expect(out).toContain("insight 2"); // 5th newest (6,5,4,3,2)
    expect(out).not.toContain("insight 1"); // beyond the cap of 5
  });
});
