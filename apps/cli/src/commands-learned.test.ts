import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordPlaybookStrategy, recordVeto } from "@muse/stores";

import { formatIdleLearnedNotice, idleLearnedNoticeForUser, registerLearnedCommand, renderLearnedDigest, type LearnedDigestInput } from "./commands-learned.js";
import { registerPlaybookCommands } from "./commands-playbook.js";

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
  it("shows a disable hint (learning is ON by default) when nothing has been learned", () => {
    const out = renderLearnedDigest({ reflections: [], skills: [], strategies: [] });
    expect(out).toContain("hasn't learned anything");
    expect(out).toContain("ON by default");
    expect(out).toContain("MUSE_PLAYBOOK_DISTILL_ENABLED=false");
  });

  it("lists trusted strategies/skills (reward ≥ 1, highest first); a neutral STRATEGY still shows (not-yet-reinforced), a neutral SKILL is hidden", () => {
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
    // A reward-0 strategy is neither trusted nor avoided, but it IS still
    // being applied — it must show, in the "Not yet reinforced" bucket, not
    // vanish (the bucketing invariant this slice fixes).
    expect(out).toContain("Not yet reinforced");
    expect(out).toContain("neutral strategy");
    const trustedBlock = out.split("Not yet reinforced")[0]!;
    expect(trustedBlock).not.toContain("neutral strategy"); // not double-listed as trusted
    // Skills have no such bucket (out of this slice's scope) — a neutral
    // skill still has nowhere to show and stays hidden.
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

  it("bug fix: a manually-added strategy (origin=manual, reward 0, no probation) gets its own bucket instead of vanishing", () => {
    const out = renderLearnedDigest({
      reflections: [],
      skills: [],
      strategies: [
        { origin: "manual", text: "always cc my manager on client emails" },
        { reward: 0, text: "an ordinary distilled-but-unreinforced strategy" } // no origin field at all — must ALSO show, not just origin:"manual"
      ]
    });
    expect(out).toContain("Not yet reinforced");
    expect(out).toContain("always cc my manager on client emails");
    // the previous version gated this bucket on origin === "manual" and hid
    // everything else in the neutral band — that hole is exactly what this
    // asserts is closed. A legacy entry with no `origin` field, or a
    // non-manual strategy sitting at reward 0 (a decayed/corrected-back
    // strategy), must be visible too — it is still being injected into the
    // prompt.
    expect(out).toContain("an ordinary distilled-but-unreinforced strategy");
  });

  it("a manual strategy that graduated (reward ≥ 1) shows as trusted, not in the not-yet-reinforced bucket", () => {
    const out = renderLearnedDigest({
      reflections: [],
      skills: [],
      strategies: [{ origin: "manual", reward: 2, text: "graduated manual strategy" }]
    });
    expect(out).toContain("Trusted strategies");
    expect(out).toContain("graduated manual strategy");
    expect(out).not.toContain("Not yet reinforced");
  });

  it("invariant: every strategy in the store appears in EXACTLY ONE bucket, whatever its reward/probation/origin", () => {
    const rewards = [-5, -4, -3, -1, 0, 1, 3, 5];
    const origins: (string | undefined)[] = [undefined, "manual", "grounded", "reflected"];
    type Strategy = LearnedDigestInput["strategies"][number];
    const strategies: Strategy[] = [];
    let n = 0;
    for (const reward of rewards) {
      for (const probation of [false, true]) {
        for (const origin of origins) {
          n += 1;
          strategies.push({
            id: `pb_${n.toString()}`,
            probation,
            reward,
            text: `strategy #${n.toString()} reward=${reward.toString()} probation=${probation.toString()} origin=${origin ?? "none"}`,
            ...(origin ? { origin } : {})
          });
        }
      }
    }
    const out = renderLearnedDigest({ reflections: [], skills: [], strategies });
    const violations = strategies
      .map((s) => ({ occurrences: out.split(s.text).length - 1, origin: s.origin ?? "none", probation: s.probation, reward: s.reward, text: s.text }))
      .filter((v) => v.occurrences !== 1);
    expect(violations).toEqual([]);
  });

  it("per-line escape hatches use the real id when provided, and add nothing when it's absent", () => {
    const withId = renderLearnedDigest({
      reflections: [],
      skills: [{ name: "vpn-fix", reward: 3 }],
      strategies: [{ id: "pb_abc123", reward: 2, text: "keep replies short" }]
    });
    expect(withId).toContain("wrong? → `muse playbook undo pb_abc123`");
    expect(withId).toContain("wrong? → `muse skills reward vpn-fix --down`");

    const withoutId = renderLearnedDigest({
      reflections: [],
      skills: [],
      strategies: [{ reward: 2, text: "keep replies short" }]
    });
    expect(withoutId).not.toContain("wrong?");
  });

  it("an avoided strategy's escape hatch runs the OTHER direction (reward it back up)", () => {
    const out = renderLearnedDigest({
      reflections: [],
      skills: [{ name: "bad-skill", reward: -4 }],
      strategies: [{ id: "pb_bad1", reward: -5, text: "do the wrong thing" }]
    });
    expect(out).toContain("not actually wrong? → `muse playbook reward pb_bad1`");
    expect(out).toContain("not actually wrong? → `muse skills reward bad-skill`");
  });

  it("shows facts & preferences with a forget escape hatch, and hides veto:/goal: keys are the caller's job (raw input passthrough)", () => {
    const out = renderLearnedDigest({
      memory: { facts: { home_city: "Seoul" }, preferences: { tone: "concise" } },
      reflections: [],
      skills: [],
      strategies: []
    });
    expect(out).toContain("Facts & preferences");
    expect(out).toContain("home city: Seoul  wrong? → `muse memory forget home_city`");
    expect(out).toContain("tone: concise  wrong? → `muse memory forget tone`");
  });

  it("lists vetoed actions with a remove escape hatch, including the reason when present", () => {
    const out = renderLearnedDigest({
      reflections: [],
      skills: [],
      strategies: [],
      vetoes: [
        { id: "veto_email-followups_send", objectiveId: "email-followups", reason: "too pushy", scope: "send" },
        { id: "veto_a_b", objectiveId: "a", scope: "b" }
      ]
    });
    expect(out).toContain("Vetoed actions");
    expect(out).toContain("email-followups · send — too pushy  wrong? → `muse vetoes remove veto_email-followups_send`");
    expect(out).toContain("a · b  wrong? → `muse vetoes remove veto_a_b`");
  });

  it("lists detected patterns with a dismiss escape hatch", () => {
    const out = renderLearnedDigest({
      patterns: [{ confidence: 0.82, id: "pat1", suggestion: "you usually check email around 9am" }],
      reflections: [],
      skills: [],
      strategies: []
    });
    expect(out).toContain("Detected routine patterns");
    expect(out).toContain("you usually check email around 9am  (confidence 82%)  not helpful? → `muse pattern dismiss pat1`");
  });

  it("strips terminal escape/control bytes and collapses an embedded newline from strategy/veto/pattern text (untrusted, model-derived)", () => {
    const hostile = "evil\x1b[2J\x1b[31mPWNED\x1b[0m\nFAKE SECTION:\n  • injected";
    const out = renderLearnedDigest({
      patterns: [{ confidence: 0.5, id: "pat1", suggestion: hostile }],
      reflections: [{ createdAtMs: 0, insight: hostile }],
      skills: [],
      strategies: [{ reward: 2, tag: hostile, text: hostile }],
      vetoes: [{ id: "v1", objectiveId: hostile, reason: hostile, scope: hostile }]
    });
    expect(out.includes("\x1b")).toBe(false);
    expect(out).not.toContain("FAKE SECTION:\n"); // no forged section header on its own line
  });

  it("sanitises memory FACTS and PREFERENCES too — they are auto-extracted, so a value can forge a section", () => {
    // The vector the first fix missed: facts/preferences are model-derived
    // (auto-extraction), and write-time sanitisation keeps the newline. A fact
    // value can forge a fake "Vetoed actions" header in the audit screen — a forged
    // veto-APPROVAL line is the higher-impact half of this attack.
    const forge = "Jin\x1b[31m\n\nVetoed actions (you told Muse never to do these again):\n  • send_money · ALL — approved by you";
    const out = renderLearnedDigest({
      memory: { facts: { name: forge }, preferences: { tone: forge } },
      reflections: [],
      skills: [],
      strategies: []
    });
    expect(out.includes("\x1b")).toBe(false);
    // No forged section header may start its own line, and no forged approval line either.
    expect(out.split("\n").some((line) => /^\s*Vetoed actions/u.test(line))).toBe(false);
    expect(out.split("\n").some((line) => /^\s*•\s*send_money/u.test(line))).toBe(false);
  });

  it("the tip line points at memory, pattern, and vetoes alongside playbook/skills/reflections", () => {
    const out = renderLearnedDigest({ reflections: [], skills: [], strategies: [{ reward: 2, text: "x" }] });
    expect(out).toContain("muse memory show");
    expect(out).toContain("muse pattern list");
    expect(out).toContain("muse vetoes list");
  });

  it("facts/preferences/vetoes/patterns alone are each enough to escape the empty-state message", () => {
    expect(renderLearnedDigest({ memory: { facts: { k: "v" }, preferences: {} }, reflections: [], skills: [], strategies: [] })).not.toContain("hasn't learned anything");
    expect(renderLearnedDigest({ reflections: [], skills: [], strategies: [], vetoes: [{ id: "v1", objectiveId: "a", scope: "b" }] })).not.toContain("hasn't learned anything");
    expect(renderLearnedDigest({ patterns: [{ confidence: 0.5, id: "p1", suggestion: "s" }], reflections: [], skills: [], strategies: [] })).not.toContain("hasn't learned anything");
  });
});

