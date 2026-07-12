import { enforceAnswerCitations, guardAgainstUnbackedActionClaim, type AgentRuntime } from "@muse/agent-core";
import { chatAllowedCitations, createCitationStreamFilter, gateChatAnswerGrounding, type ChatGroundingSource } from "@muse/recall";
import type { JsonObject } from "@muse/shared";

export function parseMultipartBody(contentType: string | string[] | undefined, body: Buffer): JsonObject {
  const header = Array.isArray(contentType) ? contentType[0] : contentType;
  const boundary = header?.match(/boundary=(?:"([^"]+)"|([^;]+))/iu)?.slice(1).find(Boolean);

  if (!boundary) {
    throw new Error("Multipart boundary is required");
  }

  const fields: Record<string, string> = {};
  const files: JsonObject[] = [];
  const raw = body.toString("latin1");

  for (const part of raw.split(`--${boundary}`)) {
    if (part.trim().length === 0 || part.trim() === "--") {
      continue;
    }

    const headerEnd = part.indexOf("\r\n\r\n");

    if (headerEnd < 0) {
      continue;
    }

    const headers = part.slice(0, headerEnd).toLowerCase();
    const disposition = headers.match(/content-disposition:[^\r\n]+/iu)?.[0] ?? "";
    const name = disposition.match(/name="([^"]+)"/iu)?.[1];

    if (!name) {
      continue;
    }

    const filename = disposition.match(/filename="([^"]*)"/iu)?.[1];
    const contentTypeValue = headers.match(/content-type:\s*([^\r\n]+)/iu)?.[1]?.trim();
    const rawContent = part.slice(headerEnd + 4).replace(/\r\n--$/u, "").replace(/\r\n$/u, "");
    const content = Buffer.from(rawContent, "latin1");

    if (filename !== undefined) {
      files.push({
        contentBase64: content.toString("base64"),
        contentType: contentTypeValue ?? "application/octet-stream",
        fieldName: name,
        filename,
        size: content.byteLength
      });
      continue;
    }

    fields[name] = content.toString("utf8");
  }

  return { fields, files };
}

/**
 * Frame a value as SSE `data:` lines. The EventSource spec treats
 * CRLF, a lone CR, and LF all as line terminators, so a bare `\r`
 * in model output / tool JSON must split into its own `data:`
 * segment too — otherwise the client parses past it and truncates
 * the stream. CRLF is matched first so it stays one separator.
 * Exported for direct test coverage of the line-splitting.
 */
export function sseData(value: string): string {
  return value.split(/\r\n|\r|\n/u).map((line) => line.length > 0 ? line : " ").join("\ndata: ");
}

