import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildCorrectionPairRerankContext,
  buildCorrectionPairShortlist,
  retrieveAndRankNotes,
  resolveCorrectionPairSelection,
  type CorrectionPairShortlistCandidate,
  type RecallRerankExecution,
  type RecallRerankFn,
  type RecallRerankContext,
  type RecallRerankPairHint
} from "./ask-note-retrieval.js";
import { diversifyAskChunks } from "./chunks.js";
import { detectStaleMarker } from "./conflict.js";

type FileEntry = Parameters<typeof retrieveAndRankNotes>[0]["indexFiles"][number];

let dir: string;

async function noteFile(name: string, text: string, embedding: number[]) {
  const path = join(dir, name);
  await writeFile(path, text);
  return { chunks: [{ chunkIndex: 0, embedding, file: path, text }], mtimeMs: 1, path };
}

const embedFn = async (): Promise<number[]> => [1, 0];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ask-note-retrieval-"));
  await mkdir(dir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("buildCorrectionPairShortlist", () => {
  const candidate = (index: number, stale: boolean, identityPrefix = stale ? "stale" : "current"): CorrectionPairShortlistCandidate => ({
    embedding: [1, index / 100, stale ? 0.5 : -0.5],
    identity: { chunkIndex: index, file: `${identityPrefix}-${index.toString()}` },
    queryScore: 0.95 - index / 100,
    stale
  });

  it("bounds a 10x10 comparison matrix and reverses positions without changing identities", () => {
    const axis = (index: number): number[] => Array.from({ length: 10 }, (_value, at) => at === index ? 1 : 0);
    const candidates: CorrectionPairShortlistCandidate[] = [
      ...Array.from({ length: 10 }, (_value, index) => ({
        embedding: axis(index),
        identity: { chunkIndex: index, file: `current-${index.toString()}` },
        queryScore: 0.9 - index * 0.01,
        stale: false
      })),
      ...Array.from({ length: 10 }, (_value, index) => ({
        embedding: axis(index),
        identity: { chunkIndex: index, file: `stale-${index.toString()}` },
        queryScore: 0.9 - index * 0.01,
        stale: true
      }))
    ];

    const original = buildCorrectionPairShortlist(candidates, "original");
    const reversed = buildCorrectionPairShortlist(candidates, "reversed-within-groups");

    expect(original?.diagnostics).toEqual({
      candidateCount: 12,
      compatibilityComparisons: 100,
      proposalCount: 6
    });
    expect(original?.proposals).toHaveLength(6);
    expect(reversed?.proposals).toEqual(original?.proposals);
    const mappedProposals = (shortlist: NonNullable<typeof original>) =>
      buildCorrectionPairRerankContext(shortlist)?.allowedCorrectionPairs.map((pair) => ({
        current: shortlist.windowIndices[pair.current],
        stale: shortlist.windowIndices[pair.stale]
      }));
    expect(mappedProposals(original!)).toEqual(original?.proposals);
    expect(mappedProposals(reversed!)).toEqual(original?.proposals);
    const originalCurrent = original!.windowIndices.filter((index) => index < 10);
    const originalStale = original!.windowIndices.filter((index) => index >= 10);
    expect(originalCurrent).toHaveLength(6);
    expect(originalStale).toHaveLength(6);
    expect(reversed?.windowIndices).toEqual([
      ...[...originalCurrent].reverse(),
      ...[...originalStale].reverse()
    ]);
    expect([...reversed!.windowIndices].sort((left, right) => left - right))
      .toEqual([...original!.windowIndices].sort((left, right) => left - right));

    const currentWindowIndex = originalCurrent[0]!;
    const staleWindowIndex = currentWindowIndex + 10;
    const resolve = (shortlist: NonNullable<typeof original>) => resolveCorrectionPairSelection(
      candidates,
      shortlist,
      {
        httpAttempts: 1,
        order: shortlist.windowIndices.map((_index, localIndex) => localIndex),
        outcome: "success",
        pairHints: [{
          current: shortlist.windowIndices.indexOf(currentWindowIndex),
          stale: shortlist.windowIndices.indexOf(staleWindowIndex)
        }]
      }
    );
    const originalResolution = resolve(original!);
    expect(originalResolution).toEqual(resolve(reversed!));
    expect(originalResolution?.outcome).toBe("pair");
    expect(originalResolution && "verifiedCorrectionPair" in originalResolution
      ? originalResolution.verifiedCorrectionPair
      : undefined).toEqual({
      current: candidates[currentWindowIndex]!.identity,
      stale: candidates[staleWindowIndex]!.identity
    });
    expect(resolveCorrectionPairSelection(candidates, original!, {
      httpAttempts: 1,
      order: original!.windowIndices.map((_index, localIndex) => localIndex),
      outcome: "success"
    })).toEqual({ outcome: "null" });
    expect(resolveCorrectionPairSelection(candidates, original!, {
      httpAttempts: 1,
      order: original!.windowIndices.map((_index, localIndex) => localIndex),
      outcome: "success",
      pairHints: []
    })).toBeUndefined();
    expect(resolveCorrectionPairSelection(candidates, original!, {
      httpAttempts: 1,
      order: original!.windowIndices.map((_index, localIndex) => localIndex),
      outcome: "success",
      pairHints: [{
        current: original!.windowIndices.indexOf(staleWindowIndex),
        stale: original!.windowIndices.indexOf(currentWindowIndex)
      }]
    })).toBeUndefined();
    const firstProposal = original!.proposals[0]!;
    const secondProposal = original!.proposals[1]!;
    expect(resolveCorrectionPairSelection(candidates, original!, {
      httpAttempts: 1,
      order: original!.windowIndices.map((_index, localIndex) => localIndex),
      outcome: "success",
      pairHints: [{
        current: original!.windowIndices.indexOf(firstProposal.current),
        stale: original!.windowIndices.indexOf(secondProposal.stale)
      }]
    })).toBeUndefined();
    const validPairHint = {
      current: original!.windowIndices.indexOf(firstProposal.current),
      stale: original!.windowIndices.indexOf(firstProposal.stale)
    };
    expect(resolveCorrectionPairSelection(candidates, original!, {
      httpAttempts: 1,
      order: original!.windowIndices.map((_index, localIndex) => localIndex),
      outcome: "success",
      pairHints: [
        {
          current: original!.windowIndices.indexOf(firstProposal.current),
          stale: original!.windowIndices.indexOf(secondProposal.stale)
        },
        validPairHint
      ]
    })).toBeUndefined();
    expect(resolveCorrectionPairSelection(candidates, original!, {
      httpAttempts: 1,
      order: original!.windowIndices.map((_index, localIndex) => localIndex),
      outcome: "success",
      pairHints: [
        { current: "invalid", stale: validPairHint.stale } as unknown as RecallRerankPairHint,
        validPairHint
      ]
    })).toBeUndefined();
  });

  it("ranks jointly query-relevant semantic pairs above perfect but irrelevant pairs", () => {
    const candidates: CorrectionPairShortlistCandidate[] = [
      { embedding: [1, 0, 0], identity: { chunkIndex: 0, file: "irrelevant-current" }, queryScore: 0.05, stale: false },
      { embedding: [0, 1, 0], identity: { chunkIndex: 1, file: "relevant-current" }, queryScore: 0.9, stale: false },
      { embedding: [1, 0, 0], identity: { chunkIndex: 2, file: "irrelevant-stale" }, queryScore: 0.05, stale: true },
      { embedding: [0, 0.8, 0.6], identity: { chunkIndex: 3, file: "relevant-stale" }, queryScore: 0.9, stale: true }
    ];

    expect(buildCorrectionPairShortlist(candidates)?.windowIndices).toEqual([1, 0, 3, 2]);
  });

  it("returns no proposal when every bounded compatibility score is non-positive", () => {
    expect(buildCorrectionPairShortlist([
      { embedding: [1, 0], identity: { chunkIndex: 0, file: "current" }, queryScore: 0, stale: false },
      { embedding: [1, 0], identity: { chunkIndex: 1, file: "stale" }, queryScore: 0.9, stale: true }
    ])).toBeUndefined();
  });

  it("keeps every bounded side-size deterministic under property-style enumeration", () => {
    for (let currentCount = 1; currentCount <= 10; currentCount += 1) {
      for (let staleCount = 1; staleCount <= 10; staleCount += 1) {
        const candidates = [
          ...Array.from({ length: currentCount }, (_value, index) => candidate(index, false)),
          ...Array.from({ length: staleCount }, (_value, index) => candidate(index + currentCount, true))
        ];
        const original = buildCorrectionPairShortlist(candidates, "original")!;
        const repeated = buildCorrectionPairShortlist(candidates, "original")!;
        const reversed = buildCorrectionPairShortlist(candidates, "reversed-within-groups")!;

        expect(repeated).toEqual(original);
        expect(original.diagnostics.compatibilityComparisons).toBe(currentCount * staleCount);
        expect(original.diagnostics.proposalCount).toBeLessThanOrEqual(6);
        expect(original.diagnostics.candidateCount).toBeLessThanOrEqual(12);
        const firstStale = original.windowIndices.findIndex((index) => candidates[index]!.stale);
        expect(firstStale).toBeGreaterThan(0);
        expect(original.windowIndices.slice(0, firstStale).every((index) => !candidates[index]!.stale)).toBe(true);
        expect(original.windowIndices.slice(firstStale).every((index) => candidates[index]!.stale)).toBe(true);
        expect([...reversed.windowIndices].sort((left, right) => left - right))
          .toEqual([...original.windowIndices].sort((left, right) => left - right));
      }
    }
  });

  it("rejects empty, overflow, ambiguous identity, malformed vector, and builder exceptions", () => {
    const valid = [candidate(0, false), candidate(1, true)];
    expect(buildCorrectionPairShortlist([])).toBeUndefined();
    expect(buildCorrectionPairShortlist([candidate(0, false)])).toBeUndefined();
    expect(buildCorrectionPairShortlist([
      valid[0]!,
      { ...valid[1]!, identity: valid[0]!.identity }
    ])).toBeUndefined();
    expect(buildCorrectionPairShortlist(Array.from({ length: 21 }, (_value, index) => candidate(index, index >= 10))))
      .toBeUndefined();
    expect(buildCorrectionPairShortlist([
      valid[0]!,
      { ...valid[1]!, embedding: [Number.NaN] }
    ])).toBeUndefined();
    expect(buildCorrectionPairShortlist([
      { ...valid[0]!, embedding: [1, 0] },
      { ...valid[1]!, embedding: [1, 0, 0] }
    ])).toBeUndefined();
    const throwing = {
      get embedding(): readonly number[] { throw new Error("unreadable vector"); },
      identity: { chunkIndex: 2, file: "throwing" },
      queryScore: 0.5,
      stale: true
    } satisfies CorrectionPairShortlistCandidate;
    expect(buildCorrectionPairShortlist([valid[0]!, throwing])).toBeUndefined();
  });

  it("uses identities only for validation, never as a compatibility signal", () => {
    const plain = Array.from({ length: 12 }, (_value, index) => candidate(index, index >= 6));
    const metadataLookalikes = plain.map((item, index) => ({
      ...item,
      identity: {
        chunkIndex: item.identity.chunkIndex + 100,
        file: index % 2 === 0 ? `ko-health-old-${index.toString()}` : `en-work-current-${index.toString()}`
      }
    }));

    expect(buildCorrectionPairShortlist(metadataLookalikes)?.windowIndices)
      .toEqual(buildCorrectionPairShortlist(plain)?.windowIndices);
  });
});

describe("retrieveAndRankNotes — stale-vs-current demotion (answer-evidence seam)", () => {
  it("preserves a matching stale note when the original adaptive window would have skipped reranking", async () => {
    const selectedNoise = await noteFile("agenda.md", "Tuesday meeting agenda.", [0.98, Math.sqrt(1 - 0.98 ** 2)]);
    const current = await noteFile("rent_current.md", "Office rent is 1300 now.", [0.99, Math.sqrt(1 - 0.99 ** 2)]);
    const stale = await noteFile("rent_old.md", "I used to pay office rent 1200; no longer current.", [0.94, Math.sqrt(1 - 0.94 ** 2)]);
    const low = await Promise.all([0.93, 0.92, 0.91, 0.9].map((score, index) =>
      noteFile(`low-${index.toString()}.md`, `Unrelated archive ${index.toString()}.`, [score, Math.sqrt(1 - score ** 2)])));
    let rerankCalls = 0;
    process.env.MUSE_RECALL_GRAPH_HOP = "false";
    process.env.MUSE_RECALL_SECOND_HOP = "false";
    try {
      const ask = (conflictAwareSelection: boolean) => retrieveAndRankNotes({
        conflictAwareSelection,
        embedFn, embedModel: "test-embed", indexFiles: [selectedNoise, current, stale, ...low], json: true, notesDir: dir,
        onStderr: () => {}, query: "what changed", rerankFn: async () => { rerankCalls += 1; return [0]; },
        scope: undefined, topK: 2
      });
      const baseline = await ask(false);
      expect(baseline.scored.map((item) => item.file)).toContain(current.path);
      expect(baseline.scored.map((item) => item.file)).not.toContain(stale.path);
      const result = await ask(true);
      expect(rerankCalls).toBe(2);
      expect(result.rerankDecision).toEqual({
        eligible: true,
        httpAttempts: 0,
        logicalInvocations: 1,
        outcome: "success"
      });
      expect(result.scored.map((item) => item.file)).toEqual([current.path, stale.path]);
      expect(result.scored).toHaveLength(2);
    } finally {
      delete process.env.MUSE_RECALL_GRAPH_HOP;
      delete process.env.MUSE_RECALL_SECOND_HOP;
    }
  });

  it("preserves a lexically specific mutual semantic pair below the fixed raw-cosine fallback", async () => {
    const current = await noteFile("cedar-current.md", "Cedar lantern calibration is 41 now.", [0.8, 0.6, 0]);
    const stale = await noteFile(
      "cedar-old.md",
      "I used to set cedar lantern calibration to 37; no longer current.",
      [0.3, Math.sqrt(1 - 0.3 ** 2), 0]
    );
    const selectedNoise = await noteFile("harbor.md", "Harbor ferry timetable.", [0.95, 0, Math.sqrt(1 - 0.95 ** 2)]);
    process.env.MUSE_RECALL_GRAPH_HOP = "false";
    process.env.MUSE_RECALL_SECOND_HOP = "false";
    try {
      const result = await retrieveAndRankNotes({
        conflictAwareSelection: true,
        embedFn, embedModel: "test-embed", indexFiles: [current, stale, selectedNoise], json: true, notesDir: dir,
        onStderr: () => {}, query: "cedar lantern setting", rerankFn: async (_query, texts) => [
          texts.findIndex((text) => text.includes("Cedar lantern")),
          texts.findIndex((text) => text.includes("Harbor ferry"))
        ], scope: undefined, topK: 2
      });
      expect(result.scored.map((item) => item.file)).toEqual([current.path, stale.path]);
      expect(result.scored).toHaveLength(2);
    } finally {
      delete process.env.MUSE_RECALL_GRAPH_HOP;
      delete process.env.MUSE_RECALL_SECOND_HOP;
    }
  });

  it("preserves a selected stale note with its matching current note inside the fixed topK", async () => {
    const stale = await noteFile("rent_old.md", "I used to pay office rent 1200; no longer current.", [0.8, 0.6]);
    const current = await noteFile("rent_current.md", "Office rent is 1300 now.", [0.75, Math.sqrt(1 - 0.75 ** 2)]);
    const unrelated = await noteFile("vpn.md", "WireGuard MTU is 1380.", [0.95, Math.sqrt(1 - 0.95 ** 2)]);
    process.env.MUSE_RECALL_GRAPH_HOP = "false";
    process.env.MUSE_RECALL_SECOND_HOP = "false";
    try {
      const result = await retrieveAndRankNotes({
        conflictAwareSelection: true,
        embedFn, embedModel: "test-embed", indexFiles: [stale, current, unrelated], json: true, notesDir: dir,
        onStderr: () => {}, query: "what changed", rerankFn: async (_query, texts) => [
          texts.findIndex((text) => text.includes("used to pay")),
          texts.findIndex((text) => text.includes("WireGuard"))
        ], scope: undefined, topK: 2
      });
      expect(result.scored.map((item) => item.file)).toEqual([current.path, stale.path]);
      expect(result.scored).toHaveLength(2);
    } finally {
      delete process.env.MUSE_RECALL_GRAPH_HOP;
      delete process.env.MUSE_RECALL_SECOND_HOP;
    }
  });

  it("promotes a confirmed current counterpart into its selected stale anchor's relevance position", async () => {
    const stale = await noteFile("rent-old.md", "I used to pay office rent 1200; no longer current.", [0.8, 0.6]);
    const current = await noteFile("rent-current.md", "Office rent is 1300 now.", [0.75, Math.sqrt(1 - 0.75 ** 2)]);
    const firstNoise = await noteFile("agenda.md", "Tuesday meeting agenda.", [0.95, Math.sqrt(1 - 0.95 ** 2)]);
    const secondNoise = await noteFile("groceries.md", "Grocery shopping list.", [0.9, Math.sqrt(1 - 0.9 ** 2)]);
    process.env.MUSE_RECALL_GRAPH_HOP = "false";
    process.env.MUSE_RECALL_SECOND_HOP = "false";
    try {
      const result = await retrieveAndRankNotes({
        conflictAwareSelection: true,
        embedFn, embedModel: "test-embed", indexFiles: [stale, current, firstNoise, secondNoise], json: true, notesDir: dir,
        onStderr: () => {}, query: "what changed", rerankFn: async (_query, texts) => [
          texts.findIndex((text) => text.includes("used to pay")),
          texts.findIndex((text) => text.includes("meeting agenda")),
          texts.findIndex((text) => text.includes("shopping list"))
        ], scope: undefined, topK: 3
      });

      expect(result.scored.map((item) => item.file)).toEqual([current.path, firstNoise.path, stale.path]);
    } finally {
      delete process.env.MUSE_RECALL_GRAPH_HOP;
      delete process.env.MUSE_RECALL_SECOND_HOP;
    }
  });

  it("gives the fixed topK replacement slot to the more query-relevant conflict pair", async () => {
    const lowCurrent = await noteFile("loom-current.md", "Amber loom shuttle tension is 12 now.", [0.5, Math.sqrt(0.75), 0, 0]);
    const lowStale = await noteFile("loom-old.md", "I used to set amber loom shuttle tension to 9; no longer current.", [0.45, Math.sqrt(1 - 0.45 ** 2), 0, 0]);
    const relevantCurrent = await noteFile("greenhouse-current.md", "Quartz greenhouse louver angle is 18 now.", [0.9, 0, Math.sqrt(0.19), 0]);
    const relevantStale = await noteFile("greenhouse-old.md", "I used to set quartz greenhouse louver angle to 11; no longer current.", [0.85, 0, Math.sqrt(1 - 0.85 ** 2), 0]);
    const noise = await noteFile("plum.md", "Plum orchard crate count.", [0.8, 0, 0, 0.6]);
    process.env.MUSE_RECALL_GRAPH_HOP = "false";
    process.env.MUSE_RECALL_SECOND_HOP = "false";
    try {
      const result = await retrieveAndRankNotes({
        conflictAwareSelection: true,
        embedFn: async () => [1, 0, 0, 0], embedModel: "test-embed",
        indexFiles: [lowCurrent, lowStale, relevantCurrent, relevantStale, noise],
        json: true, notesDir: dir, onStderr: () => {}, query: "greenhouse louver setting",
        rerankFn: async (_query, texts) => [
          texts.findIndex((text) => text.includes("Amber loom shuttle tension is")),
          texts.findIndex((text) => text.includes("Quartz greenhouse louver angle is")),
          texts.findIndex((text) => text.includes("Plum orchard"))
        ], scope: undefined, topK: 3
      });
      expect(result.scored.map((item) => item.file)).toEqual([lowCurrent.path, relevantCurrent.path, relevantStale.path]);
      expect(result.scored.map((item) => item.file)).not.toContain(lowStale.path);
      expect(result.scored).toHaveLength(3);
    } finally {
      delete process.env.MUSE_RECALL_GRAPH_HOP;
      delete process.env.MUSE_RECALL_SECOND_HOP;
    }
  });

  it("omitted and explicit false conflict-aware selection both reproduce the baseline", async () => {
    const stale = await noteFile("rent_old.md", "I used to pay office rent 1200; no longer current.", [0.8, 0.6]);
    const current = await noteFile("rent_current.md", "Office rent is 1300 now.", [0.75, Math.sqrt(1 - 0.75 ** 2)]);
    const unrelated = await noteFile("vpn.md", "WireGuard MTU is 1380.", [0.95, Math.sqrt(1 - 0.95 ** 2)]);
    process.env.MUSE_RECALL_GRAPH_HOP = "false";
    process.env.MUSE_RECALL_SECOND_HOP = "false";
    try {
      const result = await retrieveAndRankNotes({
        conflictAwareSelection: false,
        embedFn, embedModel: "test-embed", indexFiles: [stale, current, unrelated], json: true, notesDir: dir,
        onStderr: () => {}, query: "what changed", rerankFn: async (_query, texts) => [
          texts.findIndex((text) => text.includes("used to pay")),
          texts.findIndex((text) => text.includes("WireGuard"))
        ], scope: undefined, topK: 2
      });
      expect(result.scored.map((item) => item.file)).toEqual([unrelated.path, stale.path]);
      const omitted = await retrieveAndRankNotes({
        embedFn, embedModel: "test-embed", indexFiles: [stale, current, unrelated], json: true, notesDir: dir,
        onStderr: () => {}, query: "what changed", rerankFn: async (_query, texts) => [
          texts.findIndex((text) => text.includes("used to pay")),
          texts.findIndex((text) => text.includes("WireGuard"))
        ], scope: undefined, topK: 2
      });
      expect(omitted.scored.map((item) => item.file)).toEqual(result.scored.map((item) => item.file));
    } finally {
      delete process.env.MUSE_RECALL_GRAPH_HOP;
      delete process.env.MUSE_RECALL_SECOND_HOP;
    }
  });

  it("does not pair a stale note with a semantically unrelated current candidate", async () => {
    const stale = await noteFile("rent_old.md", "I used to pay office rent 1200; no longer current.", [0.8, 0.6]);
    const unrelatedCurrent = await noteFile("vpn.md", "WireGuard MTU is 1380 now.", [-0.8, 0.6]);
    const selectedNoise = await noteFile("agenda.md", "Meeting agenda for Tuesday.", [0.95, Math.sqrt(1 - 0.95 ** 2)]);
    process.env.MUSE_RECALL_GRAPH_HOP = "false";
    process.env.MUSE_RECALL_SECOND_HOP = "false";
    try {
      const result = await retrieveAndRankNotes({
        conflictAwareSelection: true,
        embedFn, embedModel: "test-embed", indexFiles: [stale, unrelatedCurrent, selectedNoise], json: true, notesDir: dir,
        onStderr: () => {}, query: "what changed", rerankFn: async (_query, texts) => [
          texts.findIndex((text) => text.includes("used to pay")),
          texts.findIndex((text) => text.includes("Meeting agenda"))
        ], scope: undefined, topK: 2
      });
      expect(result.scored.map((item) => item.file)).toEqual([selectedNoise.path, stale.path]);
      expect(result.scored.map((item) => item.file)).not.toContain(unrelatedCurrent.path);
    } finally {
      delete process.env.MUSE_RECALL_GRAPH_HOP;
      delete process.env.MUSE_RECALL_SECOND_HOP;
    }
  });

  it("does not pair lexical lookalikes when their meanings are adversarially unrelated", async () => {
    const current = await noteFile("python_current.md", "Python currently labels family photos.", [0.99, 0.1]);
    const staleLookalike = await noteFile(
      "python_old.md",
      "I used to deploy the Python billing service; no longer current.",
      [-0.99, 0.1]
    );
    const selectedNoise = await noteFile("agenda.md", "Meeting agenda for Tuesday.", [0.95, 0.2]);
    const result = await retrieveAndRankNotes({
      conflictAwareSelection: true,
      embedFn, embedModel: "test-embed", indexFiles: [current, staleLookalike, selectedNoise], json: true, notesDir: dir,
      onStderr: () => {}, query: "what changed", rerankFn: async (_query, texts) => [
        texts.findIndex((text) => text.includes("family photos")),
        texts.findIndex((text) => text.includes("Meeting agenda"))
      ], scope: undefined, topK: 2
    });
    expect(result.scored.map((item) => item.file)).toEqual([current.path, selectedNoise.path]);
    expect(result.scored.map((item) => item.file)).not.toContain(staleLookalike.path);
  });

  it("preserves a specific current/stale pair in a large corpus despite unrelated semantic collisions", async () => {
    const current = await noteFile("cedar-current.md", "Cedar lantern calibration is 41 now.", [0.8, 0.6, 0]);
    const stale = await noteFile("cedar-old.md", "I used to set cedar lantern calibration to 37; no longer current.", [0.3, Math.sqrt(1 - 0.3 ** 2), 0]);
    const collision = await noteFile("harbor-old.md", "I used to follow the harbor ferry timetable; no longer current.", [0.8, 0.6, 0]);
    const noise = await noteFile("selected-noise.md", "Tuesday meeting agenda.", [0.95, 0, Math.sqrt(1 - 0.95 ** 2)]);
    const topicalCorpus = await Promise.all([0, 1].map((index) =>
      noteFile(`cedar-reference-${index.toString()}.md`, `Cedar lantern calibration reference ${index.toString()}.`, [0.1, 0, Math.sqrt(0.99)])));
    const unrelatedCorpus = await Promise.all(Array.from({ length: 92 }, (_value, index) =>
      noteFile(`archive-${index.toString()}.md`, `Unrelated archive topic ${index.toString()}.`, [0.05, 0, Math.sqrt(1 - 0.05 ** 2)])));

    process.env.MUSE_RECALL_GRAPH_HOP = "false";
    process.env.MUSE_RECALL_SECOND_HOP = "false";
    try {
      const result = await retrieveAndRankNotes({
        conflictAwareSelection: true,
        embedFn, embedModel: "test-embed",
        indexFiles: [current, stale, collision, noise, ...topicalCorpus, ...unrelatedCorpus],
        json: true, notesDir: dir, onStderr: () => {}, query: "cedar lantern setting",
        rerankFn: async (_query, texts) => [
          texts.findIndex((text) => text.includes("Cedar lantern calibration is")),
          texts.findIndex((text) => text.includes("Tuesday meeting agenda"))
        ], scope: undefined, topK: 2
      });

      expect(result.scored.map((item) => item.file)).toEqual([current.path, stale.path]);
      expect(result.scored.map((item) => item.file)).not.toContain(collision.path);
    } finally {
      delete process.env.MUSE_RECALL_GRAPH_HOP;
      delete process.env.MUSE_RECALL_SECOND_HOP;
    }
  });

  it("bounds direct topK input to the CLI retrieval contract", async () => {
    const files = await Promise.all(Array.from({ length: 25 }, async (_value, index) =>
      noteFile(`note-${index.toString()}.md`, `note ${index.toString()}`, [1, 0])
    ));
    const result = await retrieveAndRankNotes({
      embedFn, embedModel: "test-embed", indexFiles: files, json: true, notesDir: dir,
      onStderr: () => {}, query: "notes", scope: undefined, topK: Number.POSITIVE_INFINITY
    });
    expect(result.scored).toEqual([]);

    const capped = await retrieveAndRankNotes({
      embedFn, embedModel: "test-embed", indexFiles: files, json: true, notesDir: dir,
      onStderr: () => {}, query: "notes", scope: undefined, topK: 999
    });
    expect(capped.preGapScored).toHaveLength(20);
  });

  // Both align closely with the query direction; the stale note's raw cosine
  // (1.0, a perfect match) OUTRANKS the current note's (~0.994) on score alone —
  // so a plain top-K cosine sort would rank the superseded fact first.
  it("ranks the CURRENT note above the higher-scoring but explicitly-stale one (top-1)", async () => {
    const stale = await noteFile("rent_old.md", "예전에 월세 120만원이었는데 지금은 아니다.", [1, 0]);
    const current = await noteFile("rent_new.md", "월세 125만원", [0.9, 0.1]);
    const result = await retrieveAndRankNotes({
      embedFn,
      embedModel: "test-embed",
      indexFiles: [stale, current],
      json: true,
      notesDir: dir,
      onStderr: () => {},
      query: "what is my rent",
      scope: undefined,
      topK: 6
    });
    expect(result.scored[0]?.file).toBe(current.path);
    expect(result.scored.map((s) => s.file)).toEqual([current.path, stale.path]);
  });

  it("demotes, never drops — both notes still appear", async () => {
    const stale = await noteFile("rent_old.md", "예전에 월세 120만원이었는데 지금은 아니다.", [1, 0]);
    const current = await noteFile("rent_new.md", "월세 125만원", [0.9, 0.1]);
    const result = await retrieveAndRankNotes({
      embedFn,
      embedModel: "test-embed",
      indexFiles: [stale, current],
      json: true,
      notesDir: dir,
      onStderr: () => {},
      query: "what is my rent",
      scope: undefined,
      topK: 6
    });
    expect(result.scored).toHaveLength(2);
  });

  it("leaves order untouched when neither note carries a stale marker (no behavior change for the common case)", async () => {
    const a = await noteFile("a.md", "월세 125만원", [1, 0]);
    const b = await noteFile("b.md", "wifi password is muse2026", [0.9, 0.1]);
    const result = await retrieveAndRankNotes({
      embedFn,
      embedModel: "test-embed",
      indexFiles: [a, b],
      json: true,
      notesDir: dir,
      onStderr: () => {},
      query: "what is my rent",
      scope: undefined,
      topK: 6
    });
    expect(result.scored.map((s) => s.file)).toEqual([a.path, b.path]);
  });
});

describe("retrieveAndRankNotes — confident-gated 1-hop link expansion (the graph-hop seam)", () => {
  const unit = (x: number): number[] => [x, Math.sqrt(1 - x * x)];

  const linkedVault = async (): Promise<FileEntry[]> => [
    await noteFile("hub.md", "muse project hub [[low]] [[high]] [[mid]]", [1, 0]),
    await noteFile("low.md", "unrelated beta detail", unit(0.2)),
    await noteFile("high.md", "unrelated gamma detail", unit(0.6)),
    await noteFile("mid.md", "unrelated delta detail", unit(0.4))
  ];

  const ask = async (indexFiles: FileEntry[]) => retrieveAndRankNotes({
    embedFn,
    embedModel: "test-embed",
    indexFiles,
    json: true,
    notesDir: dir,
    onStderr: () => {},
    query: "muse project hub",
    scope: undefined,
    topK: 1
  });

  it("promotes linked notes by their REAL query cosine, not the [[link]] document order", async () => {
    const files = await linkedVault();
    const result = await ask(files);
    expect(result.scored.map((s) => s.file)).toEqual([
      files[0]!.path,       // the confident seed
      files[2]!.path,       // high.md (cosine 0.6) — promoted first
      files[3]!.path        // mid.md (cosine 0.4) — promoted second
    ]);
    expect(result.scored.map((s) => s.file)).not.toContain(files[1]!.path); // low.md loses the cap on cosine
  });

  it("promotes a note that BACKLINKS to the confident seed", async () => {
    const seed = await noteFile("topic.md", "muse project hub", [1, 0]);
    const citing = await noteFile("citing.md", "details citing [[topic]]", unit(0.5));
    const result = await ask([seed, citing]);
    expect(result.scored.map((s) => s.file)).toEqual([seed.path, citing.path]);
  });

  it("MUSE_RECALL_GRAPH_HOP=false disables expansion entirely (kill-switch parity with the second hop)", async () => {
    const files = await linkedVault();
    process.env.MUSE_RECALL_GRAPH_HOP = "false";
    try {
      const result = await ask(files);
      expect(result.scored.map((s) => s.file)).toEqual([files[0]!.path]);
    } finally {
      delete process.env.MUSE_RECALL_GRAPH_HOP;
    }
  });

  it("uses one explicit env snapshot for confidence and hop flags instead of ambient process.env", async () => {
    const files = [
      await noteFile("hub.md", "muse project hub [[detail]]", unit(0.6)),
      await noteFile("detail.md", "linked project detail", unit(0.4))
    ];
    const previous = {
      graph: process.env.MUSE_RECALL_GRAPH_HOP,
      minimum: process.env.MUSE_GROUNDING_MIN_COSINE,
      secondHop: process.env.MUSE_RECALL_SECOND_HOP
    };
    process.env.MUSE_GROUNDING_MIN_COSINE = "0.99";
    process.env.MUSE_RECALL_GRAPH_HOP = "false";
    process.env.MUSE_RECALL_SECOND_HOP = "false";
    try {
      const result = await retrieveAndRankNotes({
        embedFn,
        embedModel: "test-embed",
        env: {
          MUSE_GROUNDING_MIN_COSINE: "0.55",
          MUSE_RECALL_GRAPH_HOP: "true",
          MUSE_RECALL_SECOND_HOP: "false"
        },
        indexFiles: files,
        json: true,
        notesDir: dir,
        onStderr: () => {},
        query: "muse project hub",
        scope: undefined,
        topK: 1
      });

      expect(result.scored.map((item) => item.file)).toEqual([files[0]!.path, files[1]!.path]);
    } finally {
      if (previous.minimum === undefined) delete process.env.MUSE_GROUNDING_MIN_COSINE;
      else process.env.MUSE_GROUNDING_MIN_COSINE = previous.minimum;
      if (previous.graph === undefined) delete process.env.MUSE_RECALL_GRAPH_HOP;
      else process.env.MUSE_RECALL_GRAPH_HOP = previous.graph;
      if (previous.secondHop === undefined) delete process.env.MUSE_RECALL_SECOND_HOP;
      else process.env.MUSE_RECALL_SECOND_HOP = previous.secondHop;
    }
  });

  it("an ambiguous seed promotes a linked neighbor ONLY above the calibrated floor (bar 0.55 → floor 0.35 for test-embed)", async () => {
    // Isolate the graph hop: the second-hop augment legitimately fires on
    // ambiguous verdicts and would re-add the same note through a different door.
    process.env.MUSE_RECALL_SECOND_HOP = "false";
    try {
      const clearing = [
        await noteFile("hub.md", "muse project hub [[high]]", unit(0.3)),
        await noteFile("high.md", "unrelated gamma detail", unit(0.6))
      ];
      const promoted = await ask(clearing);
      expect(promoted.scored.map((s) => s.file)).toContain(clearing[1]!.path);

      const below = [
        await noteFile("hub2.md", "muse project hub [[weak]]", unit(0.3)),
        await noteFile("weak.md", "unrelated epsilon detail", unit(0.2))
      ];
      const rejected = await retrieveAndRankNotes({
        embedFn, embedModel: "test-embed", indexFiles: below, json: true, notesDir: dir,
        onStderr: () => {}, query: "muse project hub", scope: undefined, topK: 1
      });
      expect(rejected.scored.map((s) => s.file)).not.toContain(below[1]!.path);
    } finally {
      delete process.env.MUSE_RECALL_SECOND_HOP;
    }
  });
});

describe("retrieveAndRankNotes — local-LLM rerank seam (opt-in via rerankFn)", () => {
  const unit = (x: number): number[] => [x, Math.sqrt(1 - x * x)];

  const vault = async (): Promise<FileEntry[]> => [
    await noteFile("close.md", "rent thoughts rambling", unit(0.9)),
    await noteFile("answer.md", "autopay goes out on the 25th", unit(0.7)),
    await noteFile("noise.md", "wifi password muse2026", unit(0.5))
  ];

  const ask = async (indexFiles: FileEntry[], rerankFn?: RecallRerankFn) =>
    retrieveAndRankNotes({
      embedFn,
      embedModel: "test-embed",
      indexFiles,
      json: true,
      notesDir: dir,
      onStderr: () => {},
      query: "rent transfer day",
      ...(rerankFn ? { rerankFn } : {}),
      scope: undefined,
      topK: 1
    });

  it("the reranker's pick replaces the cosine top-1 in the prompt window", async () => {
    const files = await vault();
    let sawTexts: readonly string[] = [];
    const result = await ask(files, async (_q, texts) => {
      sawTexts = texts;
      return { httpAttempts: 1, order: [texts.findIndex((t) => t.includes("25th"))], outcome: "success" };
    });
    expect(sawTexts.length).toBeGreaterThan(1);
    expect(result.scored[0]?.file).toBe(files[1]!.path);
    expect(result.scored).toHaveLength(1);
    expect(result.rerankDecision).toEqual({
      eligible: true,
      httpAttempts: 1,
      logicalInvocations: 1,
      outcome: "success"
    });
  });

  it("preserves the highest-ranked valid correction pair current-first inside topK", async () => {
    const stale = await noteFile("rent-stale.md", "I used to pay office rent 1200; no longer current.", unit(0.95));
    const noise = await noteFile("agenda.md", "Tuesday meeting agenda.", unit(0.9));
    const current = await noteFile("rent-current.md", "Office rent is 1300 now.", unit(0.4));
    const tail = await noteFile("tail.md", "Unrelated archive.", unit(0.3));
    const lowerStale = await noteFile("wifi-stale.md", "The wifi password used to be alpha; no longer current.", unit(0.2));
    const lowerCurrent = await noteFile("wifi-current.md", "The wifi password is beta now.", unit(0.1));
    process.env.MUSE_RECALL_GRAPH_HOP = "false";
    process.env.MUSE_RECALL_SECOND_HOP = "false";
    try {
      const result = await retrieveAndRankNotes({
        conflictAwareSelection: false,
        embedFn, embedModel: "test-embed", indexFiles: [stale, noise, current, tail, lowerStale, lowerCurrent], json: true, notesDir: dir,
        onStderr: () => {}, query: "what is the office rent", rerankFn: async (_query, texts) => {
          const staleIndex = texts.findIndex((text) => text.includes("used to pay"));
          const currentIndex = texts.findIndex((text) => text.includes("1300 now"));
          const noiseIndex = texts.findIndex((text) => text.includes("meeting agenda"));
          const lowerStaleIndex = texts.findIndex((text) => text.includes("used to be alpha"));
          const lowerCurrentIndex = texts.findIndex((text) => text.includes("beta now"));
          return {
            httpAttempts: 1,
            order: [staleIndex, noiseIndex, currentIndex, lowerStaleIndex, lowerCurrentIndex],
            outcome: "success",
            pairHints: [
              { current: lowerCurrentIndex, stale: lowerStaleIndex },
              { current: currentIndex, stale: staleIndex },
              { current: currentIndex, stale: staleIndex }
            ]
          };
        }, scope: undefined, topK: 3
      });

      expect(result.scored.map((item) => item.file)).toEqual([current.path, noise.path, stale.path]);
    } finally {
      delete process.env.MUSE_RECALL_GRAPH_HOP;
      delete process.env.MUSE_RECALL_SECOND_HOP;
    }
  });

  it("carries a validated correction pair as exact immutable chunk identities", async () => {
    const stale = await noteFile("rent-stale.md", "I used to pay office rent 1200; no longer current.", unit(0.95));
    const noise = await noteFile("agenda.md", "Tuesday meeting agenda.", unit(0.9));
    const current = await noteFile("rent-current.md", "Office rent is 1300 now.", unit(0.4));
    const tail = await noteFile("tail.md", "Unrelated archive.", unit(0.3));
    const rerankFn = Object.assign(async (_query: string, texts: readonly string[]): Promise<RecallRerankExecution> => {
      const staleIndex = texts.findIndex((text) => text.includes("used to pay"));
      const currentIndex = texts.findIndex((text) => text.includes("1300 now"));
      return {
        httpAttempts: 1,
        order: texts.map((_text, index) => index),
        outcome: "success",
        pairHints: [{ current: currentIndex, stale: staleIndex }]
      };
    }, { mode: "correction-pair" as const });

    const result = await retrieveAndRankNotes({
      conflictAwareSelection: false,
      embedFn,
      embedModel: "test-embed",
      indexFiles: [stale, noise, current, tail],
      json: true,
      notesDir: dir,
      onStderr: () => {},
      query: "what is the office rent",
      rerankFn,
      scope: undefined,
      snapshotIdentity: { indexBuiltAtIso: "2026-07-21T00:00:00.000Z", notesIndexFile: join(dir, "notes-index.json") },
      topK: 3
    });

    expect(result.verifiedCorrectionPair).toEqual({
      current: { chunkIndex: 0, file: current.path },
      stale: { chunkIndex: 0, file: stale.path }
    });
    expect(result.snapshot?.result.verifiedCorrectionPair).toEqual(result.verifiedCorrectionPair);
    expect(Object.isFrozen(result.snapshot?.result.verifiedCorrectionPair)).toBe(true);
    expect(Object.isFrozen(result.snapshot?.result.verifiedCorrectionPair?.current)).toBe(true);
    expect(Object.isFrozen(result.snapshot?.result.verifiedCorrectionPair?.stale)).toBe(true);
  });

  it("marks malformed pair-mode success invalid while preserving explicit null as successful fallback", async () => {
    const stale = await noteFile("rent-stale.md", "I used to pay office rent 1200; no longer current.", unit(0.95));
    const noise = await noteFile("agenda.md", "Tuesday meeting agenda.", unit(0.9));
    const current = await noteFile("rent-current.md", "Office rent is 1300 now.", unit(0.4));
    const tail = await noteFile("tail.md", "Unrelated archive.", unit(0.3));
    const files = [stale, noise, current, tail];
    const run = async (reply: "invalid" | "null") => {
      const rerankFn = Object.assign(async (_query: string, texts: readonly string[]): Promise<RecallRerankExecution> => {
        const staleIndex = texts.findIndex((text) => text.includes("used to pay"));
        const currentIndex = texts.findIndex((text) => text.includes("1300 now"));
        return {
          httpAttempts: 1,
          order: texts.map((_text, index) => index),
          outcome: "success",
          ...(reply === "invalid" ? { pairHints: [{ current: staleIndex, stale: currentIndex }] } : {})
        };
      }, { mode: "correction-pair" as const });
      return retrieveAndRankNotes({
        conflictAwareSelection: false,
        embedFn,
        embedModel: "test-embed",
        indexFiles: files,
        json: true,
        notesDir: dir,
        onStderr: () => {},
        query: "what is the office rent",
        rerankFn,
        scope: undefined,
        topK: 3
      });
    };

    const invalid = await run("invalid");
    const explicitNull = await run("null");

    expect(invalid.rerankDecision).toEqual({
      eligible: true,
      httpAttempts: 1,
      logicalInvocations: 1,
      outcome: "invalid"
    });
    expect(invalid.verifiedCorrectionPair).toBeUndefined();
    expect(explicitNull.rerankDecision).toEqual({
      eligible: true,
      httpAttempts: 1,
      logicalInvocations: 1,
      outcome: "success"
    });
    expect(explicitNull.verifiedCorrectionPair).toBeUndefined();
    expect(explicitNull.scored.map((item) => item.file)).toEqual(invalid.scored.map((item) => item.file));
  });

  it("shortlists at most six correction proposals before calling the pair-aware reranker", async () => {
    const files = await Promise.all(Array.from({ length: 30 }, async (_value, index) => {
      const score = index < 10 ? 0.99 - index * 0.01 : 0.3 - index * 0.005;
      if (index === 7) return noteFile("rent-current-deep.md", "Office rent is 1300 now.", unit(score));
      if (index === 8) return noteFile("rent-stale-deep.md", "I used to pay office rent 1200; no longer current.", unit(score));
      return noteFile(`noise-${index.toString()}.md`, `Unrelated archive ${index.toString()}.`, unit(score));
    }));
    let candidateTexts: readonly string[] = [];
    let embedCalls = 0;
    let rerankCalls = 0;
    let rerankContext: RecallRerankContext | undefined;
    const rerankFn = Object.assign(async (
      _query: string,
      texts: readonly string[],
      context?: RecallRerankContext
    ): Promise<RecallRerankExecution> => {
      rerankCalls += 1;
      candidateTexts = texts;
      rerankContext = context;
      const current = texts.findIndex((text) => text.includes("1300 now"));
      const stale = texts.findIndex((text) => text.includes("used to pay"));
      return { httpAttempts: 1, order: texts.map((_text, index) => index), outcome: "success", pairHints: [{ current, stale }] };
    }, { mode: "correction-pair" as const });

    const conflictOnly = await retrieveAndRankNotes({
      conflictAwareSelection: true,
      embedFn, embedModel: "test-embed", indexFiles: files, json: true, notesDir: dir,
      onStderr: () => {}, query: "???", scope: undefined, topK: 3
    });
    const result = await retrieveAndRankNotes({
      conflictAwareSelection: true,
      embedFn: async () => { embedCalls += 1; return [1, 0]; }, embedModel: "test-embed", indexFiles: files, json: true, notesDir: dir,
      onStderr: () => {}, query: "???", rerankFn, scope: undefined, topK: 3
    });

    expect(embedCalls).toBe(1);
    expect(rerankCalls).toBe(1);
    expect(candidateTexts).toHaveLength(7);
    expect(rerankContext?.allowedCorrectionPairs).toEqual(
      Array.from({ length: 6 }, (_value, current) => ({ current, stale: 6 }))
    );
    expect(candidateTexts.slice(0, -1).every((text) => !detectStaleMarker(text))).toBe(true);
    expect(detectStaleMarker(candidateTexts.at(-1) ?? "")).toBe(true);
    expect(conflictOnly.scored.map((item) => item.file)).not.toContain(files[7]!.path);
    expect(conflictOnly.scored.map((item) => item.file)).not.toContain(files[8]!.path);
    expect(result.scored[0]?.file).toBe(files[7]!.path);
    expect(result.scored.at(-1)?.file).toBe(files[8]!.path);
    expect(result.scored).toHaveLength(3);
  });

  it("reserves bounded stale-marker coverage when the target stale note falls outside the diversified top 20", async () => {
    const semanticUnit = (score: number, axis: 1 | 2 | 3): number[] => {
      const embedding = [score, 0, 0, 0];
      embedding[axis] = Math.sqrt(1 - score ** 2);
      return embedding;
    };
    const files = await Promise.all(Array.from({ length: 30 }, async (_value, index) => {
      if (index === 4) return noteFile("target-current.md", "Office rent is 1300 now.", semanticUnit(0.96, 1));
      if (index === 27) return noteFile("target-stale.md", "I used to pay office rent 1200; no longer current.", semanticUnit(0.79, 1));
      if (index === 1 || (index >= 10 && index <= 17)) {
        const staleScore = 0.78 - (index % 10) * 0.003;
        return noteFile(`other-stale-${index.toString()}.md`, `Archive ${index.toString()} used to be active; no longer current.`, semanticUnit(staleScore, 2));
      }
      const currentScore = 0.99 - (index % 20) * 0.004;
      return noteFile(`coverage-noise-${index.toString()}.md`, `Unrelated archive ${index.toString()}.`, semanticUnit(currentScore, 3));
    }));
    let targetAvailable = false;
    let partitioned = false;
    const rerankFn = Object.assign(async (_query: string, texts: readonly string[]): Promise<RecallRerankExecution> => {
      const current = texts.findIndex((text) => text.includes("1300 now"));
      const stale = texts.findIndex((text) => text.includes("used to pay"));
      targetAvailable = current >= 0 && stale >= 0;
      const staleBoundary = texts.findIndex((text) => detectStaleMarker(text));
      partitioned = staleBoundary > 0
        && texts.slice(0, staleBoundary).every((text) => !detectStaleMarker(text))
        && texts.slice(staleBoundary).every((text) => detectStaleMarker(text));
      return { httpAttempts: 1, order: texts.map((_text, index) => index), outcome: "success", pairHints: [{ current, stale }] };
    }, { mode: "correction-pair" as const });

    const result = await retrieveAndRankNotes({
      conflictAwareSelection: true,
      embedFn: async () => [1, 0, 0, 0], embedModel: "test-embed", indexFiles: files, json: true, notesDir: dir,
      onStderr: () => {}, query: "???", rerankFn, scope: undefined, topK: 3
    });

    expect(targetAvailable).toBe(true);
    expect(partitioned).toBe(true);
    expect(result.scored[0]?.file).toBe(files[4]!.path);
    expect(result.scored.map((item) => item.file)).toContain(files[27]!.path);
  });

  it("keeps a hybrid-window stale match ahead of higher-cosine stale backfill", async () => {
    const dimension = 30;
    const semanticUnit = (score: number, axis: number): number[] => {
      const embedding = Array.from({ length: dimension }, () => 0);
      embedding[0] = score;
      embedding[axis] = Math.sqrt(1 - score ** 2);
      return embedding;
    };
    const targetCurrent = await noteFile(
      "ledger-current.md",
      "The orchid ledger delivery channel is Gamma now.",
      semanticUnit(0.96, 1)
    );
    const currentDecoys = await Promise.all(Array.from({ length: 12 }, (_value, index) => noteFile(
      `current-decoy-${index.toString()}.md`,
      `Unrelated current record ${index.toString()}.`,
      semanticUnit(0.95 - index * 0.01, 2 + index)
    )));
    const staleDecoys = await Promise.all(Array.from({ length: 10 }, (_value, index) => noteFile(
      `stale-decoy-${index.toString()}.md`,
      `Archive ${index.toString()} used to be active; no longer current.`,
      semanticUnit(0.81 - index * 0.01, 14 + index)
    )));
    const targetStale = await noteFile(
      "ledger-stale.md",
      "The orchid ledger delivery channel used to be Beta; no longer current.",
      semanticUnit(0.7, 1)
    );
    let selectorTexts: readonly string[] = [];
    let selectorContext: RecallRerankContext | undefined;
    const rerankFn = Object.assign(async (
      _query: string,
      texts: readonly string[],
      context?: RecallRerankContext
    ): Promise<RecallRerankExecution> => {
      selectorTexts = texts;
      selectorContext = context;
      return { httpAttempts: 0, order: texts.map((_text, index) => index), outcome: "success" };
    }, { mode: "correction-pair" as const });

    await retrieveAndRankNotes({
      conflictAwareSelection: true,
      embedFn: async () => semanticUnit(1, 1),
      embedModel: "test-embed",
      env: { MUSE_RECALL_GRAPH_HOP: "false", MUSE_RECALL_SECOND_HOP: "false" },
      indexFiles: [targetCurrent, ...currentDecoys, ...staleDecoys, targetStale],
      json: true,
      notesDir: dir,
      onStderr: () => {},
      query: "What is the orchid ledger delivery channel?",
      rerankFn,
      scope: undefined,
      topK: 3
    });

    const current = selectorTexts.findIndex((text) => text.includes("Gamma now"));
    const stale = selectorTexts.findIndex((text) => text.includes("used to be Beta"));
    expect(current).toBeGreaterThanOrEqual(0);
    expect(stale).toBeGreaterThanOrEqual(0);
    expect(selectorContext?.allowedCorrectionPairs).toContainEqual({ current, stale });
  });

  it("bridges the score-best current match to a bounded semantic stale pool", async () => {
    const dimension = 40;
    const semanticUnit = (score: number, axis: number): number[] => {
      const embedding = Array.from({ length: dimension }, () => 0);
      embedding[0] = score;
      embedding[axis] = Math.sqrt(1 - score ** 2);
      return embedding;
    };
    const targetCurrent = await noteFile(
      "dispatch-current.md",
      "The orchid ledger delivery channel is Gamma now.",
      semanticUnit(0.96, 1)
    );
    const currentDecoys = await Promise.all(Array.from({ length: 12 }, (_value, index) => noteFile(
      `bridge-current-decoy-${index.toString()}.md`,
      `Unrelated current record ${index.toString()}.`,
      semanticUnit(0.95 - index * 0.01, 2 + index)
    )));
    const staleDecoys = await Promise.all(Array.from({ length: 14 }, (_value, index) => noteFile(
      `bridge-stale-decoy-${index.toString()}.md`,
      `Archive ${index.toString()} used to be active; no longer current.`,
      semanticUnit(0.78 - index * 0.006, 14 + index)
    )));
    const targetStale = await noteFile(
      "dispatch-stale.md",
      "The prior dispatch route was Beta; it is superseded and no longer current.",
      semanticUnit(0.69, 1)
    );
    let selectorTexts: readonly string[] = [];
    let selectorContext: RecallRerankContext | undefined;
    const rerankFn = Object.assign(async (
      _query: string,
      texts: readonly string[],
      context?: RecallRerankContext
    ): Promise<RecallRerankExecution> => {
      selectorTexts = texts;
      selectorContext = context;
      return { httpAttempts: 0, order: texts.map((_text, index) => index), outcome: "success" };
    }, { mode: "correction-pair" as const });

    await retrieveAndRankNotes({
      conflictAwareSelection: true,
      embedFn: async () => semanticUnit(1, 1),
      embedModel: "test-embed",
      env: { MUSE_RECALL_GRAPH_HOP: "false", MUSE_RECALL_SECOND_HOP: "false" },
      indexFiles: [targetCurrent, ...currentDecoys, ...staleDecoys, targetStale],
      json: true,
      notesDir: dir,
      onStderr: () => {},
      query: "What is the orchid ledger delivery channel?",
      rerankFn,
      scope: undefined,
      topK: 3
    });

    const current = selectorTexts.findIndex((text) => text.includes("Gamma now"));
    const stale = selectorTexts.findIndex((text) => text.includes("prior dispatch route"));
    expect(current).toBeGreaterThanOrEqual(0);
    expect(stale).toBeGreaterThanOrEqual(0);
    expect(selectorContext?.allowedCorrectionPairs).toContainEqual({ current, stale });
    expect(selectorContext?.diagnostics).toEqual({
      bridgeComparisons: 15,
      shortlistComparisons: 80,
      totalSemanticComparisons: 95
    });
    expect(selectorContext?.diagnostics?.bridgeComparisons).toBeLessThanOrEqual(20);
    expect(selectorContext?.diagnostics?.shortlistComparisons).toBeLessThanOrEqual(80);
    expect(selectorContext?.diagnostics?.totalSemanticComparisons).toBeLessThanOrEqual(100);
  });

  it("bridges from the score-best current candidate when hybrid ordering leads with a lexical match", async () => {
    const dimension = 32;
    const semanticUnit = (score: number, axis: number): number[] => {
      const embedding = Array.from({ length: dimension }, () => 0);
      embedding[0] = score;
      embedding[axis] = Math.sqrt(1 - score ** 2);
      return embedding;
    };
    const scoreBestCurrent = await noteFile(
      "score-best-current.md",
      "Gamma now governs dispatch.",
      semanticUnit(0.96, 1)
    );
    const hybridFirstCurrent = await noteFile(
      "hybrid-first-current.md",
      "The orchid ledger delivery channel reference.",
      semanticUnit(0.4, 2)
    );
    const currentDecoys = await Promise.all(Array.from({ length: 10 }, (_value, index) => noteFile(
      `anchor-current-decoy-${index.toString()}.md`,
      `Unrelated current record ${index.toString()}.`,
      semanticUnit(0.95 - index * 0.01, 3 + index)
    )));
    const staleDecoys = await Promise.all(Array.from({ length: 8 }, (_value, index) => noteFile(
      `anchor-stale-decoy-${index.toString()}.md`,
      `Archive ${index.toString()} used to be active; no longer current.`,
      semanticUnit(0.8 - index * 0.001, 2)
    )));
    const targetStale = await noteFile(
      "score-best-stale.md",
      "The prior route was Beta; it is superseded and no longer current.",
      semanticUnit(0.79, 1)
    );
    const files = [scoreBestCurrent, hybridFirstCurrent, ...currentDecoys, ...staleDecoys, targetStale];
    const query = "What is the orchid ledger delivery channel?";
    const allScored = files.flatMap((file) => file.chunks.map((chunk) => ({
      chunk,
      file: file.path,
      score: chunk.embedding[0]!
    })));
    const hybridWindow = diversifyAskChunks(allScored, 20, undefined, query);
    const scoreBest = [...allScored].sort((left, right) => right.score - left.score)[0];
    expect(hybridWindow[0]?.file).toBe(hybridFirstCurrent.path);
    expect(scoreBest?.file).toBe(scoreBestCurrent.path);
    expect(hybridWindow[0]).not.toBe(scoreBest);

    let selectorTexts: readonly string[] = [];
    let selectorContext: RecallRerankContext | undefined;
    const rerankFn = Object.assign(async (
      _query: string,
      texts: readonly string[],
      context?: RecallRerankContext
    ): Promise<RecallRerankExecution> => {
      selectorTexts = texts;
      selectorContext = context;
      return { httpAttempts: 0, order: texts.map((_text, index) => index), outcome: "success" };
    }, { mode: "correction-pair" as const });

    await retrieveAndRankNotes({
      conflictAwareSelection: true,
      embedFn: async () => semanticUnit(1, 1),
      embedModel: "test-embed",
      env: { MUSE_RECALL_GRAPH_HOP: "false", MUSE_RECALL_SECOND_HOP: "false" },
      indexFiles: files,
      json: true,
      notesDir: dir,
      onStderr: () => {},
      query,
      rerankFn,
      scope: undefined,
      topK: 3
    });

    const current = selectorTexts.findIndex((text) => text.includes("Gamma now"));
    const stale = selectorTexts.findIndex((text) => text.includes("prior route was Beta"));
    expect(current).toBeGreaterThanOrEqual(0);
    expect(stale).toBeGreaterThanOrEqual(0);
    expect(selectorContext?.allowedCorrectionPairs).toContainEqual({ current, stale });
  });

  it("keeps no-pair and invalid pair-aware selections byte-equivalent to conflict-only scored output", async () => {
    const files = await vault();
    const baseline = await retrieveAndRankNotes({
      conflictAwareSelection: true,
      embedFn, embedModel: "test-embed", indexFiles: files, json: true, notesDir: dir,
      onStderr: () => {}, query: "rent transfer day", scope: undefined, topK: 1
    });
    const run = (pairHints?: readonly RecallRerankPairHint[]) => retrieveAndRankNotes({
      conflictAwareSelection: true,
      embedFn, embedModel: "test-embed", indexFiles: files, json: true, notesDir: dir,
      onStderr: () => {}, query: "rent transfer day", rerankFn: Object.assign(async (_query: string, texts: readonly string[]): Promise<RecallRerankExecution> => ({
        httpAttempts: 1, order: texts.map((_text, index) => index), outcome: "success", ...(pairHints ? { pairHints } : {})
      }), { mode: "correction-pair" as const }), scope: undefined, topK: 1
    });

    for (const pairAware of [
      await run(),
      await run([{ current: 99, stale: 0 }]),
      await run([{ current: 0, stale: 0 }]),
      await run([{ current: 0, stale: 1 }])
    ]) {
      expect(pairAware.scored).toEqual(baseline.scored);
      expect(pairAware.rerankPair).toBeUndefined();
      expect(pairAware.verifiedCorrectionPair).toBeUndefined();
    }
  });

  it("does not invoke a pair-aware reranker when no correction proposal exists", async () => {
    const files = [
      await noteFile("rent.md", "Office rent is 1300 now.", unit(0.9)),
      await noteFile("agenda.md", "Tuesday meeting agenda.", unit(0.8))
    ];
    const baseline = await retrieveAndRankNotes({
      conflictAwareSelection: true,
      embedFn, embedModel: "test-embed", indexFiles: files, json: true, notesDir: dir,
      onStderr: () => {}, query: "office rent", scope: undefined, topK: 3
    });
    let rerankCalls = 0;
    const pairAware = await retrieveAndRankNotes({
      conflictAwareSelection: true,
      embedFn, embedModel: "test-embed", indexFiles: files, json: true, notesDir: dir,
      onStderr: () => {}, query: "office rent", rerankFn: Object.assign(async () => {
        rerankCalls += 1;
        return { httpAttempts: 1, order: [0], outcome: "success" } as const;
      }, { mode: "correction-pair" as const }), scope: undefined, topK: 3
    });

    expect(rerankCalls).toBe(0);
    expect(JSON.stringify(pairAware)).toBe(JSON.stringify(baseline));
  });

  it("does not invoke a pair-aware reranker when every pair score is non-positive", async () => {
    const files = [
      await noteFile("noise.md", "Direct query match without a correction.", [1, 0]),
      await noteFile("current.md", "Office rent is 1300 now.", [0, 1]),
      await noteFile("stale.md", "I used to pay office rent 1200; no longer current.", [0, 1])
    ];
    const common = {
      conflictAwareSelection: true,
      embedFn,
      embedModel: "test-embed",
      indexFiles: files,
      json: true,
      notesDir: dir,
      onStderr: () => {},
      query: "direct query match",
      scope: undefined,
      topK: 1
    } as const;
    const baseline = await retrieveAndRankNotes(common);
    let rerankCalls = 0;
    const pairAware = await retrieveAndRankNotes({
      ...common,
      rerankFn: Object.assign(async () => {
        rerankCalls += 1;
        return { httpAttempts: 1, order: [0, 1], outcome: "success" } as const;
      }, { mode: "correction-pair" as const })
    });

    expect(rerankCalls).toBe(0);
    expect(JSON.stringify(pairAware)).toBe(JSON.stringify(baseline));
  });

  it("does not invoke a pair-aware reranker when original chunk identity is ambiguous", async () => {
    const duplicatePath = join(dir, "duplicate.md");
    await writeFile(duplicatePath, "duplicate identity fixture");
    const duplicate = {
      chunks: [
        { chunkIndex: 0, embedding: unit(0.9), file: duplicatePath, text: "Office rent is 1300 now." },
        { chunkIndex: 0, embedding: unit(0.8), file: duplicatePath, text: "Office rent reminder." }
      ],
      mtimeMs: 1,
      path: duplicatePath
    };
    const stale = await noteFile("rent-stale.md", "I used to pay office rent 1200; no longer current.", unit(0.7));
    const files = [duplicate, stale];
    const common = {
      conflictAwareSelection: true,
      embedFn,
      embedModel: "test-embed",
      indexFiles: files,
      json: true,
      notesDir: dir,
      onStderr: () => {},
      query: "office rent",
      scope: undefined,
      topK: 1
    } as const;
    const baseline = await retrieveAndRankNotes(common);
    let rerankCalls = 0;
    const pairAware = await retrieveAndRankNotes({
      ...common,
      rerankFn: Object.assign(async () => {
        rerankCalls += 1;
        return { httpAttempts: 1, order: [0, 1], outcome: "success" } as const;
      }, { mode: "correction-pair" as const })
    });

    expect(rerankCalls).toBe(0);
    expect(JSON.stringify(pairAware)).toBe(JSON.stringify(baseline));
  });

  it("keeps invalid or absent pair hints byte-equivalent to ranking-only selection", async () => {
    const stale = await noteFile("rent-stale.md", "I used to pay office rent 1200; no longer current.", unit(0.95));
    const noise = await noteFile("agenda.md", "Tuesday meeting agenda.", unit(0.9));
    const current = await noteFile("rent-current.md", "Office rent is 1300 now.", unit(0.4));
    const tail = await noteFile("tail.md", "Unrelated archive.", unit(0.3));
    const files = [stale, noise, current, tail];
    const run = (hintBuilder?: (currentIndex: number, staleIndex: number) => unknown, omitCurrentFromOrder = false) => retrieveAndRankNotes({
      conflictAwareSelection: false,
      embedFn, embedModel: "test-embed", indexFiles: files, json: true, notesDir: dir,
      onStderr: () => {}, query: "what is the office rent", rerankFn: async (_query, texts) => {
        const staleIndex = texts.findIndex((text) => text.includes("used to pay"));
        const currentIndex = texts.findIndex((text) => text.includes("1300 now"));
        const execution = {
          httpAttempts: 1,
          order: [staleIndex, texts.findIndex((text) => text.includes("meeting agenda")), ...(omitCurrentFromOrder ? [] : [currentIndex])],
          outcome: "success",
          ...(hintBuilder ? { pairHints: hintBuilder(currentIndex, staleIndex) } : {})
        };
        return execution as RecallRerankExecution;
      }, scope: undefined, topK: 3
    });

    const baseline = await run();
    const variants = [
      await run((currentIndex, staleIndex) => [{ current: currentIndex, stale: staleIndex, unknown: true }]),
      await run(() => [{ current: 99, stale: 0 }]),
      await run((currentIndex) => [{ current: currentIndex, stale: currentIndex }]),
      await run((currentIndex, staleIndex) => [{ current: staleIndex, stale: currentIndex }]),
      await run((currentIndex, staleIndex) => [{ current: currentIndex, stale: staleIndex }], true)
    ];
    for (const result of variants) expect(result).toEqual(baseline);
  });

  it("keeps a wider rerank candidate window when adaptive gap-cut would stop at topK", async () => {
    const files = [
      await noteFile("dominant.md", "dominant cosine distractor", unit(0.99)),
      await noteFile("answer-after-gap.md", "the corrected answer lives after the score gap", unit(0.2)),
      ...await Promise.all(Array.from({ length: 5 }, (_value, index) =>
        noteFile(`tail-${index.toString()}.md`, `unrelated tail ${index.toString()}`, unit(0.1 - index * 0.01))))
    ];
    let sawTexts: readonly string[] = [];
    const result = await ask(files, async (_query, texts) => {
      sawTexts = texts;
      return [texts.findIndex((text) => text.includes("corrected answer"))];
    });

    expect(sawTexts.length).toBeGreaterThan(1);
    expect(result.rerankDecision?.eligible).toBe(true);
    expect(result.scored[0]?.file).toBe(files[1]!.path);
  });

  it("a throwing or empty reranker fails open to the cosine ordering", async () => {
    const files = await vault();
    const thrown = await ask(files, async () => { throw new Error("model down"); });
    expect(thrown.scored[0]?.file).toBe(files[0]!.path);
    const empty = await ask(files, async () => undefined);
    expect(empty.scored[0]?.file).toBe(files[0]!.path);
  });

  it("out-of-range indices from the model are discarded, not crashed on", async () => {
    const files = await vault();
    const result = await ask(files, async () => [99, -3, 1]);
    expect(result.scored[0]?.file).toBe(files[1]!.path);
  });

  it("no rerankFn → unchanged single-topK behavior", async () => {
    const files = await vault();
    const result = await ask(files);
    expect(result.scored[0]?.file).toBe(files[0]!.path);
    expect(result.scored).toHaveLength(1);
  });
});
