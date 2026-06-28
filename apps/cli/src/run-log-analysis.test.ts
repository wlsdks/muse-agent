import { describe, expect, it } from "vitest";

import { analyzeRunLogSignals, isFailureEvent, type RunLogEvent } from "./run-log-analysis.js";

const ungrounded = (message: string): RunLogEvent => ({ grounded: "ungrounded", message, success: true });
const grounded = (message: string): RunLogEvent => ({ grounded: "grounded", message, success: true });
const failed = (message: string): RunLogEvent => ({ grounded: null, message, success: false });
const misgrounded = (message: string): RunLogEvent => ({ answer: "the deadline is March 3", grounded: "misgrounded", message, success: true });
const contested = (message: string): RunLogEvent => ({ answer: "the deadline is March 3", grounded: "contested", message, success: true });

describe("isFailureEvent (what counts as a signal worth turning into work)", () => {
  it("treats an ungrounded answer (the 'I'm not sure' / fabrication-caught outcome) as a failure", () => {
    expect(isFailureEvent(ungrounded("what is my wifi password"))).toBe(true);
  });
  it("treats success:false as a failure", () => {
    expect(isFailureEvent(failed("deploy the app"))).toBe(true);
  });
  it("does NOT treat a grounded, successful answer as a failure", () => {
    expect(isFailureEvent(grounded("what time is it"))).toBe(false);
  });
  it("does NOT treat an unlabeled (grounded:null, success:null) trace as a failure (no signal)", () => {
    expect(isFailureEvent({ grounded: null, message: "hi", success: null })).toBe(false);
  });

  // Actionable-failure gate: an ungrounded answer is only a Muse bug worth fueling the
  // flywheel when confident PERSONAL evidence existed but wasn't grounded in. A general-
  // knowledge question (no relevant note) must NOT pollute the signal as a false failure.
  const ung = (answer: string, retrieval: { source: string; score: number }[]) =>
    ({ answer, grounded: "ungrounded", message: "q", retrieval, success: true }) satisfies RunLogEvent;

  it("does NOT count a general-knowledge ungrounded answer (no confident real note retrieved)", () => {
    expect(isFailureEvent(ung("Paris.", [{ source: "trip.md", score: 0.22 }, { source: "task: ship", score: 1 }]))).toBe(false);
  });
  it("DOES count an ungrounded answer when a CONFIDENT real note (≥0.45) was retrieved but not grounded in", () => {
    expect(isFailureEvent(ung("Your MTU is 1500.", [{ source: "vpn.md", score: 0.62 }]))).toBe(true);
  });
  it("does NOT count an ungrounded answer whose only ≥0.45 sources are SYNTHETIC exact-matches (task:/event:/…)", () => {
    expect(isFailureEvent(ung("Done.", [{ source: "task: x", score: 1 }, { source: "event: y", score: 1 }]))).toBe(false);
  });
  it("misgrounded ALWAYS counts even with weak retrieval (a source WAS matched — GROUNDED≠TRUE)", () => {
    expect(isFailureEvent({ answer: "x", grounded: "misgrounded", message: "q", retrieval: [{ source: "n.md", score: 0.2 }], success: true })).toBe(true);
  });
  it("an OLD trace with no retrieval field still counts (backward compat — unchanged behavior)", () => {
    expect(isFailureEvent({ answer: "x", grounded: "ungrounded", message: "q", success: true })).toBe(true);
  });

  it("does NOT treat an ungrounded EMPTY answer as a failure (a non-answer / dev no-op is not actionable work)", () => {
    expect(isFailureEvent({ answer: "", grounded: "ungrounded", message: "open example.com", success: true })).toBe(false);
    expect(isFailureEvent({ answer: "   ", grounded: "ungrounded", message: "open example.com", success: true })).toBe(false);
  });

  it("DOES treat an ungrounded NON-EMPTY answer as a failure (a real missed attempt)", () => {
    expect(isFailureEvent({ answer: "the page says hello", grounded: "ungrounded", message: "open example.com", success: true })).toBe(true);
  });

  it("still treats a failed run as a failure even with an empty answer (the run errored)", () => {
    expect(isFailureEvent({ answer: "", grounded: null, message: "deploy", success: false })).toBe(true);
  });

  it("treats a misgrounded NON-EMPTY answer (cited a real source that doesn't support the claim) as a failure", () => {
    expect(isFailureEvent(misgrounded("when is the project deadline"))).toBe(true);
  });

  it("does NOT treat a misgrounded EMPTY answer as a failure (no claim to be wrong about)", () => {
    expect(isFailureEvent({ answer: "", grounded: "misgrounded", message: "x", success: true })).toBe(false);
  });

  it("treats a contested NON-EMPTY answer (grounded on sources that disagree) as a failure, clustered under its own kind", () => {
    expect(isFailureEvent(contested("when is the project deadline"))).toBe(true);
    const clusters = analyzeRunLogSignals([
      contested("when is the project deadline"),
      contested("when is the project deadline?"),
      grounded("what time is it"),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({ count: 2, kind: "contested" });
  });
});

describe("analyzeRunLogSignals (failing traces → ranked candidate work)", () => {
  it("clusters the SAME failing question and counts it (a recurring failure is the work)", () => {
    const events = [
      ungrounded("What is my wifi password?"),
      ungrounded("what is my wifi password"),
      ungrounded("What is my WiFi password?"),
      grounded("what time is it"),
    ];
    const clusters = analyzeRunLogSignals(events);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({ count: 3, kind: "ungrounded" });
    expect(clusters[0]!.topic).toContain("wifi password");
  });

  it("ranks the most frequent failure first", () => {
    const events = [
      ...Array.from({ length: 2 }, () => failed("run the migration")),
      ...Array.from({ length: 4 }, () => ungrounded("what is my rent")),
    ];
    const clusters = analyzeRunLogSignals(events);
    expect(clusters.map((c) => c.count)).toEqual([4, 2]);
    expect(clusters[0]).toMatchObject({ kind: "ungrounded" });
    expect(clusters[1]).toMatchObject({ kind: "failed" });
  });

  it("keeps ungrounded and failed of the same topic as DISTINCT clusters (different work)", () => {
    const clusters = analyzeRunLogSignals([ungrounded("sync my calendar"), failed("sync my calendar")]);
    expect(clusters).toHaveLength(2);
    expect(new Set(clusters.map((c) => c.kind))).toEqual(new Set(["ungrounded", "failed"]));
  });

  it("returns nothing when every trace is a grounded success (clean board = no signal-driven work)", () => {
    expect(analyzeRunLogSignals([grounded("a"), grounded("b")])).toEqual([]);
  });

  it("labels a misgrounded cluster with the misgrounded kind, distinct from an ungrounded one on the same topic", () => {
    const clusters = analyzeRunLogSignals([
      misgrounded("when is the deadline"),
      misgrounded("when is the deadline"),
      ungrounded("when is the deadline"),
    ]);
    expect(clusters).toHaveLength(2);
    const mis = clusters.find((c) => c.kind === "misgrounded");
    expect(mis?.count).toBe(2);
    expect(new Set(clusters.map((c) => c.kind))).toEqual(new Set(["misgrounded", "ungrounded"]));
  });
});
