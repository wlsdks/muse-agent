import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NOTES_INDEX_SCHEMA_VERSION, runGroundedRecall, type GroundedRecallInput } from "@muse/recall";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerAskRoutes, type AskRoutesOptions } from "./ask-routes.js";

const EMBED_MODEL = "test-embedder";

async function fakeEmbed(text: string): Promise<number[]> {
  return /vpn|mtu|wireguard/iu.test(text) ? [1, 0, 0] : [0, 1, 0];
}

let dir: string;
let notesDir: string;
let indexFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "api-ask-"));
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

function routeOptions(generated: string): AskRoutesOptions {
  return {
    answerModel: "test-answerer",
    authService: undefined,
    embedFn: fakeEmbed,
    generateAnswer: async () => generated,
    notesDir,
    notesIndexFile: indexFile
  };
}

describe("POST /api/ask — grounded recall on the API surface", () => {
  it("answers with the surviving citation, verdict, and receipts", async () => {
    const server = Fastify();
    registerAskRoutes(server, routeOptions("Your VPN MTU is 1380. [from vpn.md]"));
    const res = await server.inject({ method: "POST", payload: { question: "what MTU does my VPN use?" }, url: "/api/ask" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { answer: string; citations: string[]; verdict: string };
    expect(body.answer).toContain("[from vpn.md]");
    expect(body.citations).toEqual(["vpn.md"]);
    expect(body.verdict).toBe("confident");
    await server.close();
  });

  it("a fabricated citation is stripped by the gate before the response leaves (fabrication=0)", async () => {
    const server = Fastify();
    registerAskRoutes(server, routeOptions("MTU is 1380. [from vpn.md] The password is hunter2. [from secrets.md]"));
    const res = await server.inject({ method: "POST", payload: { question: "what MTU does my VPN use?" }, url: "/api/ask" });
    const body = JSON.parse(res.body) as { answer: string; citations: string[]; strippedCitations: string[] };
    expect(body.answer).not.toContain("secrets.md");
    expect(body.strippedCitations).toContain("secrets.md");
    expect(body.citations).toEqual(["vpn.md"]);
    await server.close();
  });

  it("rejects a missing / empty question with 400", async () => {
    const server = Fastify();
    registerAskRoutes(server, routeOptions("unused"));
    for (const payload of [{}, { question: "  " }, { question: 7 }]) {
      const res = await server.inject({ method: "POST", payload, url: "/api/ask" });
      expect(res.statusCode).toBe(400);
    }
    await server.close();
  });

  it("PARITY: the route returns exactly what a direct runGroundedRecall call returns", async () => {
    const generated = "Your VPN MTU is 1380. [from vpn.md] Also X. [from ghost.md]";
    const seamInput: GroundedRecallInput = {
      options: { answerModel: "test-answerer" },
      query: "what MTU does my VPN use?",
      runtime: { embedFn: fakeEmbed, generateAnswer: async () => generated },
      sources: { notesDir, notesIndexFile: indexFile }
    };
    const direct = await runGroundedRecall(seamInput);

    const server = Fastify();
    registerAskRoutes(server, routeOptions(generated));
    const res = await server.inject({ method: "POST", payload: { question: seamInput.query }, url: "/api/ask" });
    const viaApi = JSON.parse(res.body) as Record<string, unknown>;

    expect(viaApi).toEqual(JSON.parse(JSON.stringify(direct)));
    await server.close();
  });
});
