import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MUSE_IDENTITY_CORE, SURFACE_ROLES } from "@muse/prompts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { retrieveAndRankNotes } from "./ask-note-retrieval.js";
import { loadIndex, NOTES_INDEX_SCHEMA_VERSION } from "./notes-index.js";
import { prepareGroundedRecall, runGroundedRecall, streamGroundedRecall, type GroundedRecallInput, type ScoredChunk } from "./pipeline.js";

const EMBED_MODEL = "test-embedder";

/** Deterministic embedder: vpn/mtu-ish text → e1 axis, everything else → e2 axis. */
async function fakeEmbed(text: string): Promise<number[]> {
  return /vpn|mtu|wireguard/iu.test(text) ? [1, 0, 0] : [0, 1, 0];
}

let dir: string;
let notesDir: string;
let indexFile: string;

async function writeIndex(files: ReadonlyArray<{ path: string; text: string; embedding: number[] }>): Promise<void> {
  const index = {
    builtAtIso: new Date().toISOString(),
    files: files.map((f) => ({
      chunks: [{ chunkIndex: 0, embedding: f.embedding, file: f.path, text: f.text }],
      mtimeMs: 1,
      path: f.path
    })),
    model: EMBED_MODEL,
    version: NOTES_INDEX_SCHEMA_VERSION
  };
  await writeFile(indexFile, JSON.stringify(index));
}

function input(generated: string, query = "what MTU does my VPN use?"): GroundedRecallInput {
  return {
    options: { answerModel: "test-answerer", embedModel: EMBED_MODEL, topK: 3 },
    query,
    runtime: {
      embedFn: fakeEmbed,
      generateAnswer: async () => generated
    },
    sources: { notesDir, notesIndexFile: indexFile }
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "recall-pipeline-"));
  notesDir = join(dir, "notes");
  indexFile = join(dir, "notes-index.json");
  const vpnNote = join(notesDir, "vpn.md");
  await mkdir(notesDir, { recursive: true });
  await writeFile(vpnNote, "WireGuard VPN MTU is 1380 on the home network.");
  await writeIndex([{ embedding: [1, 0, 0], path: vpnNote, text: "WireGuard VPN MTU is 1380 on the home network." }]);
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("runGroundedRecall — the grounded-recall seam", () => {
  it("a direct caller without a snapshot runs its reranker once and exposes that selection", async () => {
    const files = [
      { embedding: [0.95, Math.sqrt(1 - 0.95 ** 2), 0], path: join(notesDir, "vpn-overview.md"), text: "VPN overview and routing notes." },
      { embedding: [0.9, Math.sqrt(1 - 0.9 ** 2), 0], path: join(notesDir, "vpn-answer.md"), text: "WireGuard VPN MTU is 1380." },
      { embedding: [0.85, Math.sqrt(1 - 0.85 ** 2), 0], path: join(notesDir, "vpn-noise.md"), text: "VPN meeting agenda." }
    ];
    for (const file of files) await writeFile(file.path, file.text);
    await writeIndex(files);
    let rerankCalls = 0;
    const result = await runGroundedRecall({
      ...input("The MTU is 1380. [from vpn-answer.md]"),
      options: { answerModel: "test-answerer", embedModel: EMBED_MODEL, topK: 1 },
      runtime: {
        embedFn: fakeEmbed,
        generateAnswer: async () => "The MTU is 1380. [from vpn-answer.md]",
        rerankFn: async (_query, texts) => {
          rerankCalls += 1;
          return [texts.findIndex((text) => text.includes("1380"))];
        }
      }
    });
    expect(rerankCalls).toBe(1);
    expect(result.scored.map((item) => item.file)).toEqual([files[1]!.path]);
  });

  it("a grounded answer keeps its real citation, verdict confident, receipts rendered", async () => {
    const result = await runGroundedRecall(input("Your VPN MTU is 1380. [from vpn.md]"));
    expect(result.answer).toContain("[from vpn.md]");
    expect(result.citations).toEqual(["vpn.md"]);
    expect(result.strippedCitations).toEqual([]);
    expect(result.verdict).toBe("confident");
    expect(result.refusal).toBe(false);
    expect(result.receipts).toContain("vpn.md");
    expect(result.groundedChunkCount).toBe(1);
  });

  it("a fabricated citation is removed by code, never surfaced (fabrication=0)", async () => {
    const result = await runGroundedRecall(input("Your VPN MTU is 1380. [from vpn.md] Your router password is hunter2. [from router-secrets.md]"));
    expect(result.answer).not.toContain("router-secrets.md");
    expect(result.strippedCitations).toContain("router-secrets.md");
    expect(result.citations).toEqual(["vpn.md"]);
  });

  it("an honest abstention never carries a citation — a spuriously attached one is stripped", async () => {
    const result = await runGroundedRecall(input("I'm not sure — your notes don't say. [from vpn.md]"));
    expect(result.refusal).toBe(true);
    expect(result.citations).toEqual([]);
    expect(result.answer).not.toContain("[from");
  });

  it("an empty / missing index degrades to zero grounding — no citation can survive", async () => {
    await rm(indexFile, { force: true });
    const result = await runGroundedRecall(input("The MTU is 1380. [from vpn.md]", "what MTU?"));
    expect(result.groundedChunkCount).toBe(0);
    expect(result.verdict).toBe("none");
    expect(result.citations).toEqual([]);
    expect(result.strippedCitations).toContain("vpn.md");
    expect(result.answer).not.toContain("[from vpn.md]");
  });

  it("an index built by a DIFFERENT embed model contributes nothing (cross-model cosine is meaningless)", async () => {
    const raw = JSON.parse(await readFile(indexFile, "utf8")) as { model: string };
    raw.model = "some-other-embedder";
    await writeFile(indexFile, JSON.stringify(raw));
    const result = await runGroundedRecall(input("Anything. [from vpn.md]"));
    expect(result.groundedChunkCount).toBe(0);
    expect(result.citations).toEqual([]);
  });

  it("the system prompt carries the citation contract and the retrieved note", async () => {
    let seenSystem = "";
    const in1 = input("ok");
    await runGroundedRecall({
      ...in1,
      runtime: {
        embedFn: fakeEmbed,
        generateAnswer: async ({ system }) => {
          seenSystem = system;
          return "ok";
        }
      }
    });
    expect(seenSystem).toContain("cite ONLY a source shown in the context below");
    expect(seenSystem).toContain("[from vpn.md]");
    expect(seenSystem).toContain("WireGuard VPN MTU is 1380");
  });
});

