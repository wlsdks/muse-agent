import { Readable } from "node:stream";

import { unbackedActionNoticeFor } from "@muse/agent-core";
import { describe, expect, it } from "vitest";

import { runChat, runChatStream } from "../src/server-helpers.js";
import type { ServerOptions } from "../src/server.js";

/**
 * The API /chat surface (buffered + streamed) must apply the SAME honest-action
 * gate the CLI chat REPL already applies: a completion claim the model makes
 * WITH NO actuator tool run is a false promise and must never reach the user
 * unmodified (agent-testing.md: a "done" signal must be backed by a real
 * verification step). Live repro this pins: POST /api/chat with
 * "내일 오후 3시에 치과 예약 잡아줘" returned `toolCalls: null` but claimed
 * "...등록했습니다." — this suite is the regression test for that finding.
 */

const KO_QUERY = "내일 오후 3시에 치과 예약 잡아줘";
const KO_CLAIM = "내일 오후 3시에 '치과 예약'을 등록했습니다.";

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

const options = (runtime: unknown): ServerOptions =>
  ({ agentRuntime: runtime, defaultModel: "ollama/qwen3:8b" }) as unknown as ServerOptions;

/** A fake runtime whose `run` returns a fixed answer/toolsUsed pair every call
 *  (used for the "still unbacked after the retry" and "no over-gating" cases —
 *  a single fixed response is representative of both the first call and the
 *  retry call). */
function fixedRuntime(output: string, toolsUsed: readonly string[] = []) {
  const response = { citations: [], model: "qwen3:8b", output, usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 } };
  return {
    run: async () => ({ groundingSources: [], response, runId: "run-1", toolsUsed }),
    async *stream() {
      yield { runId: "run-1", text: output, type: "text-delta" as const };
      for (const name of toolsUsed) {
        yield { runId: "run-1", toolCall: { arguments: {}, id: "t1", name }, type: "tool-result" as const };
      }
      yield { response, runId: "run-1", type: "done" as const };
    }
  };
}

/** A fake runtime whose FIRST call is unbacked and whose SECOND (retry) call
 *  actually ran the actuator — proves the clean-history retry can recover a
 *  real action instead of just downgrading to the honest notice. */
function recoveringRuntime() {
  let calls = 0;
  const response = (output: string) => ({ citations: [], model: "qwen3:8b", output, usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 } });
  return {
    calls: () => calls,
    run: async () => {
      calls += 1;
      return calls === 1
        ? { groundingSources: [], response: response(KO_CLAIM), runId: "run-1", toolsUsed: [] }
        : { groundingSources: [], response: response("네, 등록했습니다."), runId: "run-1", toolsUsed: ["calendar.create"] };
    }
  };
}

describe("/api/chat honest-action gate — no completion claim without a tool run", () => {
  it("DOWNGRADES an unbacked completion claim to the honest notice when even the retry doesn't act", async () => {
    const { reply } = fakeReply();
    const result = (await runChat({ message: KO_QUERY }, reply, options(fixedRuntime(KO_CLAIM, [])), "compat")) as Record<string, unknown>;

    expect(result.content).not.toContain("등록했습니다");
    expect(result.content).toBe(unbackedActionNoticeFor(KO_QUERY));
  });

  it("RECOVERS via the clean-history retry when the retry actually runs the actuator", async () => {
    const { reply } = fakeReply();
    const runtime = recoveringRuntime();
    const result = (await runChat({ message: KO_QUERY }, reply, options(runtime), "compat")) as Record<string, unknown>;

    expect(runtime.calls()).toBe(2);
    expect(result.content).toBe("네, 등록했습니다.");
    expect(result.toolsUsed).toEqual(["calendar.create"]);
  });

  it("passes a BACKED completion claim through UNCHANGED (no over-gating)", async () => {
    const { reply } = fakeReply();
    const backed = "내일 오후 3시에 '치과 예약'을 등록했습니다.";
    const result = (await runChat(
      { message: KO_QUERY },
      reply,
      options(fixedRuntime(backed, ["calendar.create"])),
      "compat"
    )) as Record<string, unknown>;

    expect(result.content).toBe(backed);
  });

  it("passes an answer with NO completion claim through UNCHANGED (a plain question)", async () => {
    const { reply } = fakeReply();
    const answer = "Your dentist appointment is not yet booked.";
    const result = (await runChat(
      { message: "언제가 치과 예약이야?" },
      reply,
      options(fixedRuntime(answer, [])),
      "compat"
    )) as Record<string, unknown>;

    expect(result.content).toBe(answer);
  });

  it("MUTATION GUARD: the raw runtime output DOES carry the completion claim (so the gate is what removes it)", async () => {
    expect(KO_CLAIM).toContain("등록했습니다");
  });
});

describe("/chat/stream honest-action gate — final grounding frame", () => {
  it("DOWNGRADES a streamed unbacked completion claim in the grounding frame", async () => {
    const { calls, reply } = fakeReply();
    await runChatStream({ message: KO_QUERY }, reply, options(fixedRuntime(KO_CLAIM, [])), "compat");
    const text = await streamToString(calls.sent as Readable);
    const frame = groundingFrame(text);

    expect(frame.answer).not.toContain("등록했습니다");
    expect(frame.answer).toBe(unbackedActionNoticeFor(KO_QUERY));
  });

  it("passes a streamed BACKED completion claim through unchanged", async () => {
    const { calls, reply } = fakeReply();
    const backed = "내일 오후 3시에 '치과 예약'을 등록했습니다.";
    await runChatStream({ message: KO_QUERY }, reply, options(fixedRuntime(backed, ["calendar.create"])), "compat");
    const text = await streamToString(calls.sent as Readable);
    const frame = groundingFrame(text);

    expect(frame.answer).toBe(backed);
  });
});

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

describe("honest-action retry re-enters the grounding gate (fabrication=0 must not be bypassed)", () => {
  it("a RECOVERED retry answer is still citation-gated — a fabricated citation in the retry never reaches the user", async () => {
    let call = 0;
    const runtime = {
      run: async () => {
        call += 1;
        // Turn 1: claims completion with no tool → triggers the honest-action retry.
        if (call === 1) {
          return {
            groundingSources: [],
            response: { citations: [], model: "qwen3:8b", output: KO_CLAIM, usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 } },
            runId: "run-1",
            toolsUsed: []
          };
        }
        // Retry: the actuator DID run, but the answer smuggles a fabricated
        // citation — the grounding gate must still strip it.
        return {
          groundingSources: [],
          response: {
            citations: [],
            model: "qwen3:8b",
            output: "예약을 등록했습니다. 진료비는 12만원입니다 [from notes/fake-clinic.md].",
            usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 }
          },
          runId: "run-2",
          toolsUsed: ["muse.calendar.add"]
        };
      }
    };
    const { reply } = fakeReply();
    const result = (await runChat({ message: "내일 오후 3시에 치과 예약 잡아줘" }, reply, options(runtime), "compat")) as Record<string, unknown>;

    const content = String(result["content"] ?? "");
    expect(content).not.toContain("fake-clinic.md");
    expect(content).not.toContain("12만원");
  });
});
