import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NOTES_INDEX_SCHEMA_VERSION } from "./notes-index.js";
import { runGroundedRecall, type GroundedRecallInput } from "./pipeline.js";

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