describe("runGroundedRecall — extras (the ask→seam retrofit enabling slice)", () => {
  it("extras-free callers get a BYTE-IDENTICAL result to passing extras: {} (the API/MCP shape)", async () => {
    const bare = await runGroundedRecall(input("Your VPN MTU is 1380. [from vpn.md]"));
    const withEmptyExtras = await runGroundedRecall({ ...input("Your VPN MTU is 1380. [from vpn.md]"), extras: {} });
    expect(withEmptyExtras).toEqual(bare);
  });

  it("extra context sections render after the notes block, in caller order, and drop when absent/blank", async () => {
    let seenSystem = "";
    await runGroundedRecall({
      ...input("ok"),
      extras: {
        contextSections: [
          { body: "Buy milk (due tomorrow)", footer: "=== END TASKS ===", header: "=== TASKS ===", present: true },
          { body: "should never appear", footer: "=== END HIDDEN ===", header: "=== HIDDEN ===", present: false },
          { body: "   ", footer: "=== END BLANK ===", header: "=== BLANK ===", present: true },
          { body: "Team sync at 3pm", footer: "=== END CALENDAR ===", header: "=== CALENDAR ===", present: true }
        ]
      },
      runtime: {
        embedFn: fakeEmbed,
        generateAnswer: async ({ system }) => {
          seenSystem = system;
          return "ok";
        }
      }
    });
    expect(seenSystem).not.toContain("HIDDEN");
    expect(seenSystem).not.toContain("BLANK");
    const notesIdx = seenSystem.indexOf("WireGuard VPN MTU is 1380");
    const tasksIdx = seenSystem.indexOf("=== TASKS ===");
    const tasksBodyIdx = seenSystem.indexOf("Buy milk (due tomorrow)");
    const calendarIdx = seenSystem.indexOf("=== CALENDAR ===");
    expect(notesIdx).toBeGreaterThan(-1);
    expect(tasksIdx).toBeGreaterThan(notesIdx);
    expect(tasksBodyIdx).toBeGreaterThan(tasksIdx);
    expect(calendarIdx).toBeGreaterThan(tasksBodyIdx);
  });

  it("FAIL-CLOSE: an extra-category citation the caller never declared is stripped exactly like a fabricated note citation", async () => {
    const result = await runGroundedRecall(
      input("Buy milk tomorrow [task: Buy milk]. Your VPN MTU is 1380 [from vpn.md].")
    );
    expect(result.answer).not.toContain("[task:");
    expect(result.answer).not.toContain("Buy milk tomorrow");
    expect(result.strippedCitations).toContain("Buy milk");
    expect(result.citations).toEqual(["vpn.md"]);
  });

  it("a declared + listed extra citation SURVIVES the gate", async () => {
    const result = await runGroundedRecall({
      ...input("Buy milk tomorrow [task: Buy milk]. Your VPN MTU is 1380 [from vpn.md]."),
      extras: { allowedCitations: { tasks: ["Buy milk"] } }
    });
    expect(result.answer).toContain("[task: Buy milk]");
    expect(result.answer).toContain("Buy milk tomorrow");
    expect(result.strippedCitations).not.toContain("Buy milk");
  });

  it("a declared category still fail-closes a source NOT in its own list", async () => {
    const result = await runGroundedRecall({
      ...input("Walk the dog [task: Walk the dog]. Your VPN MTU is 1380 [from vpn.md]."),
      extras: { allowedCitations: { tasks: ["Buy milk"] } }
    });
    expect(result.answer).not.toContain("Walk the dog");
    expect(result.strippedCitations).toContain("Walk the dog");
  });

  it("an honest abstention strips an extra citation too — a refusal never carries ANY citation", async () => {
    const result = await runGroundedRecall({
      ...input("I'm not sure — your notes don't say. [task: Buy milk]"),
      extras: { allowedCitations: { tasks: ["Buy milk"] } }
    });
    expect(result.refusal).toBe(true);
    expect(result.answer).not.toContain("[task:");
  });

  it("refineChunks OFF (default) leaves chunk order untouched — the extras-free byte-identical proof, with 2 chunks", async () => {
    const staleFile = join(notesDir, "rent_old.md");
    const freshFile = join(notesDir, "rent_new.md");
    await writeFile(staleFile, "예전에 rent was 100. 지금은 아니다.");
    await writeFile(freshFile, "rent is currently 200.");
    await writeIndex([
      { embedding: [1, 0], path: staleFile, text: "예전에 rent was 100. 지금은 아니다." },
      { embedding: [0.6, 0.8], path: freshFile, text: "rent is currently 200." }
    ]);
    const rentEmbed = async (text: string): Promise<number[]> => (/rent|100|200/iu.test(text) ? [1, 0] : [0, 1]);
    const buildInput = (extras: GroundedRecallInput["extras"]): GroundedRecallInput => ({
      extras,
      options: { answerModel: "test-answerer", embedModel: EMBED_MODEL, topK: 2 },
      query: "what is the rent",
      runtime: { embedFn: rentEmbed, generateAnswer: async () => "ok" },
      sources: { notesDir, notesIndexFile: indexFile }
    });
    const off = await runGroundedRecall(buildInput(undefined));
    const offViaEmptyExtras = await runGroundedRecall(buildInput({}));
    expect(offViaEmptyExtras).toEqual(off);
  });

  it("refineChunks ON: reorderForLongContext's raw-cosine re-sort is corrected by the SECOND demoteStale pass (current chunk cited first)", async () => {
    const staleFile = join(notesDir, "rent_old.md");
    const freshFile = join(notesDir, "rent_new.md");
    await writeFile(staleFile, "예전에 rent was 100. 지금은 아니다.");
    await writeFile(freshFile, "rent is currently 200.");
    // stale scores HIGHER than fresh against the query — the exact shape that
    // makes `reorderForLongContext` alone put the stale chunk back on top.
    await writeIndex([
      { embedding: [1, 0], path: staleFile, text: "예전에 rent was 100. 지금은 아니다." },
      { embedding: [0.6, 0.8], path: freshFile, text: "rent is currently 200." }
    ]);
    let seenSystem = "";
    await runGroundedRecall({
      extras: { refineChunks: true },
      options: { answerModel: "test-answerer", embedModel: EMBED_MODEL, topK: 2 },
      query: "what is the rent",
      runtime: {
        embedFn: async () => [1, 0],
        generateAnswer: async ({ system }) => {
          seenSystem = system;
          return "ok";
        }
      },
      sources: { notesDir, notesIndexFile: indexFile }
    });
    const freshIdx = seenSystem.indexOf("rent is currently 200");
    const staleIdx = seenSystem.indexOf("rent was 100");
    expect(freshIdx).toBeGreaterThan(-1);
    expect(staleIdx).toBeGreaterThan(-1);
    expect(freshIdx).toBeLessThan(staleIdx);
  });

  it("the result exposes the raw scored chunks a caller needs for its own downstream verdict/receipts", async () => {
    const result = await runGroundedRecall(input("Your VPN MTU is 1380. [from vpn.md]"));
    expect(result.scored).toHaveLength(1);
    expect(result.scored[0]!.file).toContain("vpn.md");
  });

  it("preRefusalStrippedCitations is the FIRST-pass-only set — a citation valid pre-refusal but stripped by the refusal pass is NOT counted twice", async () => {
    // "vpn.md" IS an allowed note, so the first (buffered) gate pass leaves it
    // untouched; only the unconditional refusal re-strip (which allows NO
    // notes) removes it. preRefusalStrippedCitations must stay empty while the
    // refusal-inclusive strippedCitations picks it up.
    const result = await runGroundedRecall(input("I'm not sure — your notes don't say. [from vpn.md]"));
    expect(result.refusal).toBe(true);
    expect(result.preRefusalStrippedCitations).toEqual([]);
    expect(result.strippedCitations).toContain("vpn.md");
  });

  it("extraChunks absent/empty is byte-identical to today (no ad-hoc grounding folded in)", async () => {
    const bare = await runGroundedRecall(input("Your VPN MTU is 1380. [from vpn.md]"));
    const withEmpty = await runGroundedRecall({ ...input("Your VPN MTU is 1380. [from vpn.md]"), extras: { extraChunks: [] } });
    expect(withEmpty).toEqual(bare);
  });

  it("extraChunks folds an ad-hoc (--file-style) passage in as note-class evidence, citable exactly like a retrieved note", async () => {
    const adHocChunk: ScoredChunk = {
      chunk: { chunkIndex: 0, embedding: [], file: "/tmp/report.pdf", text: "Q3 revenue was 4.2M." },
      file: "/tmp/report.pdf",
      score: 1
    };
    const result = await runGroundedRecall({
      ...input("Q3 revenue was 4.2M. [from report.pdf]", "what was Q3 revenue?"),
      extras: { extraChunks: [adHocChunk] }
    });
    expect(result.answer).toContain("[from report.pdf]");
    expect(result.citations).toContain("report.pdf");
    expect(result.strippedCitations).not.toContain("report.pdf");
    expect(result.notesUnavailable).toBe(false);
  });

  it("the DEFAULT composition (Phase 2+3 seam) anchors identity at position 0, then the recall role, then a single cache boundary", async () => {
    let seenSystem = "";
    await runGroundedRecall({
      ...input("ok"),
      runtime: {
        embedFn: fakeEmbed,
        generateAnswer: async ({ system }) => { seenSystem = system; return "ok"; }
      }
    });
    expect(seenSystem.startsWith(MUSE_IDENTITY_CORE)).toBe(true);
    expect(seenSystem).toContain(SURFACE_ROLES.recall);
    expect(seenSystem.split("<!-- MUSE_CACHE_BOUNDARY -->").length - 1).toBe(1);
    const boundary = seenSystem.indexOf("<!-- MUSE_CACHE_BOUNDARY -->");
    expect(seenSystem.indexOf(SURFACE_ROLES.recall)).toBeLessThan(boundary);
    expect(seenSystem.indexOf("WireGuard VPN MTU is 1380")).toBeGreaterThan(boundary);
  });

  it("composeSystemPrompt absent uses the built-in builder (byte-identical to today)", async () => {
    const bare = await runGroundedRecall(input("ok"));
    const withUndefinedHook = await runGroundedRecall({ ...input("ok"), extras: { composeSystemPrompt: undefined } });
    expect(withUndefinedHook).toEqual(bare);
  });

  it("composeSystemPrompt fully overrides the prompt text a caller's own builder needs (e.g. a persona preamble)", async () => {
    let seenSystem = "";
    await runGroundedRecall({
      ...input("ok"),
      extras: {
        composeSystemPrompt: (args) => `CUSTOM PREAMBLE\n${args.framing.header}\n${args.contextBlock}`
      },
      runtime: {
        embedFn: fakeEmbed,
        generateAnswer: async ({ system }) => {
          seenSystem = system;
          return "ok";
        }
      }
    });
    expect(seenSystem).toContain("CUSTOM PREAMBLE");
    expect(seenSystem).not.toContain("You are Muse, the user's personal AI. Answer the user's question ONLY from the context below.");
    expect(seenSystem).toContain("WireGuard VPN MTU is 1380");
  });

  it("normalizeAnswer absent is a no-op (byte-identical to today)", async () => {
    const bare = await runGroundedRecall(input("Your VPN MTU is 1380. [from vpn.md]"));
    const withUndefinedHook = await runGroundedRecall({ ...input("Your VPN MTU is 1380. [from vpn.md]"), extras: { normalizeAnswer: undefined } });
    expect(withUndefinedHook).toEqual(bare);
  });

  it("normalizeAnswer runs BEFORE the citation gate — a rewrite into a valid bracket survives, an unrewritten one would have been stripped", async () => {
    const result = await runGroundedRecall({
      ...input("Your VPN MTU is 1380. [from vpn 1]"),
      extras: { normalizeAnswer: (text) => text.replace("[from vpn 1]", "[from vpn.md]") }
    });
    expect(result.answer).toContain("[from vpn.md]");
    expect(result.strippedCitations).toEqual([]);
  });

  it("untrustedNoteSources reaches buildNoteContextBlock's conflict marker (trust-aware, not neutral)", async () => {
    const fileA = join(notesDir, "rent_a.md");
    const fileB = join(notesDir, "rent_b.md");
    await writeFile(fileA, "office rent is 100");
    await writeFile(fileB, "office rent is 200");
    await writeIndex([
      { embedding: [1, 0, 0], path: fileA, text: "office rent is 100" },
      { embedding: [1, 0, 0], path: fileB, text: "office rent is 200" }
    ]);
    const contradictingEmbed = async (): Promise<number[]> => [1, 0, 0];
    let seenSystem = "";
    await runGroundedRecall({
      extras: { untrustedNoteSources: new Set(["rent_b.md"]) },
      options: { answerModel: "test-answerer", embedModel: EMBED_MODEL, topK: 2 },
      query: "office rent",
      runtime: {
        embedFn: contradictingEmbed,
        generateAnswer: async ({ system }) => {
          seenSystem = system;
          return "ok";
        }
      },
      sources: { notesDir, notesIndexFile: indexFile }
    });
    expect(seenSystem).toContain("EXTERNAL/UNVERIFIED");
  });
});

