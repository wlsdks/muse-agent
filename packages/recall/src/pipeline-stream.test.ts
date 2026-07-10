import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NOTES_INDEX_SCHEMA_VERSION } from "./notes-index.js";
import { runGroundedRecall, streamGroundedRecall, type GroundedRecallEvent, type GroundedRecallInput } from "./pipeline.js";

const EMBED_MODEL = "test-embedder";

async function fakeEmbed(text: string): Promise<number[]> {
  return /vpn|mtu|wireguard/iu.test(text) ? [1, 0, 0] : [0, 1, 0];
}

async function* chunked(parts: readonly string[]): AsyncIterable<string> {
  for (const part of parts) {
    yield part;
  }
}

let dir: string;
let notesDir: string;
let indexFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "recall-stream-"));
  notesDir = join(dir, "notes");
  indexFile = join(dir, "notes-index.json");
  await mkdir(notesDir, { recursive: true });
  const vpnNote = join(notesDir, "vpn.md");
  const text = "WireGuard VPN MTU is 1380 on the home network.";
  await writeFile(vpnNote, text);
  await writeFile(indexFile, JSON.stringify({
    builtAtIso: new Date().toISOString(),
    files: [{ chunks: [{ chunkIndex: 0, embedding: [1, 0, 0], file: vpnNote, text }], mtimeMs: 1, path: vpnNote }],
    model: EMBED_MODEL,
    version: NOTES_INDEX_SCHEMA_VERSION
  }));
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

function input(runtime: Partial<GroundedRecallInput["runtime"]>, extras?: GroundedRecallInput["extras"]): GroundedRecallInput {
  return {
    extras,
    options: { answerModel: "test-answerer", embedModel: EMBED_MODEL, topK: 3 },
    query: "what MTU does my VPN use?",
    runtime: {
      embedFn: fakeEmbed,
      generateAnswer: async () => "unused",
      ...runtime
    },
    sources: { notesDir, notesIndexFile: indexFile }
  };
}

async function collect(events: AsyncIterable<GroundedRecallEvent>): Promise<GroundedRecallEvent[]> {
  const out: GroundedRecallEvent[] = [];
  for await (const event of events) {
    out.push(event);
  }
  return out;
}

describe("streamGroundedRecall — the live-gated event stream", () => {
  it("streams retrieval first, live-gated deltas, then the authoritative result", async () => {
    const events = await collect(streamGroundedRecall(input({
      streamAnswer: () => chunked(["Your VPN MTU is 1380. ", "[from vpn.md]"])
    })));
    expect(events[0]).toMatchObject({ type: "retrieval", groundedChunkCount: 1, verdict: "confident" });
    if (events[0]!.type === "retrieval") {
      expect(events[0]!.scored).toHaveLength(1);
      expect(events[0]!.scored[0]!.file).toContain("vpn.md");
    }
    const deltas = events.filter((e) => e.type === "answer-delta").map((e) => e.text).join("");
    expect(deltas).toContain("[from vpn.md]");
    const last = events[events.length - 1]!;
    expect(last.type).toBe("result");
    if (last.type === "result") {
      expect(last.result.citations).toEqual(["vpn.md"]);
    }
  });

  it("a fabricated citation split ACROSS deltas never reaches the delta stream, even for a flash", async () => {
    const events = await collect(streamGroundedRecall(input({
      streamAnswer: () => chunked(["MTU is 1380. [from vpn.md] Password hunter2 ", "[from se", "crets.md]", " done."])
    })));
    const streamed = events.filter((e) => e.type === "answer-delta").map((e) => e.text).join("");
    expect(streamed).not.toContain("secrets.md");
    expect(streamed).toContain("[from vpn.md]");
    const last = events[events.length - 1]!;
    if (last.type === "result") {
      expect(last.result.strippedCitations).toContain("secrets.md");
      expect(last.result.answer).not.toContain("secrets.md");
    }
  });

  it("PARITY: the streamed result equals the buffered runGroundedRecall result", async () => {
    const text = "Your VPN MTU is 1380. [from vpn.md] Bogus. [from ghost.md]";
    const streamed = await collect(streamGroundedRecall(input({
      streamAnswer: () => chunked(text.split(/(?<= )/u))
    })));
    const streamedResult = streamed.find((e) => e.type === "result");
    const buffered = await runGroundedRecall(input({ generateAnswer: async () => text }));
    expect(streamedResult?.type).toBe("result");
    if (streamedResult?.type === "result") {
      expect(streamedResult.result).toEqual(buffered);
    }
  });

  it("PARITY: extras (context sections + allowed citations + refineChunks) flow through streaming and buffered identically", async () => {
    const text = "Buy milk tomorrow [task: Buy milk]. Your VPN MTU is 1380 [from vpn.md].";
    const extras: GroundedRecallInput["extras"] = {
      allowedCitations: { tasks: ["Buy milk"] },
      contextSections: [{ body: "Buy milk (due tomorrow)", footer: "=== END TASKS ===", header: "=== TASKS ===", present: true }],
      refineChunks: true
    };
    const streamed = await collect(streamGroundedRecall(input({ streamAnswer: () => chunked(text.split(/(?<= )/u)) }, extras)));
    const streamedResult = streamed.find((e) => e.type === "result");
    const buffered = await runGroundedRecall(input({ generateAnswer: async () => text }, extras));
    expect(streamedResult?.type).toBe("result");
    if (streamedResult?.type === "result") {
      expect(streamedResult.result).toEqual(buffered);
      expect(streamedResult.result.answer).toContain("[task: Buy milk]");
    }
  });

  it("a declared extra-category citation is not falsely stripped from the LIVE delta stream (visual streaming/buffered parity)", async () => {
    const text = "Buy milk tomorrow [task: Buy milk]. Your VPN MTU is 1380 [from vpn.md].";
    const events = await collect(streamGroundedRecall(input(
      { streamAnswer: () => chunked(text.split(/(?<= )/u)) },
      { allowedCitations: { tasks: ["Buy milk"] } }
    )));
    const deltas = events.filter((e) => e.type === "answer-delta").map((e) => e.text).join("");
    expect(deltas).toContain("[task: Buy milk]");
  });

  it("without streamAnswer the single delta IS the gate-clean final answer", async () => {
    const events = await collect(streamGroundedRecall(input({
      generateAnswer: async () => "MTU is 1380. [from vpn.md] Nope. [from ghost.md]"
    })));
    const deltas = events.filter((e) => e.type === "answer-delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.text).not.toContain("ghost.md");
    const last = events[events.length - 1]!;
    if (last.type === "result") {
      expect(deltas[0]!.text).toBe(last.result.answer);
    }
  });
});
