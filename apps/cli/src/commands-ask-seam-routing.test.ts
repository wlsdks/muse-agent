/**
 * Proves `muse ask`'s PLAIN path (no --with-tools / --image / --file / --url /
 * --clipboard) actually routes its context-assembly → generation → citation
 * gate through `runGroundedRecall`'s seam (`streamGroundedRecall`) rather than
 * a parallel hand-maintained copy. `@muse/recall`'s `streamGroundedRecall` is
 * replaced with a fake that yields a recognizable marker answer no REAL model
 * call could produce; the CLI printing that marker is possible ONLY if the
 * plain path's generation+gate step is the seam call, not the legacy inline
 * `assembly.modelProvider.stream(...)` + hand-rolled citation gate.
 *
 * This is the ask→seam retrofit's regression guard: reverting the swap (the
 * legacy inline path never calls `streamGroundedRecall`) fails this test —
 * verified RED→GREEN during the retrofit itself (see the worker's report).
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SEAM_MARKER_ANSWER = "SEAM-MARKER-ANSWER — this text only reaches stdout via the mocked streamGroundedRecall.";
const SEAM_FAULT_MESSAGE = "SEAM-FAULT — injected to prove a seam-side failure propagates out of the plain path";
const RERANK_PLUMBING = vi.hoisted(() => {
  const rerankFn = vi.fn(async () => [0]);
  const retrievalSnapshot = { identity: { test: "first-retrieval" }, rerankFn, result: { scored: [] } };
  return { rerankFn, retrievalSnapshot };
});

async function* defaultFakeSeam(): AsyncGenerator<unknown> {
  yield { groundedChunkCount: 0, notesUnavailable: false, scored: [], type: "retrieval" as const, verdict: "none" as const };
  yield { text: SEAM_MARKER_ANSWER, type: "answer-delta" as const };
  yield {
    result: {
      answer: SEAM_MARKER_ANSWER,
      citations: [],
      groundedChunkCount: 0,
      notesUnavailable: false,
      preRefusalStrippedCitations: [],
      refusal: false,
      scored: [],
      strippedCitations: [],
      verdict: "none" as const
    },
    type: "result" as const
  };
}

vi.mock("@muse/recall", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@muse/recall")>();
  return {
    ...actual,
    prepareGroundedRecall: vi.fn(async () => ({ allowedNotes: [], notesUnavailable: false, scored: [], systemPrompt: "prepared", verdict: "none" as const })),
    streamGroundedRecall: vi.fn(defaultFakeSeam)
  };
});

vi.mock("./ask-note-retrieval.js", () => ({
  createRecallRerankFn: vi.fn(() => { throw new Error("commands-ask must let retrieveAndRankNotes own the reranker binding"); }),
  retrieveAndRankNotes: vi.fn(async () => ({
    notesUnavailable: false,
    preGapScored: [],
    queryVec: [1, 0, 0],
    scored: [],
    snapshot: RERANK_PLUMBING.retrievalSnapshot,
    splitClauses: [],
    subqueryEmbeddings: []
  }))
}));

vi.mock("./embed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./embed.js")>();
  return { ...actual, embed: async () => [1, 0, 0] };
});

const FAKE_MODEL_PROVIDER = {
  generate: async () => ({ output: "" }),
  id: "diagnostic",
  stream: (): AsyncIterable<unknown> => ({
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.reject(new Error("the plain path must never reach the real modelProvider.stream() — it goes through the seam"))
    })
  })
};

vi.mock("@muse/autoconfigure", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@muse/autoconfigure")>();
  return {
    ...actual,
    createMuseRuntimeAssembly: () => ({
      agentRuntime: undefined,
      defaultModel: "diagnostic/fake",
      modelProvider: FAKE_MODEL_PROVIDER,
      userMemoryStore: { findByUserId: () => undefined }
    })
  };
});

const { registerAskCommand } = await import("./commands-ask.js");

let home: string;
let originalHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "muse-ask-seam-routing-"));
  originalHome = process.env.HOME;
  process.env.HOME = home;
  const museDir = join(home, ".muse");
  await mkdir(museDir, { recursive: true });
  await mkdir(join(museDir, "notes"), { recursive: true });
  const { DEFAULT_EMBED_MODEL } = await import("./embed-model-default.js");
  await writeFile(
    join(museDir, "notes-index.json"),
    JSON.stringify({ builtAtIso: new Date().toISOString(), files: [], model: DEFAULT_EMBED_MODEL, version: 1 })
  );
});

afterEach(() => {
  process.env.HOME = originalHome;
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe("muse ask (plain path) routes through runGroundedRecall's seam", () => {
  it("prints the seam's answer, not anything the legacy inline generation could have produced", async () => {
    let stdout = "";
    const io = {
      stderr: () => undefined,
      stdout: (text: string) => { stdout += text; },
      workspaceDir: home
    };
    const program = new Command();
    registerAskCommand(program, io as unknown as Parameters<typeof registerAskCommand>[1]);

    await program.parseAsync(["node", "muse", "ask", "--model", "diagnostic/fake", "--no-auto-reindex", "what is my VPN MTU?"]);

    expect(stdout).toContain(SEAM_MARKER_ANSWER);
  });

  it("passes the exact selected reranker and first-retrieval snapshot into the plain stream seam", async () => {
    const recall = await import("@muse/recall");
    const noteRetrieval = await import("./ask-note-retrieval.js");
    const io = { stderr: () => undefined, stdout: () => undefined, workspaceDir: home };
    const program = new Command();
    registerAskCommand(program, io as unknown as Parameters<typeof registerAskCommand>[1]);

    await program.parseAsync(["node", "muse", "ask", "--model", "diagnostic/fake", "--no-auto-reindex", "what is my VPN MTU?"]);

    const seamInput = vi.mocked(recall.streamGroundedRecall).mock.calls.at(-1)?.[0];
    expect(seamInput?.runtime.rerankFn).toBe(RERANK_PLUMBING.rerankFn);
    expect(seamInput?.runtime.prepareTemporalClaimContext).toEqual(expect.any(Function));
    expect(seamInput?.retrievalSnapshot).toBe(RERANK_PLUMBING.retrievalSnapshot);
    expect(noteRetrieval.createRecallRerankFn).not.toHaveBeenCalled();
    expect(noteRetrieval.retrieveAndRankNotes).toHaveBeenCalledWith(
      expect.not.objectContaining({ rerankFn: expect.anything() }),
      expect.objectContaining({ env: expect.any(Object) })
    );
  });

  it("passes the same reranker and first-retrieval snapshot into the with-tools prepare seam", async () => {
    const recall = await import("@muse/recall");
    const io = { stderr: () => undefined, stdout: () => undefined, workspaceDir: home };
    const program = new Command();
    registerAskCommand(program, io as unknown as Parameters<typeof registerAskCommand>[1]);

    await program.parseAsync(["node", "muse", "ask", "--with-tools", "--model", "diagnostic/fake", "--no-auto-reindex", "what is my VPN MTU?"]);

    const prepareInput = vi.mocked(recall.prepareGroundedRecall).mock.calls.at(-1)?.[0];
    expect(prepareInput?.rerankFn).toBe(RERANK_PLUMBING.rerankFn);
    expect(prepareInput?.retrievalSnapshot).toBe(RERANK_PLUMBING.retrievalSnapshot);
    expect(prepareInput?.prepareTemporalClaimContext).toEqual(expect.any(Function));
  });

  it("a fault raised inside the seam propagates out of the plain path (not silently swallowed)", async () => {
    const recall = await import("@muse/recall");
    vi.mocked(recall.streamGroundedRecall).mockImplementationOnce(async function* () {
      if ((globalThis as { never?: true }).never) yield undefined as never;
      throw new Error(SEAM_FAULT_MESSAGE);
    });

    let stderr = "";
    const io = {
      stderr: (text: string) => { stderr += text; },
      stdout: () => undefined,
      workspaceDir: home
    };
    const program = new Command();
    registerAskCommand(program, io as unknown as Parameters<typeof registerAskCommand>[1]);

    await program.parseAsync(["node", "muse", "ask", "--model", "diagnostic/fake", "--no-auto-reindex", "what is my VPN MTU?"]);

    expect(stderr).toContain(SEAM_FAULT_MESSAGE);
    expect(process.exitCode).toBe(1);
  });
});
