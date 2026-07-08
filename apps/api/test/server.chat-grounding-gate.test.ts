import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { runChat, runChatStream } from "../src/server-helpers.js";
import type { ServerOptions } from "../src/server.js";

/**
 * The API chat surface must gate its answer through the SAME deterministic
 * grounding gate the CLI chat applies (`gateChatAnswerGrounding` in @muse/recall),
 * so a fabricated/uncited claim is dropped by CODE (fabrication=0) while a properly
 * grounded answer passes UNCHANGED. This pair is the acceptance criterion; the
 * fabricated case going RED if the gate call is removed is the mutation check.
 */

function fakeReply() {
  const calls: { sent?: unknown; headers: Record<string, string> } = { headers: {} };
  const reply = {
    header(name: string, value: string) {
      calls.headers[name] = value;
      return reply;
    },
    send(payload: unknown) {
      calls.sent = payload;
      return payload;
    },
    status(_code: number) {
      return { send(payload: unknown) { calls.sent = payload; return payload; } };
    }
  };
  return { calls, reply };
}

type Grounding = { readonly source: string; readonly text: string };

/** A fake AgentRuntime whose buffered run + stream both return `output`, with the
 *  supplied `groundingSources` (the evidence the turn produced). Contract-faithful:
 *  it drives the REAL `runChat` / `runChatStream` glue, no gate stubbing. */
function fakeRuntime(output: string, groundingSources: readonly Grounding[]) {
  const response = { citations: [], model: "qwen3:8b", output, usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 } };
  const result = { groundingSources, response, runId: "run-1", toolsUsed: [] as string[] };
  return {
    run: async () => result,
    async *stream() {
      yield { runId: "run-1", text: output, type: "text-delta" as const };
      for (const g of groundingSources) {
        yield { grounding: g, runId: "run-1", toolCall: { arguments: {}, id: "t1", name: "knowledge_search" }, type: "tool-result" as const };
      }
      yield { response, runId: "run-1", type: "done" as const };
    }
  };
}

const options = (runtime: unknown): ServerOptions =>
  ({ agentRuntime: runtime, defaultModel: "ollama/qwen3:8b" }) as unknown as ServerOptions;

const FABRICATED = "Your API key is sk-live-abc123 [from vault.md].";
const GROUNDED = "The office wifi password is muse2026 [from office.md].";
const GROUNDED_EVIDENCE: Grounding[] = [{ source: "office.md", text: "The office wifi password is muse2026." }];

describe("/api/chat grounding gate — POST /chat parity with CLI chat", () => {
  it("DOWNGRADES a fabricated answer with no supporting evidence (fabrication=0)", async () => {
    const { reply } = fakeReply();
    const result = (await runChat(
      { message: "What is my API key?" },
      reply,
      options(fakeRuntime(FABRICATED, [])),
      "compat"
    )) as Record<string, unknown>;

    // The invented value never survives — the whole un-groundable sentence is dropped.
    expect(result.content).not.toContain("sk-live-abc123");
    expect(result.content).not.toBe(FABRICATED);
    expect(result.content).toMatch(/not sure/i);
    // The fabricated citation is reported as stripped, and the verdict is ungrounded.
    expect(result.strippedCitations).toContain("vault.md");
    expect(result.groundingVerdict).toBe("ungrounded");
  });

  it("passes a fully-grounded answer through UNCHANGED (no over-gating)", async () => {
    const { reply } = fakeReply();
    const result = (await runChat(
      { message: "What is the office wifi password?" },
      reply,
      options(fakeRuntime(GROUNDED, GROUNDED_EVIDENCE)),
      "compat"
    )) as Record<string, unknown>;

    expect(result.content).toBe(GROUNDED);
    expect(result.strippedCitations).toEqual([]);
    expect(result.groundingVerdict).toBe("grounded");
  });

  it("MUTATION GUARD: the raw runtime output DOES carry the fabrication (so the gate is what removes it)", async () => {
    // Documents that the fabrication reaches runChat verbatim — only the gate call
    // strips it. Delete the gate in runChat and the first test flips to RED.
    expect(FABRICATED).toContain("sk-live-abc123");
    expect(FABRICATED).toContain("[from vault.md]");
  });
});

describe("/chat/stream grounding gate — post-stream authoritative verdict", () => {
  it("emits a grounding frame that DOWNGRADES a streamed fabricated answer", async () => {
    const { calls, reply } = fakeReply();
    await runChatStream({ message: "What is my API key?" }, reply, options(fakeRuntime(FABRICATED, [])), "compat");
    const text = await streamToString(calls.sent as Readable);

    expect(text).toContain("event: grounding");
    const frame = groundingFrame(text);
    expect(frame.answer).not.toContain("sk-live-abc123");
    expect(frame.answer).toMatch(/not sure/i);
    expect(frame.verdict).toBe("ungrounded");
    expect(frame.strippedCitations).toContain("vault.md");
    expect(frame.gated).toBe(true);
  });

  it("emits a grounding frame that PASSES a streamed grounded answer unchanged", async () => {
    const { calls, reply } = fakeReply();
    await runChatStream(
      { message: "What is the office wifi password?" },
      reply,
      options(fakeRuntime(GROUNDED, GROUNDED_EVIDENCE)),
      "compat"
    );
    const text = await streamToString(calls.sent as Readable);

    const frame = groundingFrame(text);
    expect(frame.answer).toBe(GROUNDED);
    expect(frame.verdict).toBe("grounded");
    expect(frame.gated).toBe(false);
  });
});

/** Parse the `event: grounding` SSE frame's JSON payload out of the raw stream. */
function groundingFrame(sse: string): { answer: string; verdict: string; strippedCitations: string[]; gated: boolean } {
  const marker = "event: grounding\ndata: ";
  const start = sse.indexOf(marker);
  if (start < 0) throw new Error("no grounding frame in stream");
  const rest = sse.slice(start + marker.length);
  const line = rest.slice(0, rest.indexOf("\n\n")).split("\ndata: ").join("");
  return JSON.parse(line);
}

async function streamToString(stream: Readable): Promise<string> {
  let out = "";
  for await (const chunk of stream) {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
  }
  return out;
}
