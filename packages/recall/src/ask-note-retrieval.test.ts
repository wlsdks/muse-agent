import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { retrieveAndRankNotes, type RecallRerankExecution, type RecallRerankFn, type RecallRerankPairHint } from "./ask-note-retrieval.js";
import type { FileEntry } from "./chunks.js";
import { detectStaleMarker } from "./conflict.js";

let dir: string;

async function noteFile(name: string, text: string, embedding: number[]): Promise<FileEntry> {
  const path = join(dir, name);
  await writeFile(path, text);
  return { chunks: [{ chunkIndex: 0, embedding, file: path, text }], path };
}

const embedFn = async (): Promise<number[]> => [1, 0];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ask-note-retrieval-"));
  await mkdir(dir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
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

  it("gives an explicit pair-aware reranker a bounded 20-candidate window so a pair beyond legacy topK+4 remains available", async () => {
    const files = await Promise.all(Array.from({ length: 30 }, async (_value, index) => {
      const score = index < 10 ? 0.99 - index * 0.01 : 0.3 - index * 0.005;
      if (index === 7) return noteFile("rent-current-deep.md", "Office rent is 1300 now.", unit(score));
      if (index === 8) return noteFile("rent-stale-deep.md", "I used to pay office rent 1200; no longer current.", unit(score));
      return noteFile(`noise-${index.toString()}.md`, `Unrelated archive ${index.toString()}.`, unit(score));
    }));
    let candidateCount = 0;
    const rerankFn = Object.assign(async (_query: string, texts: readonly string[]): Promise<RecallRerankExecution> => {
      candidateCount = texts.length;
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
      embedFn, embedModel: "test-embed", indexFiles: files, json: true, notesDir: dir,
      onStderr: () => {}, query: "???", rerankFn, scope: undefined, topK: 3
    });

    expect(candidateCount).toBe(20);
    expect(conflictOnly.scored.map((item) => item.file)).not.toContain(files[7]!.path);
    expect(conflictOnly.scored.map((item) => item.file)).not.toContain(files[8]!.path);
    expect(result.scored.map((item) => item.file)).toEqual([files[7]!.path, conflictOnly.scored[0]!.file, files[8]!.path]);
  });

  it("reserves bounded stale-marker coverage when the target stale note falls outside the diversified top 20", async () => {
    const files = await Promise.all(Array.from({ length: 30 }, async (_value, index) => {
      const score = 0.99 - index * 0.015;
      if (index === 4) return noteFile("target-current.md", "Office rent is 1300 now.", unit(score));
      if (index === 27) return noteFile("target-stale.md", "I used to pay office rent 1200; no longer current.", unit(score));
      if (index === 1 || (index >= 10 && index <= 17)) return noteFile(`other-stale-${index.toString()}.md`, `Archive ${index.toString()} used to be active; no longer current.`, unit(score));
      return noteFile(`coverage-noise-${index.toString()}.md`, `Unrelated archive ${index.toString()}.`, unit(score));
    }));
    let targetAvailable = false;
    let partitioned = false;
    const rerankFn = Object.assign(async (_query: string, texts: readonly string[]): Promise<RecallRerankExecution> => {
      const current = texts.findIndex((text) => text.includes("1300 now"));
      const stale = texts.findIndex((text) => text.includes("used to pay"));
      targetAvailable = current >= 0 && stale >= 0;
      partitioned = texts.slice(0, 10).every((text) => !detectStaleMarker(text))
        && texts.slice(10).every((text) => detectStaleMarker(text));
      return { httpAttempts: 1, order: texts.map((_text, index) => index), outcome: "success", pairHints: [{ current, stale }] };
    }, { mode: "correction-pair" as const });

    const result = await retrieveAndRankNotes({
      conflictAwareSelection: true,
      embedFn, embedModel: "test-embed", indexFiles: files, json: true, notesDir: dir,
      onStderr: () => {}, query: "???", rerankFn, scope: undefined, topK: 3
    });

    expect(targetAvailable).toBe(true);
    expect(partitioned).toBe(true);
    expect(result.scored[0]?.file).toBe(files[4]!.path);
    expect(result.scored.map((item) => item.file)).toContain(files[27]!.path);
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
    }
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