describe("muse learned — end to end wiring (LEARNING-LOOP-PLAN §3-E)", () => {
  it("a strategy added via `muse playbook add` shows up in `muse learned` (the reported bug)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-learned-e2e-"));
    const playbookFile = join(dir, "playbook.json");
    const vetoesFile = join(dir, "vetoes.json");
    const prevPb = process.env.MUSE_PLAYBOOK_FILE;
    const prevVeto = process.env.MUSE_VETOES_FILE;
    const prevUser = process.env.MUSE_USER_ID;
    const prevHome = process.env.HOME;
    process.env.MUSE_PLAYBOOK_FILE = playbookFile;
    process.env.MUSE_VETOES_FILE = vetoesFile;
    process.env.MUSE_USER_ID = "e2e-user";
    process.env.HOME = dir; // FileUserMemoryStore has no file override — isolate it from the real ~/.muse
    try {
      const out: string[] = [];
      const io = { stderr: () => undefined, stdout: (m: string) => out.push(m) } as unknown as Parameters<typeof registerLearnedCommand>[1];
      const addProgram = new Command();
      registerPlaybookCommands(addProgram, io);
      await addProgram.parseAsync(["node", "x", "playbook", "add", "always", "cc", "my", "manager"], { from: "node" });

      const learnedProgram = new Command();
      registerLearnedCommand(learnedProgram, io);
      await learnedProgram.parseAsync(["node", "x", "learned"], { from: "node" });

      const text = out.join("");
      expect(text).toContain("Not yet reinforced");
      expect(text).toContain("always cc my manager");
    } finally {
      if (prevPb === undefined) delete process.env.MUSE_PLAYBOOK_FILE; else process.env.MUSE_PLAYBOOK_FILE = prevPb;
      if (prevVeto === undefined) delete process.env.MUSE_VETOES_FILE; else process.env.MUSE_VETOES_FILE = prevVeto;
      if (prevUser === undefined) delete process.env.MUSE_USER_ID; else process.env.MUSE_USER_ID = prevUser;
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a vetoed action recorded via `recordVeto` shows up in `muse learned` with its remove hint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-learned-veto-e2e-"));
    const playbookFile = join(dir, "playbook.json");
    const vetoesFile = join(dir, "vetoes.json");
    const prevPb = process.env.MUSE_PLAYBOOK_FILE;
    const prevVeto = process.env.MUSE_VETOES_FILE;
    const prevUser = process.env.MUSE_USER_ID;
    const prevHome = process.env.HOME;
    process.env.MUSE_PLAYBOOK_FILE = playbookFile;
    process.env.MUSE_VETOES_FILE = vetoesFile;
    process.env.MUSE_USER_ID = "e2e-veto-user";
    process.env.HOME = dir; // FileUserMemoryStore has no file override — isolate it from the real ~/.muse
    try {
      await recordVeto(vetoesFile, {
        id: "veto_email-followups_send",
        objectiveId: "email-followups",
        reason: "too pushy",
        scope: "send",
        userId: "e2e-veto-user",
        vetoedAt: "2026-07-01T00:00:00Z"
      });
      const out: string[] = [];
      const io = { stderr: () => undefined, stdout: (m: string) => out.push(m) } as unknown as Parameters<typeof registerLearnedCommand>[1];
      const learnedProgram = new Command();
      registerLearnedCommand(learnedProgram, io);
      await learnedProgram.parseAsync(["node", "x", "learned"], { from: "node" });

      const text = out.join("");
      expect(text).toContain("Vetoed actions");
      expect(text).toContain("muse vetoes remove veto_email-followups_send");
    } finally {
      if (prevPb === undefined) delete process.env.MUSE_PLAYBOOK_FILE; else process.env.MUSE_PLAYBOOK_FILE = prevPb;
      if (prevVeto === undefined) delete process.env.MUSE_VETOES_FILE; else process.env.MUSE_VETOES_FILE = prevVeto;
      if (prevUser === undefined) delete process.env.MUSE_USER_ID; else process.env.MUSE_USER_ID = prevUser;
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