export async function* toSseStream(
  events: ReturnType<AgentRuntime["stream"]>,
  responseMode: "extended" | "compat",
  grounding?: { readonly question: string }
): AsyncIterable<string> {
  // Post-stream grounding gate (CLI-chat parity): raw deltas stream live, then the
  // FULL assembled answer is gated over the evidence THIS turn produced (the
  // `tool-result` events' grounding). An authoritative `grounding` frame carries the
  // gated answer + verdict before `done`, so a fabricated/uncited claim never stands
  // as the final answer even though its tokens flashed by (a post-stream verdict is
  // the accepted streaming shape). No question wired ⇒ no gate (byte-identical stream).
  let assembled = "";
  const evidence: ChatGroundingSource[] = [];
  const toolNames = new Set<string>();
  // Live citation filter over the SAME allowed set the buffered gate derives
  // (chatAllowedCitations over this turn's evidence — read at clean time, so
  // sources a tool adds mid-run count). Deltas stream through it, a fabricated
  // `[from …]` span is dropped before it can flash, and the post-stream
  // grounding frame stays the authoritative final answer.
  const liveFilter = createCitationStreamFilter(
    (span) => enforceAnswerCitations(span, chatAllowedCitations(evidence)).text
  );
  // The first frame leaves BEFORE any model/recall work, so the client can
  // show a live "thinking" state instantly instead of a dead connection —
  // the answer itself only arrives post-gate, which can take a minute on
  // a local 12B model.
  yield "event: stage\ndata: thinking\n\n";
  for await (const event of events) {
    if (event.type === "text-delta") {
      assembled += event.text;
      const safe = liveFilter.push(event.text);
      if (safe.length > 0) {
        yield `event: message\ndata: ${sseData(safe)}\n\n`;
      }
      continue;
    }

    if (event.type === "tool-call") {
      toolNames.add(event.toolCall.name);
      if (responseMode === "compat") {
        yield `event: tool_start\ndata: ${sseData(event.toolCall.name)}\n\n`;
        continue;
      }

      yield `event: tool_call\ndata: ${sseData(JSON.stringify(event.toolCall))}\n\n`;
      continue;
    }

    if (event.type === "tool-result") {
      toolNames.add(event.toolCall.name);
      if (event.grounding) {
        evidence.push({ source: event.grounding.source, text: event.grounding.text });
      }

      if (responseMode === "compat") {
        yield `event: tool_end\ndata: ${sseData(event.toolCall.name)}\n\n`;
      }

      continue;
    }

    if (event.type === "tool-call-started") {
      yield `event: tool_call\ndata: ${sseData(JSON.stringify({ name: event.name, phase: "started" }))}\n\n`;
      continue;
    }

    if (event.type === "tool-call-finished") {
      yield `event: tool_call\ndata: ${sseData(JSON.stringify({ count: event.count, name: event.name, phase: "finished" }))}\n\n`;
      continue;
    }

    if (event.type === "citations") {
      yield `event: citations\ndata: ${sseData(JSON.stringify(event.items))}\n\n`;
      continue;
    }

    if (event.type === "error") {
      yield `event: error\ndata: ${sseData(event.error.message)}\n\n`;
      continue;
    }

    if (event.type === "plan-generated") {
      yield `event: plan_generated\ndata: ${sseData(JSON.stringify({ plan: event.plan, runId: event.runId }))}\n\n`;
      continue;
    }

    if (event.type === "plan-step-executing") {
      yield `event: plan_step_executing\ndata: ${sseData(
        JSON.stringify({ description: event.description, runId: event.runId, stepIndex: event.stepIndex, tool: event.tool })
      )}\n\n`;
      continue;
    }

    if (event.type === "plan-step-result") {
      yield `event: plan_step_result\ndata: ${sseData(
        JSON.stringify({ runId: event.runId, stepIndex: event.stepIndex, success: event.success })
      )}\n\n`;
      continue;
    }

    if (event.type === "synthesis-started") {
      yield `event: synthesis_started\ndata: ${sseData(JSON.stringify({ runId: event.runId }))}\n\n`;
      continue;
    }

    const tail = liveFilter.flush();
    if (tail.length > 0) {
      yield `event: message\ndata: ${sseData(tail)}\n\n`;
    }

    if (grounding) {
      const gate = gateChatAnswerGrounding({
        answer: event.response.output.length > 0 ? event.response.output : assembled,
        evidence,
        question: grounding.question
      });
      // Honest-action gate (parity with the buffered `/api/chat` path and the
      // channel reply — `honest-action-guard.ts`): the assembled answer can
      // CLAIM a completed state-changing action while no actuator tool ran
      // this turn. No retry here — the stream has already finished, so this
      // is a deterministic downgrade only (documented stream limitation: an
      // in-flight re-prompt would require re-streaming the whole turn).
      const honest = await guardAgainstUnbackedActionClaim({
        firstResult: { response: { output: gate.answer }, toolsUsed: [...toolNames] },
        query: grounding.question
      });
      yield `event: grounding\ndata: ${sseData(JSON.stringify({
        answer: honest.response.output,
        gated: gate.gated || honest.response.output !== gate.answer,
        strippedCitations: gate.strippedCitations,
        verdict: gate.groundingVerdict
      }))}\n\n`;
    }

    if (responseMode === "compat") {
      yield "event: done\ndata:\n\n";
      continue;
    }

    yield `event: done\ndata: ${sseData(JSON.stringify({
      model: event.response.model,
      response: event.response.output,
      runId: event.runId,
      usage: event.response.usage
    }))}\n\n`;
  }
}
