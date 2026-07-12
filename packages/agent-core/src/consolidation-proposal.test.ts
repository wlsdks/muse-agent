import { describe, expect, it, vi } from "vitest";

import {
  buildConsolidationProposalNotice,
  runConsolidationProposalPass,
  CONSOLIDATION_PROPOSAL_KIND,
  type ConsolidationProposalCandidate
} from "./consolidation-proposal.js";

const NOW = Date.parse("2026-07-12T12:00:00Z");
const NOW_ISO = new Date(NOW).toISOString();
const DAY = 86_400_000;
const daysAgo = (days: number): number => NOW - days * DAY;

const strongCandidate: ConsolidationProposalCandidate = {
  memoryId: "mem-strong",
  summary: "진안은 매주 화요일 저녁 요가 수업에 간다",
  signals: { hits: 5, createdMs: daysAgo(30), lastHitMs: daysAgo(1) }
};

const weakCandidate: ConsolidationProposalCandidate = {
  memoryId: "mem-weak",
  summary: "한 번 언급된 잡담",
  signals: { hits: 1, createdMs: daysAgo(120), lastHitMs: daysAgo(100) }
};

const borderlineCandidate: ConsolidationProposalCandidate = {
  memoryId: "mem-borderline",
  summary: "가끔 언급되는 취향",
  signals: { hits: 2, createdMs: daysAgo(20), lastHitMs: daysAgo(10) }
};

describe("runConsolidationProposalPass — selection + draft published", () => {
  it("publishes a draft proposal only for candidates clearing the threshold", () => {
    const publish = vi.fn();
    const promote = vi.fn();
    const result = runConsolidationProposalPass({
      candidates: [strongCandidate, weakCandidate, borderlineCandidate],
      nowMs: NOW,
      nowIso: NOW_ISO,
      publish,
      promote
    });

    expect(result.published).toBe(1);
    expect(result.proposals).toHaveLength(1);
    expect(publish).toHaveBeenCalledTimes(1);

    const notice = result.proposals[0];
    expect(notice).toBeDefined();
    if (!notice) throw new Error("unreachable");
    expect(notice.kind).toBe(CONSOLIDATION_PROPOSAL_KIND);
    expect(notice.sourceId).toBe(strongCandidate.memoryId);
    expect(notice.text).toContain("승인");
    expect(notice.text).toContain("오래 보관");
    expect(notice.generatedAt).toBe(NOW_ISO);

    // The weak and borderline candidates must never surface a draft.
    expect(publish.mock.calls.some(([n]) => n.sourceId === weakCandidate.memoryId)).toBe(false);
    expect(publish.mock.calls.some(([n]) => n.sourceId === borderlineCandidate.memoryId)).toBe(false);
  });
});

describe("runConsolidationProposalPass — no-auto-write contract", () => {
  it("never calls promote, even when every candidate clears the threshold", () => {
    const allStrong: ConsolidationProposalCandidate[] = [
      strongCandidate,
      { ...strongCandidate, memoryId: "mem-strong-2" },
      { ...strongCandidate, memoryId: "mem-strong-3" }
    ];
    const promote = vi.fn();
    const publish = vi.fn();
    const writtenMemoryIds: string[] = [];
    const trackedPromote = (memoryId: string): void => {
      writtenMemoryIds.push(memoryId);
      promote(memoryId);
    };

    const result = runConsolidationProposalPass({
      candidates: allStrong,
      nowMs: NOW,
      nowIso: NOW_ISO,
      publish,
      promote: trackedPromote
    });

    expect(result.published).toBe(3);
    expect(promote).toHaveBeenCalledTimes(0);
    expect(writtenMemoryIds).toHaveLength(0);
  });
});

describe("runConsolidationProposalPass — empty / all-below-threshold", () => {
  it("no candidates: publishes nothing, calls nothing", () => {
    const publish = vi.fn();
    const promote = vi.fn();
    const result = runConsolidationProposalPass({ candidates: [], nowMs: NOW, nowIso: NOW_ISO, publish, promote });

    expect(result.published).toBe(0);
    expect(result.proposals).toHaveLength(0);
    expect(publish).toHaveBeenCalledTimes(0);
    expect(promote).toHaveBeenCalledTimes(0);
  });

  it("all candidates below threshold: publishes nothing, calls nothing", () => {
    const publish = vi.fn();
    const promote = vi.fn();
    const result = runConsolidationProposalPass({
      candidates: [weakCandidate, borderlineCandidate],
      nowMs: NOW,
      nowIso: NOW_ISO,
      publish,
      promote
    });

    expect(result.published).toBe(0);
    expect(result.proposals).toHaveLength(0);
    expect(publish).toHaveBeenCalledTimes(0);
    expect(promote).toHaveBeenCalledTimes(0);
  });
});

describe("buildConsolidationProposalNotice", () => {
  it("builds a draft notice with the correct kind, sourceId, and confirmation-worded text", () => {
    const notice = buildConsolidationProposalNotice(strongCandidate, NOW_ISO);

    expect(notice.kind).toBe(CONSOLIDATION_PROPOSAL_KIND);
    expect(notice.sourceId).toBe(strongCandidate.memoryId);
    expect(notice.generatedAt).toBe(NOW_ISO);
    expect(notice.text).toContain(strongCandidate.summary);
    expect(notice.text).toContain("승인");
  });
});