describe("prepareGroundedRecall — the prepare-only entry point (--with-tools convergence, Slice 1)", () => {
  it("defaults production prepare retrieval to conflict-aware current/stale pair selection", async () => {
    const current = { embedding: [0.99, Math.sqrt(1 - 0.99 ** 2)], path: join(notesDir, "rent-current.md"), text: "Office rent is 1300 now." };
    const noise = { embedding: [0.98, Math.sqrt(1 - 0.98 ** 2)], path: join(notesDir, "agenda.md"), text: "Tuesday meeting agenda." };
    const stale = { embedding: [0.94, Math.sqrt(1 - 0.94 ** 2)], path: join(notesDir, "rent-old.md"), text: "I used to pay office rent 1200; no longer current." };
    for (const file of [current, noise, stale]) await writeFile(file.path, file.text);
    await writeIndex([current, noise, stale]);

    const prepared = await prepareGroundedRecall({
      embedFn: async () => [1, 0],
      options: { embedModel: EMBED_MODEL, topK: 2 },
      query: "what changed about office rent",
      rerankFn: async (_query, texts) => [
        texts.findIndex((text) => text.includes("1300 now")),
        texts.findIndex((text) => text.includes("meeting agenda"))
      ],
      sources: { notesDir, notesIndexFile: indexFile }
    });

    expect(prepared.scored.map((item) => item.file)).toEqual([current.path, stale.path]);
  });

  it("keeps no-pair and invalid correction selector prepares byte-equivalent to conflict-only", async () => {
    const files = [
      { embedding: [0.95, Math.sqrt(1 - 0.95 ** 2), 0], path: join(notesDir, "vpn-primary.md"), text: "WireGuard VPN MTU is 1380." },
      { embedding: [0.9, Math.sqrt(1 - 0.9 ** 2), 0], path: join(notesDir, "vpn-distractor.md"), text: "VPN meeting agenda." },
      { embedding: [0.85, Math.sqrt(1 - 0.85 ** 2), 0], path: join(notesDir, "vpn-tail.md"), text: "VPN routing overview." }
    ];
    for (const file of files) await writeFile(file.path, file.text);
    await writeIndex(files);
    const base = {
      embedFn: fakeEmbed,
      extras: { refineChunks: true },
      options: { embedModel: EMBED_MODEL, topK: 1 },
      query: "what MTU does my VPN use?",
      sources: { notesDir, notesIndexFile: indexFile }
    } as const;
    const conflictOnly = await prepareGroundedRecall(base);
    const runSelector = (pairHints?: readonly [{ readonly current: number; readonly stale: number }]) => prepareGroundedRecall({
      ...base,
      rerankFn: Object.assign(async (_query: string, texts: readonly string[]) => ({
        httpAttempts: 1, order: texts.map((_text, index) => index), outcome: "success" as const, ...(pairHints ? { pairHints } : {})
      }), { mode: "correction-pair" as const })
    });
    const runFailure = () => prepareGroundedRecall({
      ...base,
      rerankFn: Object.assign(async () => ({ httpAttempts: 1, outcome: "timeout" as const }), { mode: "correction-pair" as const })
    });

    const baselineBytes = JSON.stringify(conflictOnly);
    expect(JSON.stringify(await runSelector())).toBe(baselineBytes);
    expect(JSON.stringify(await runSelector([{ current: 0, stale: 1 }]))).toBe(baselineBytes);
    expect(JSON.stringify(await runFailure())).toBe(baselineBytes);
  });

  it("reuses a matching first-retrieval snapshot without invoking the reranker twice", async () => {
    const files = [
      { embedding: [0.95, Math.sqrt(1 - 0.95 ** 2), 0], path: join(notesDir, "vpn-overview.md"), text: "VPN overview and routing notes." },
      { embedding: [0.9, Math.sqrt(1 - 0.9 ** 2), 0], path: join(notesDir, "vpn-answer.md"), text: "WireGuard VPN MTU is 1380." },
      { embedding: [0.85, Math.sqrt(1 - 0.85 ** 2), 0], path: join(notesDir, "vpn-noise.md"), text: "VPN meeting agenda." }
    ];
    for (const file of files) await writeFile(file.path, file.text);
    await writeIndex(files);
    const index = await loadIndex(indexFile);
    let rerankCalls = 0;
    const rerankFn = async (_query: string, texts: readonly string[]) => {
      rerankCalls += 1;
      return [texts.findIndex((text) => text.includes("1380"))];
    };
    const first = await retrieveAndRankNotes({
      conflictAwareSelection: true, embedFn: fakeEmbed, embedModel: EMBED_MODEL, indexFiles: index?.files ?? [], json: true, notesDir,
      onStderr: () => {}, query: "what MTU does my VPN use?", rerankFn, scope: undefined,
      snapshotIdentity: { indexBuiltAtIso: index?.builtAtIso ?? "", notesIndexFile: indexFile }, topK: 1
    });
    expect(rerankCalls).toBe(1);

    const prepared = await prepareGroundedRecall({
      embedFn: fakeEmbed,
      options: { embedModel: EMBED_MODEL, topK: 1 },
      query: "what MTU does my VPN use?",
      rerankFn,
      retrievalSnapshot: first.snapshot,
      sources: { notesDir, notesIndexFile: indexFile }
    });

    expect(rerankCalls).toBe(1);
    expect(prepared.scored.map((item) => item.file)).toEqual(first.scored.map((item) => item.file));

    await prepareGroundedRecall({
      embedFn: fakeEmbed,
      options: { conflictAwareSelection: false, embedModel: EMBED_MODEL, topK: 1 },
      query: "what MTU does my VPN use?",
      rerankFn,
      retrievalSnapshot: first.snapshot,
      sources: { notesDir, notesIndexFile: indexFile }
    });
    expect(rerankCalls).toBe(2);
  });

  it("reuses only an exact freshly audited temporal authority", async () => {
    const files = [
      { embedding: [1, 0, 0], path: join(notesDir, "vpn.md"), text: "WireGuard VPN MTU is 1380." },
      { embedding: [0.9, 0.1, 0], path: join(notesDir, "vpn-other.md"), text: "VPN routing overview." },
      { embedding: [0.8, 0.2, 0], path: join(notesDir, "vpn-tail.md"), text: "VPN meeting notes." }
    ];
    for (const file of files) await writeFile(file.path, file.text);
    await writeIndex(files);
    const index = await loadIndex(indexFile);
    let rerankCalls = 0;
    const rerankFn = async () => { rerankCalls += 1; return [0]; };
    const authority = Object.freeze({
      chunkerVersion: "muse.notes.chunk-text.v1" as const, graphDigest: null, indexDigest: "1".repeat(64),
      rawStoreDigest: "2".repeat(64), schema: "muse.temporal-claim-snapshot-authority.v1" as const,
      sourceProvenanceDigest: null, storeRevision: 1, storeState: "empty" as const
    });
    const first = await retrieveAndRankNotes({
      conflictAwareSelection: true, embedFn: fakeEmbed, embedModel: EMBED_MODEL, indexFiles: index?.files ?? [], json: true, notesDir,
      onStderr: () => {}, query: "vpn mtu", rerankFn, scope: undefined,
      snapshotIdentity: { indexBuiltAtIso: index?.builtAtIso ?? "", notesIndexFile: indexFile },
      temporalClaimAuthority: authority, topK: 2
    });
    const base = {
      embedFn: fakeEmbed, options: { embedModel: EMBED_MODEL, topK: 2 }, query: "vpn mtu", rerankFn,
      retrievalSnapshot: first.snapshot, sources: { notesDir, notesIndexFile: indexFile }
    };
    await prepareGroundedRecall({ ...base, prepareTemporalClaimContext: async () => ({ authority }) });
    expect(rerankCalls).toBe(1);
    const replacedIndex = JSON.parse(await readFile(indexFile, "utf8")) as {
      files: Array<{ chunks: Array<{ text: string }> }>;
    };
    replacedIndex.files[0]!.chunks[0]!.text = "WireGuard VPN MTU is 1420.";
    await writeFile(indexFile, JSON.stringify(replacedIndex));
    await prepareGroundedRecall({ ...base, prepareTemporalClaimContext: async () => ({ authority }) });
    expect(rerankCalls).toBe(2);
    await prepareGroundedRecall({
      ...base,
      prepareTemporalClaimContext: async () => ({ authority: { ...authority, storeRevision: 2 } })
    });
    expect(rerankCalls).toBe(3);
  });

  it("reuses pair-aware reranker selection from the first snapshot with one logical invocation", async () => {
    const files = [
      { embedding: [0.95, Math.sqrt(1 - 0.95 ** 2)], path: join(notesDir, "rent-stale.md"), text: "I used to pay office rent 1200; no longer current." },
      { embedding: [0.9, Math.sqrt(1 - 0.9 ** 2)], path: join(notesDir, "agenda.md"), text: "Tuesday meeting agenda." },
      { embedding: [0.4, Math.sqrt(1 - 0.4 ** 2)], path: join(notesDir, "rent-current.md"), text: "Office rent is 1300 now." },
      { embedding: [0.3, Math.sqrt(1 - 0.3 ** 2)], path: join(notesDir, "tail.md"), text: "Unrelated archive." }
    ];
    for (const file of files) await writeFile(file.path, file.text);
    await writeIndex(files);
    const index = await loadIndex(indexFile);
    let rerankCalls = 0;
    const rerankFn = Object.assign(async (_query: string, texts: readonly string[]) => {
      rerankCalls += 1;
      const stale = texts.findIndex((text) => text.includes("used to pay"));
      const current = texts.findIndex((text) => text.includes("1300 now"));
      return { httpAttempts: 1, order: texts.map((_text, index) => index), outcome: "success" as const, pairHints: [{ current, stale }] };
    }, { mode: "correction-pair" as const });
    const first = await retrieveAndRankNotes({
      conflictAwareSelection: true, embedFn: async () => [1, 0], embedModel: EMBED_MODEL,
      indexFiles: index?.files ?? [], json: true, notesDir, onStderr: () => {}, query: "what is the office rent", rerankFn,
      scope: undefined, snapshotIdentity: { indexBuiltAtIso: index?.builtAtIso ?? "", notesIndexFile: indexFile }, topK: 3
    });

    const prepared = await prepareGroundedRecall({
      embedFn: async () => [1, 0], options: { embedModel: EMBED_MODEL, topK: 3 }, query: "what is the office rent",
      rerankFn, retrievalSnapshot: first.snapshot, sources: { notesDir, notesIndexFile: indexFile }
    });

    expect(first.snapshot?.identity.rerankResultHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(rerankCalls).toBe(1);
    expect(first.scored.map((item) => item.file)).toEqual([files[2]!.path, files[1]!.path, files[0]!.path]);
    expect(prepared.scored).toEqual(first.scored);
  });

  it("refinement pins only the selector-verified current identity ahead of an unrelated correction pair", async () => {
    const targetStale = { embedding: [0.95, 0, Math.sqrt(1 - 0.95 ** 2), 0, 0, 0], path: join(notesDir, "rent-stale.md"), text: "I used to pay office rent 1200; no longer current." };
    const unrelatedCurrent = { embedding: [0.99, Math.sqrt(1 - 0.99 ** 2), 0, 0, 0, 0], path: join(notesDir, "gym-current.md"), text: "The gym is on Harbor Street now." };
    const unrelatedStale = { embedding: [0.9, 0, 0, Math.sqrt(1 - 0.9 ** 2), 0, 0], path: join(notesDir, "gym-stale.md"), text: "The gym used to be on Cedar Street; no longer current." };
    const targetCurrent = { embedding: [0.4, 0, 0, 0, Math.sqrt(1 - 0.4 ** 2), 0], path: join(notesDir, "rent-current.md"), text: "Office rent is 1300 now." };
    const tail = { embedding: [0.3, 0, 0, 0, 0, Math.sqrt(1 - 0.3 ** 2)], path: join(notesDir, "tail.md"), text: "Unrelated archive." };
    const files = [targetStale, unrelatedCurrent, unrelatedStale, targetCurrent, tail];
    for (const file of files) await writeFile(file.path, file.text);
    await writeIndex(files);
    const index = await loadIndex(indexFile);
    let rerankCalls = 0;
    const rerankFn = Object.assign(async (_query: string, texts: readonly string[]) => {
      rerankCalls += 1;
      const targetStaleIndex = texts.findIndex((text) => text.includes("used to pay"));
      const targetCurrentIndex = texts.findIndex((text) => text.includes("1300 now"));
      const unrelatedCurrentIndex = texts.findIndex((text) => text.includes("Harbor Street"));
      const unrelatedStaleIndex = texts.findIndex((text) => text.includes("Cedar Street"));
      return {
        httpAttempts: 1,
        order: [unrelatedCurrentIndex, unrelatedStaleIndex, targetCurrentIndex, targetStaleIndex],
        outcome: "success" as const,
        pairHints: [{ current: targetCurrentIndex, stale: targetStaleIndex }]
      };
    }, { mode: "correction-pair" as const });
    process.env.MUSE_RECALL_GRAPH_HOP = "false";
    process.env.MUSE_RECALL_SECOND_HOP = "false";
    try {
      const first = await retrieveAndRankNotes({
        conflictAwareSelection: true,
        embedFn: async () => [1, 0, 0, 0, 0, 0],
        embedModel: EMBED_MODEL,
        indexFiles: index?.files ?? [],
        json: true,
        notesDir,
        onStderr: () => {},
        query: "what is the office rent",
        rerankFn,
        scope: undefined,
        snapshotIdentity: { indexBuiltAtIso: index?.builtAtIso ?? "", notesIndexFile: indexFile },
        topK: 4
      });

      const prepared = await prepareGroundedRecall({
        embedFn: async () => [1, 0, 0, 0, 0, 0],
        extras: { refineChunks: true },
        options: { embedModel: EMBED_MODEL, topK: 4 },
        query: "what is the office rent",
        rerankFn,
        retrievalSnapshot: first.snapshot,
        sources: { notesDir, notesIndexFile: indexFile }
      });

      expect(rerankCalls).toBe(1);
      expect(first.verifiedCorrectionPair).toEqual({
        current: { chunkIndex: 0, file: targetCurrent.path },
        stale: { chunkIndex: 0, file: targetStale.path }
      });
      expect(prepared.scored.map((item) => item.file)).toEqual([
        targetCurrent.path,
        unrelatedCurrent.path,
        unrelatedStale.path,
        targetStale.path
      ]);
    } finally {
      delete process.env.MUSE_RECALL_GRAPH_HOP;
      delete process.env.MUSE_RECALL_SECOND_HOP;
    }
  });

  it("does not substitute or pin when near-duplicate dedup removes the exact stale identity", async () => {
    const targetStale = { embedding: [0.95, Math.sqrt(1 - 0.95 ** 2)], path: join(notesDir, "rent-stale.md"), text: "I used to pay office rent 1200; no longer current." };
    const unrelatedCurrent = { embedding: [0.99, Math.sqrt(1 - 0.99 ** 2)], path: join(notesDir, "gym-current.md"), text: "The gym is on Harbor Street now." };
    const nearDuplicateStale = { embedding: [0.9, Math.sqrt(1 - 0.9 ** 2)], path: join(notesDir, "gym-stale.md"), text: "The gym used to be on Cedar Street; no longer current." };
    const targetCurrent = { embedding: [0.4, Math.sqrt(1 - 0.4 ** 2)], path: join(notesDir, "rent-current.md"), text: "Office rent is 1300 now." };
    const tail = { embedding: [-0.3, Math.sqrt(1 - 0.3 ** 2)], path: join(notesDir, "tail.md"), text: "Unrelated archive." };
    const files = [targetStale, unrelatedCurrent, nearDuplicateStale, targetCurrent, tail];
    for (const file of files) await writeFile(file.path, file.text);
    await writeIndex(files);
    const index = await loadIndex(indexFile);
    const rerankFn = Object.assign(async (_query: string, texts: readonly string[]) => {
      const targetStaleIndex = texts.findIndex((text) => text.includes("used to pay"));
      const targetCurrentIndex = texts.findIndex((text) => text.includes("1300 now"));
      const unrelatedCurrentIndex = texts.findIndex((text) => text.includes("Harbor Street"));
      const nearDuplicateStaleIndex = texts.findIndex((text) => text.includes("Cedar Street"));
      return {
        httpAttempts: 1,
        order: [unrelatedCurrentIndex, nearDuplicateStaleIndex, targetCurrentIndex, targetStaleIndex],
        outcome: "success" as const,
        pairHints: [{ current: targetCurrentIndex, stale: targetStaleIndex }]
      };
    }, { mode: "correction-pair" as const });
    process.env.MUSE_RECALL_GRAPH_HOP = "false";
    process.env.MUSE_RECALL_SECOND_HOP = "false";
    try {
      const first = await retrieveAndRankNotes({
        conflictAwareSelection: true,
        embedFn: async () => [1, 0],
        embedModel: EMBED_MODEL,
        indexFiles: index?.files ?? [],
        json: true,
        notesDir,
        onStderr: () => {},
        query: "what is the office rent",
        rerankFn,
        scope: undefined,
        snapshotIdentity: { indexBuiltAtIso: index?.builtAtIso ?? "", notesIndexFile: indexFile },
        topK: 4
      });
      const prepared = await prepareGroundedRecall({
        embedFn: async () => [1, 0],
        extras: { refineChunks: true },
        options: { embedModel: EMBED_MODEL, topK: 4 },
        query: "what is the office rent",
        rerankFn,
        retrievalSnapshot: first.snapshot,
        sources: { notesDir, notesIndexFile: indexFile }
      });

      expect(first.verifiedCorrectionPair?.stale).toEqual({ chunkIndex: 0, file: targetStale.path });
      expect(prepared.scored.map((item) => item.file)).toEqual([
        unrelatedCurrent.path,
        targetCurrent.path,
        nearDuplicateStale.path
      ]);
      expect(prepared.scored.map((item) => item.file)).not.toContain(targetStale.path);
    } finally {
      delete process.env.MUSE_RECALL_GRAPH_HOP;
      delete process.env.MUSE_RECALL_SECOND_HOP;
    }
  });

  it("rejects a snapshot whose query identity differs and performs normal retrieval", async () => {
    const files = [
      { embedding: [0.95, Math.sqrt(1 - 0.95 ** 2), 0], path: join(notesDir, "vpn-overview.md"), text: "VPN overview and routing notes." },
      { embedding: [0.9, Math.sqrt(1 - 0.9 ** 2), 0], path: join(notesDir, "vpn-answer.md"), text: "WireGuard VPN MTU is 1380." },
      { embedding: [0.85, Math.sqrt(1 - 0.85 ** 2), 0], path: join(notesDir, "vpn-noise.md"), text: "VPN meeting agenda." }
    ];
    for (const file of files) await writeFile(file.path, file.text);
    await writeIndex(files);
    const index = await loadIndex(indexFile);
    let rerankCalls = 0;
    const rerankFn = async (_query: string, texts: readonly string[]) => {
      rerankCalls += 1;
      return [texts.findIndex((text) => text.includes("1380"))];
    };
    const first = await retrieveAndRankNotes({
      embedFn: fakeEmbed, embedModel: EMBED_MODEL, indexFiles: index?.files ?? [], json: true, notesDir,
      onStderr: () => {}, query: "first query", rerankFn, scope: undefined,
      snapshotIdentity: { indexBuiltAtIso: index?.builtAtIso ?? "", notesIndexFile: indexFile }, topK: 1
    });

    await prepareGroundedRecall({
      embedFn: fakeEmbed,
      options: { embedModel: EMBED_MODEL, topK: 1 },
      query: "different query",
      rerankFn,
      retrievalSnapshot: first.snapshot,
      sources: { notesDir, notesIndexFile: indexFile }
    });

    expect(rerankCalls).toBe(2);
  });

  it("matches streamGroundedRecall's own prepare stage exactly — same systemPrompt, scored, verdict, notesUnavailable", async () => {
    const prepared = await prepareGroundedRecall({
      embedFn: fakeEmbed,
      options: { embedModel: EMBED_MODEL, topK: 3 },
      query: "what MTU does my VPN use?",
      sources: { notesDir, notesIndexFile: indexFile }
    });

    let seenRetrieval: { readonly scored: readonly ScoredChunk[]; readonly verdict: "confident" | "ambiguous" | "none"; readonly notesUnavailable: boolean } | undefined;
    let seenSystem = "";
    for await (const event of streamGroundedRecall({
      ...input("ok"),
      runtime: { embedFn: fakeEmbed, generateAnswer: async ({ system }) => { seenSystem = system; return "ok"; } }
    })) {
      if (event.type === "retrieval") seenRetrieval = event;
    }

    expect(prepared.systemPrompt).toEqual(seenSystem);
    expect(prepared.scored).toEqual(seenRetrieval?.scored);
    expect(prepared.verdict).toEqual(seenRetrieval?.verdict);
    expect(prepared.notesUnavailable).toEqual(seenRetrieval?.notesUnavailable);
  });

  it("notesUnavailableContextBlock absent ⇒ the default '(no relevant notes found)' string (byte-identical to today)", async () => {
    const throwingEmbed = async (): Promise<number[]> => { throw new Error("embed endpoint down"); };
    const prepared = await prepareGroundedRecall({
      embedFn: throwingEmbed,
      options: { embedModel: EMBED_MODEL, topK: 3 },
      query: "what MTU does my VPN use?",
      sources: { notesDir, notesIndexFile: indexFile }
    });
    expect(prepared.notesUnavailable).toBe(true);
    expect(prepared.systemPrompt).toContain("(no relevant notes found)");
  });

  it("notesUnavailableContextBlock present ⇒ replaces the contextBlock with the caller's own string", async () => {
    const throwingEmbed = async (): Promise<number[]> => { throw new Error("embed endpoint down"); };
    const prepared = await prepareGroundedRecall({
      embedFn: throwingEmbed,
      extras: { notesUnavailableContextBlock: "(notes search unavailable this turn — answer from the other grounding sources)" },
      options: { embedModel: EMBED_MODEL, topK: 3 },
      query: "what MTU does my VPN use?",
      sources: { notesDir, notesIndexFile: indexFile }
    });
    expect(prepared.notesUnavailable).toBe(true);
    expect(prepared.systemPrompt).toContain("(notes search unavailable this turn — answer from the other grounding sources)");
    expect(prepared.systemPrompt).not.toContain("(no relevant notes found)");
  });
});

describe("language mirroring in the default recall prompt", () => {
  const captureSystem = async (query: string, extras?: GroundedRecallInput["extras"]) => {
    let seenSystem = "";
    await runGroundedRecall({
      ...input("ok", query),
      ...(extras !== undefined ? { extras } : {}),
      runtime: { embedFn: fakeEmbed, generateAnswer: async ({ system }) => { seenSystem = system; return "ok"; } }
    });
    return seenSystem;
  };

  it("an English query injects the deterministic language-mirror line into the system prompt", async () => {
    expect(await captureSystem("what MTU does my VPN use?")).toContain("reply entirely in that same language");
  });

  it("a Korean query stays on the Korean default (no mirror line)", async () => {
    expect(await captureSystem("내 VPN MTU가 뭐지?")).not.toContain("reply entirely in that same language");
  });

  it("a caller composeSystemPrompt override is untouched (no injected mirror)", async () => {
    const system = await captureSystem("what MTU does my VPN use?", {
      composeSystemPrompt: (args) => `CUSTOM\n${args.contextBlock}`
    });
    expect(system.startsWith("CUSTOM")).toBe(true);
    expect(system).not.toContain("reply entirely in that same language");
  });
});
