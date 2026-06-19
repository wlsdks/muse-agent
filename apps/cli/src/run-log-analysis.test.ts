import { describe, expect, it } from "vitest";

import { analyzeRunLogSignals, isFailureEvent, type RunLogEvent } from "./run-log-analysis.js";

const ungrounded = (message: string): RunLogEvent => ({ grounded: "ungrounded", message, success: true });
const grounded = (message: string): RunLogEvent => ({ grounded: "grounded", message, success: true });
const failed = (message: string): RunLogEvent => ({ grounded: null, message, success: false });
const misgrounded = (message: string): RunLogEvent => ({ answer: "the deadline is March 3", grounded: "misgrounded", message, success: true });

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
