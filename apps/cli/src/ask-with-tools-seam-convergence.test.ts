/**
 * Byte-diff regression lock for the `muse ask --with-tools` seam convergence
 * (ask→seam retrofit, Slice 2): `--with-tools` used to build its own inline
 * dedup→reorder→demoteStale→CRAG-framing→context-block pipeline in
 * `ask-context-assembly.ts` (captured below, verbatim, from `git show HEAD` at
 * the commit that preceded the retrofit — see the commit that removed the
 * `if (options.withTools) { ... }` block from `assembleAskContext`). It now
 * gets the SAME work from `@muse/recall`'s `prepareGroundedRecall`. This test
 * proves the two are byte-identical over a fixed fixture: the OLD algorithm
 * (reproduced here from real `@muse/recall`/`@muse/agent-core` primitives,
 * never re-implemented by hand) vs. the NEW `prepareGroundedRecall` call
 * `commands-ask.ts`'s `--with-tools` branch now makes.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectEvidenceContradictions, reorderForLongContext } from "@muse/agent-core";
import {
  buildNoteContextBlock,
  cosine,
  dedupNearDuplicateChunks,
  demoteStale,
  loadIndex,
  notesGroundingFraming,
  NOTES_INDEX_SCHEMA_VERSION,
  prepareGroundedRecall,
  relativizeNoteSource,
  retrieveAndRankNotes,
  type ScoredChunk
} from "@muse/recall";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildAskSystemPrompt } from "./ask-system-prompt.js";

const EMBED_MODEL = "test-embedder";
const QUERY = "what is my VPN MTU";

async function fakeEmbed(text: string): Promise<number[]> {
  if (/vpn|mtu|wireguard/iu.test(text)) return [1, 0, 0];
  if (/rent|1450|25th/iu.test(text)) return [0, 1, 0];
  if (/dentist|tuesday/iu.test(text)) return [0, 0, 1];
  return [0.34, 0.33, 0.33];
}
async function throwingEmbed(): Promise<number[]> {
  throw new Error("embed endpoint down");
}

let dir: string;
let notesDir: string;
let indexFile: string;

async function writeFixtureIndex(): Promise<void> {
  const vpnFile = join(notesDir, "vpn.md");
  const rentFile = join(notesDir, "rent.md");
  const dentistFile = join(notesDir, "dentist.md");
  await writeFile(vpnFile, "WireGuard VPN MTU is 1380 on the home network.");
  await writeFile(rentFile, "Rent is due on the 25th, $1450.");
  await writeFile(dentistFile, "Dentist appointment Tuesday at 3pm.");
  const index = {
    builtAtIso: new Date().toISOString(),
    files: [
      { chunks: [{ chunkIndex: 0, embedding: [1, 0, 0], file: vpnFile, text: "WireGuard VPN MTU is 1380 on the home network." }], mtimeMs: 1, path: vpnFile },
      { chunks: [{ chunkIndex: 0, embedding: [0, 1, 0], file: rentFile, text: "Rent is due on the 25th, $1450." }], mtimeMs: 1, path: rentFile },
      { chunks: [{ chunkIndex: 0, embedding: [0, 0, 1], file: dentistFile, text: "Dentist appointment Tuesday at 3pm." }], mtimeMs: 1, path: dentistFile }
    ],
    model: EMBED_MODEL,
    version: NOTES_INDEX_SCHEMA_VERSION
  };
  await writeFile(indexFile, JSON.stringify(index));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-ask-withtools-convergence-"));
  notesDir = join(dir, "notes");
  indexFile = join(dir, "notes-index.json");
  await mkdir(notesDir, { recursive: true });
  await writeFixtureIndex();
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

/**
 * The PRE-RETROFIT `assembleAskContext`'s `if (options.withTools) { ... }`
 * body, transcribed verbatim from `git show HEAD:apps/cli/src/ask-context-assembly.ts`
 * at the commit before this refactor (real primitives, not re-implemented).
 */
