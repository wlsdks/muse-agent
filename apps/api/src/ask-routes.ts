/**
 * `POST /api/ask` — grounded recall over the notes corpus for the API surface,
 * powered by the SAME `runGroundedRecall` pipeline (retrieval → citation
 * contract → deterministic citation gate → confidence verdict) the CLI's ask
 * stages come from, so the server no longer needs the CLI to answer a grounded
 * question. Body: `{ question, topK?, scope? }`. The response carries the
 * gate's work: surviving citations, stripped fabrications, verdict, receipts.
 *
 * `Accept: text/event-stream` switches the SAME request to
 * `streamGroundedRecall` (the streaming form of the identical pipeline —
 * `runGroundedRecall` itself just drains that stream to its `result` event),
 * so the SSE deltas already sit behind the pipeline's own live citation
 * filter. No second gate is added here. Any other Accept value keeps the
 * original buffered JSON body byte-identical.
 */

import {
  embed,
  runGroundedRecall,
  streamGroundedRecall,
  type GroundedRecallEvent,
  type GroundedRecallInput,
  type GroundedRecallResult
} from "@muse/recall";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Readable } from "node:stream";

import { requireAuthenticated } from "./server-helpers.js";
import { sseData } from "./server-multipart-sse.js";
import type { ServerOptions } from "./server.js";
import { errorMessage } from "@muse/shared";

export interface AskRoutesOptions {
  readonly authService: ServerOptions["authService"];
  /** The notes corpus root the citations are relative to. */
  readonly notesDir: string;
  /** The prebuilt vector index file (`muse notes reindex` output). */
  readonly notesIndexFile: string;
  /** Omitted ⇒ the index's own embed model (drift-proof default). */
  readonly embedModel?: string;
  readonly answerModel: string;
  /** Buffered completion; the server adapts its ModelProvider. Tests inject a fake. */
  readonly generateAnswer: GroundedRecallInput["runtime"]["generateAnswer"];
  /** Override the embedder (tests); defaults to the package embed against `OLLAMA_BASE_URL`. */
  readonly embedFn?: GroundedRecallInput["runtime"]["embedFn"];
  /**
   * Token-delta completion for the SSE branch; the server adapts its
   * ModelProvider's `.stream()`. Omitted ⇒ `streamGroundedRecall` degrades to
   * one gate-clean delta after a buffered `generateAnswer` call — still a
   * valid SSE response, just not token-progressive.
   */
  readonly streamAnswer?: GroundedRecallInput["runtime"]["streamAnswer"];
}

interface AskBody {
  readonly question?: unknown;
  readonly topK?: unknown;
  readonly scope?: unknown;
}

function wantsEventStream(request: FastifyRequest): boolean {
  const accept = request.headers.accept;
  return typeof accept === "string" && accept.toLowerCase().includes("text/event-stream");
}

/**
 * Mirrors `GroundedRecallEvent`'s own `type` names as SSE event names
 * (`retrieval` / `delta` / `result`) rather than inventing a parallel
 * vocabulary — the union already IS the contract. A mid-stream throw (e.g.
 * the injected `generateAnswer`/`streamAnswer` rejecting) ends the stream
 * with an honest `error` frame instead of a silently truncated response
 * that a client could mistake for a complete answer.
 */
export async function* toAskSseStream(events: AsyncIterable<GroundedRecallEvent>): AsyncIterable<string> {
  try {
    for await (const event of events) {
      if (event.type === "retrieval") {
        yield `event: retrieval\ndata: ${sseData(JSON.stringify({
          groundedChunkCount: event.groundedChunkCount,
          notesUnavailable: event.notesUnavailable,
          verdict: event.verdict
        }))}\n\n`;
        continue;
      }
      if (event.type === "answer-delta") {
        yield `event: delta\ndata: ${sseData(event.text)}\n\n`;
        continue;
      }
      yield `event: result\ndata: ${sseData(JSON.stringify(event.result))}\n\n`;
    }
  } catch (error) {
    yield `event: error\ndata: ${sseData(errorMessage(error, "ask stream failed"))}\n\n`;
  }
}

export function registerAskRoutes(server: FastifyInstance, options: AskRoutesOptions): void {
  const embedFn = options.embedFn ?? ((text: string, model: string) => embed(text, model));
  server.post("/api/ask", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(options.authService))) {
      return reply;
    }
    const body = (request.body ?? {}) as AskBody;
    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (question.length === 0) {
      return reply.status(400).send({ error: "body.question (non-empty string) is required" });
    }
    const topK = typeof body.topK === "number" && Number.isFinite(body.topK)
      ? Math.min(20, Math.max(1, Math.trunc(body.topK)))
      : undefined;
    const scope = typeof body.scope === "string" && body.scope.trim().length > 0 ? body.scope.trim() : undefined;

    const recallOptions: GroundedRecallInput["options"] = {
      answerModel: options.answerModel,
      ...(options.embedModel !== undefined ? { embedModel: options.embedModel } : {}),
      ...(scope !== undefined ? { scope } : {}),
      ...(topK !== undefined ? { topK } : {})
    };
    const sources: GroundedRecallInput["sources"] = { notesDir: options.notesDir, notesIndexFile: options.notesIndexFile };
    // CLI parity: near-duplicate dedup + the "Lost in the Middle"
    // (arXiv:2307.03172) edge-placement reorder previously ran only for
    // `muse ask`, so the web console's ask answered from an unrefined,
    // middle-buried chunk order on the same question.
    const extras: GroundedRecallInput["extras"] = { refineChunks: true };

    if (wantsEventStream(request)) {
      reply.header("content-type", "text/event-stream; charset=utf-8");
      reply.header("cache-control", "no-cache");
      reply.header("x-accel-buffering", "no");
      const streamInput: GroundedRecallInput = {
        extras,
        options: recallOptions,
        query: question,
        runtime: {
          embedFn,
          generateAnswer: options.generateAnswer,
          ...(options.streamAnswer ? { streamAnswer: options.streamAnswer } : {})
        },
        sources
      };
      return reply.send(Readable.from(toAskSseStream(streamGroundedRecall(streamInput))));
    }

    const result: GroundedRecallResult = await runGroundedRecall({
      extras,
      options: recallOptions,
      query: question,
      runtime: { embedFn, generateAnswer: options.generateAnswer },
      sources
    });
    return reply.send(result);
  });
}
