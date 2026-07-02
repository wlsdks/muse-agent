/**
 * `POST /api/ask` — grounded recall over the notes corpus for the API surface,
 * powered by the SAME `runGroundedRecall` pipeline (retrieval → citation
 * contract → deterministic citation gate → confidence verdict) the CLI's ask
 * stages come from, so the server no longer needs the CLI to answer a grounded
 * question. Body: `{ question, topK?, scope? }`. The response carries the
 * gate's work: surviving citations, stripped fabrications, verdict, receipts.
 */

import { embed, runGroundedRecall, type GroundedRecallInput, type GroundedRecallResult } from "@muse/recall";
import type { FastifyInstance } from "fastify";

import { requireAuthenticated } from "./server-helpers.js";
import type { ServerOptions } from "./server.js";

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
}

interface AskBody {
  readonly question?: unknown;
  readonly topK?: unknown;
  readonly scope?: unknown;
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

    const result: GroundedRecallResult = await runGroundedRecall({
      options: {
        answerModel: options.answerModel,
        ...(options.embedModel !== undefined ? { embedModel: options.embedModel } : {}),
        ...(scope !== undefined ? { scope } : {}),
        ...(topK !== undefined ? { topK } : {})
      },
      query: question,
      runtime: { embedFn, generateAnswer: options.generateAnswer },
      sources: { notesDir: options.notesDir, notesIndexFile: options.notesIndexFile }
    });
    return reply.send(result);
  });
}