async function oldWithToolsContextAndFraming(
  embedFn: (text: string, model: string) => Promise<number[]>
): Promise<{ readonly contextBlock: string; readonly notesFraming: { readonly verdict: "confident" | "ambiguous" | "none"; readonly header: string; readonly guidance?: string } }> {
  const index = await loadIndex(indexFile);
  const retrieval = await retrieveAndRankNotes({
    embedFn,
    embedModel: EMBED_MODEL,
    indexFiles: index?.files ?? [],
    json: true,
    notesDir,
    onStderr: () => {},
    query: QUERY,
    scope: undefined,
    topK: 3
  });
  const notesUnavailable = retrieval.notesUnavailable;
  const scored: readonly ScoredChunk[] = dedupNearDuplicateChunks(retrieval.scored, cosine);
  const contextChunks = demoteStale(reorderForLongContext(scored), (c) => c.chunk.text);
  const notesFraming = notesGroundingFraming(scored, QUERY, retrieval.preGapScored.length > 0 ? retrieval.preGapScored : undefined, EMBED_MODEL);
  const noteContradictions = notesUnavailable || contextChunks.length < 2
    ? []
    : await detectEvidenceContradictions(
        contextChunks.map((r) => ({ score: r.score, source: relativizeNoteSource(r.file, notesDir), text: r.chunk.text })),
        (t) => embedFn(t, EMBED_MODEL)
      ).catch(() => []);
  const contextBlock = notesUnavailable
    ? "(notes search unavailable this turn — answer from the other grounding sources)"
    : contextChunks.length === 0
      ? "(no relevant notes found)"
      : buildNoteContextBlock(contextChunks, noteContradictions, notesDir, undefined);
  return { contextBlock, notesFraming };
}

const BASE_SYSTEM_PROMPT_PARAMS = {
  actionBlock: "",
  browsingBlock: "",
  browsingHits: [],
  calendarBlock: "",
  contactBlock: "",
  episodeBlock: "",
  episodeHits: [],
  feedBlock: "",
  feedHeadlines: [],
  gitBlock: "",
  matchedActions: [],
  matchedCommands: [],
  matchedCommits: [],
  matchedContacts: [],
  matchedMemories: [],
  memoryBlock: "",
  openTasks: [],
  pendingReminders: [],
  personaPrompt: undefined,
  personaTemplatePreamble: "",
  reflectionBlock: "",
  reflectionLines: [],
  reminderBlock: "",
  shellBlock: "",
  taskBlock: "",
  upcomingEvents: [],
  withTools: true
} as const;

describe("muse ask --with-tools seam convergence — byte-diff vs the pre-retrofit inline pipeline", () => {
  it("non-notesUnavailable: prepareGroundedRecall's contextBlock/framing/systemPrompt are byte-identical to the OLD inline withTools pipeline", async () => {
    const old = await oldWithToolsContextAndFraming(fakeEmbed);

    let newContextBlock = "";
    // `composeSystemPrompt`'s `framing` arg carries only header/guidance — the
    // resolved verdict comes back separately on `prepared.verdict` (see
    // `PreparedGroundedRecall`), so reassemble the full framing shape from both.
    let newFramingHeaderGuidance: { readonly header: string; readonly guidance?: string } = { header: "" };
    const prepared = await prepareGroundedRecall({
      embedFn: fakeEmbed,
      extras: {
        composeSystemPrompt: (a) => {
          newContextBlock = a.contextBlock;
          newFramingHeaderGuidance = a.framing;
          return "";
        },
        refineChunks: true
      },
      options: { embedModel: EMBED_MODEL, topK: 3 },
      query: QUERY,
      sources: { notesDir, notesIndexFile: indexFile }
    });
    const newFraming = { ...newFramingHeaderGuidance, verdict: prepared.verdict };

    expect(newContextBlock).toEqual(old.contextBlock);
    expect(newFraming).toEqual(old.notesFraming);

    const oldSystemPrompt = buildAskSystemPrompt({ ...BASE_SYSTEM_PROMPT_PARAMS, contextBlock: old.contextBlock, notesFraming: old.notesFraming });
    const newSystemPrompt = buildAskSystemPrompt({ ...BASE_SYSTEM_PROMPT_PARAMS, contextBlock: newContextBlock, notesFraming: newFraming });
    expect(newSystemPrompt).toEqual(oldSystemPrompt);
    // Sanity: the fixture actually produced real note content, not two empty strings.
    expect(oldSystemPrompt).toContain("WireGuard VPN MTU is 1380");
  });

  it("notesUnavailable: the seam's notesUnavailableContextBlock extra reproduces commands-ask.ts's OWN dedicated string (not the generic '(no relevant notes found)')", async () => {
    const DEDICATED_STRING = "(notes search unavailable this turn — answer from the other grounding sources)";
    const old = await oldWithToolsContextAndFraming(throwingEmbed);
    expect(old.contextBlock).toBe(DEDICATED_STRING);

    let newContextBlock = "";
    await prepareGroundedRecall({
      embedFn: throwingEmbed,
      extras: {
        composeSystemPrompt: (a) => { newContextBlock = a.contextBlock; return ""; },
        notesUnavailableContextBlock: DEDICATED_STRING,
        refineChunks: true
      },
      options: { embedModel: EMBED_MODEL, topK: 3 },
      query: QUERY,
      sources: { notesDir, notesIndexFile: indexFile }
    });

    expect(newContextBlock).toBe(DEDICATED_STRING);
    expect(newContextBlock).toEqual(old.contextBlock);
  });
});
