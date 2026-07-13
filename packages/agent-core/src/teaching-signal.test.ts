import { describe, expect, it } from "vitest";

import { detectCorrections, isRedirectTurn, isTeachingTurn } from "./correction-distiller.js";
import { TEACHING_SIGNAL_GOLDEN, TEACHING_SIGNAL_HELD_OUT } from "./teaching-signal-golden.js";

const exchange = (turn: string) =>
  [
    { content: "질문", role: "user" as const },
    { content: "답변입니다.", role: "assistant" as const },
    { content: turn, role: "user" as const }
  ] as const;

const fires = (turn: string) => detectCorrections(exchange(turn), { maxExchanges: 1 }).length > 0;

describe("teaching-signal detection — the funnel every learning surface eats from", () => {
  // Graded as a set, not case-by-case: this detector's RECALL is a hard ceiling on
  // the whole self-improving loop (distill, credit, decay are all fed by it and
  // nothing else). Before the redirect class existed it recalled 3 of 15 — 80% of
  // what the user taught was discarded in silence, and no test noticed, because
  // every test only asserted the cases it already caught.
  it.each(TEACHING_SIGNAL_GOLDEN.map((c) => [c.turn, c.teaches, c.note] as const))(
    "%s → teaches=%s (%s)",
    (turn, teaches) => {
      expect(fires(turn)).toBe(teaches);
    }
  );

  it("recalls every teaching signal in the golden set", () => {
    const missed = TEACHING_SIGNAL_GOLDEN.filter((c) => c.teaches && !fires(c.turn));
    expect(missed.map((c) => c.turn)).toEqual([]);
  });

  it("writes no rule from a turn that teaches nothing", () => {
    // A false positive is not free: it becomes a candidate strategy, and a junk
    // rule injected into every future prompt is worse than no rule at all.
    const junk = TEACHING_SIGNAL_GOLDEN.filter((c) => !c.teaches && fires(c.turn));
    expect(junk.map((c) => c.turn)).toEqual([]);
  });
});

describe("teaching-signal detection — held-out (the patterns were never tuned to these)", () => {
  // A set you tune to is a set you overfit. These turns were written to attack the
  // lexicon AFTER it scored 16/16 on the golden set, and on their first run they
  // exposed 4 false positives and 2 false negatives. Keep them adversarial: when
  // this file changes, add NEW held-out cases rather than only re-running these.
  it.each(TEACHING_SIGNAL_HELD_OUT.map((c) => [c.turn, c.teaches, c.note] as const))(
    "%s → teaches=%s (%s)",
    (turn, teaches) => {
      expect(fires(turn)).toBe(teaches);
    }
  );
});

describe("redirect vs. correction", () => {
  it("a redirect never declares an error — it restates the form", () => {
    expect(isRedirectTurn("표로 정리해줘")).toBe(true);
    expect(isRedirectTurn("아니야, 틀렸어")).toBe(false);
    expect(isTeachingTurn("아니야, 틀렸어")).toBe(true);
  });

  it("distinguishes a directive about the ANSWER from one about the WORLD", () => {
    // The pair that a regex can only just handle, and the reason the LLM gate
    // downstream exists: same negated imperative, opposite meaning.
    expect(isTeachingTurn("앞으로 이모지 쓰지 마")).toBe(true);
    expect(isTeachingTurn("숙제 하지 마")).toBe(false);
  });

  it("needs an assistant answer to redirect — a first turn teaches nothing", () => {
    const firstTurn = [{ content: "더 짧게 요약해줘", role: "user" as const }];
    expect(detectCorrections(firstTurn, { maxExchanges: 1 })).toEqual([]);
  });

  it("a standing marker is only a directive when an answering verb follows it", () => {
    expect(isTeachingTurn("앞으로는 링크도 같이 줘")).toBe(true);
    expect(isTeachingTurn("항상 이런 식이야?")).toBe(false);
  });
});
