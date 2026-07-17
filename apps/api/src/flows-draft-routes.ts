/**
 * `POST /api/flows/draft` — "코파일럿 초안": turns a one-line description
 * ("매일 아침 9시에 일정 요약해서 알려줘") into a scheduled-job DRAFT the user
 * still reviews before creating anything. Draft-first per
 * `.claude/rules/outbound-safety.md`'s spirit: this route NEVER creates a
 * job — it returns `{ draft }` only, and the web's create panel still
 * requires the user to click 만들기.
 *
 * Uses whatever model the runtime is already wired with (the SAME seam
 * `registerAskRoutes` uses — `generateDraft` is injected here, adapted from
 * `options.modelProvider` in `server.ts`) at temperature 0. There is no
 * fallback to a different/cloud provider on failure: a provider error
 * surfaces verbatim (502) rather than silently retrying against a different
 * route. `MUSE_LOCAL_ONLY` is already enforced at the model-router
 * chokepoint (`createModelProvider`) before a provider ever reaches here —
 * no second gate is added in this route.
 */

import type { FastifyInstance } from "fastify";

import {
  buildFlowDraftPrompt,
  buildFlowDraftRepairPrompt,
  parseFlowDraftResponse,
  type FlowDraftPayload,
  type FlowDraftPrompt
} from "./flows-draft-compile.js";
import { requireAuthenticated } from "./server-helpers.js";
import type { ServerOptions } from "./server.js";
import { errorMessage } from "@muse/shared";

export type GenerateFlowDraft = (prompt: FlowDraftPrompt) => Promise<string>;

export interface FlowDraftRoutesOptions {
  readonly authService: ServerOptions["authService"];
  /** Buffered single-shot completion; the server adapts its ModelProvider. Tests inject a fake. */
  readonly generateDraft: GenerateFlowDraft;
}

interface FlowDraftBody {
  readonly text?: unknown;
}

const MAX_TEXT_LENGTH = 500;
const MAX_RAW_PREVIEW_LENGTH = 300;

type DraftAttempt =
  | { readonly kind: "ok"; readonly value: FlowDraftPayload }
  | { readonly kind: "invalid"; readonly raw: string; readonly error: string }
  | { readonly kind: "provider-error"; readonly message: string };

async function attemptDraft(
  generateDraft: GenerateFlowDraft,
  text: string,
  repairFrom?: { readonly raw: string; readonly error: string }
): Promise<DraftAttempt> {
  const prompt = repairFrom
    ? buildFlowDraftRepairPrompt(text, repairFrom.raw, repairFrom.error)
    : buildFlowDraftPrompt(text);

  let raw: string;
  try {
    raw = await generateDraft(prompt);
  } catch (error) {
    return { kind: "provider-error", message: errorMessage(error, "model provider failed") };
  }

  const parsed = parseFlowDraftResponse(raw);
  return parsed.ok ? { kind: "ok", value: parsed.value } : { error: parsed.error, kind: "invalid", raw };
}

function truncateRaw(raw: string): string {
  return raw.length <= MAX_RAW_PREVIEW_LENGTH ? raw : `${raw.slice(0, MAX_RAW_PREVIEW_LENGTH - 1)}…`;
}

export function registerFlowDraftRoutes(server: FastifyInstance, options: FlowDraftRoutesOptions): void {
  server.post("/api/flows/draft", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(options.authService))) {
      return reply;
    }

    const body = (request.body ?? {}) as FlowDraftBody;
    const text = typeof body.text === "string" ? body.text.trim() : "";

    if (text.length === 0 || text.length > MAX_TEXT_LENGTH) {
      return reply.status(400).send({ error: `body.text must be a non-empty string up to ${MAX_TEXT_LENGTH.toString()} characters` });
    }

    const first = await attemptDraft(options.generateDraft, text);
    if (first.kind === "provider-error") {
      return reply.status(502).send({ error: first.message });
    }
    if (first.kind === "ok") {
      return { draft: first.value };
    }

    const second = await attemptDraft(options.generateDraft, text, { error: first.error, raw: first.raw });
    if (second.kind === "provider-error") {
      return reply.status(502).send({ error: second.message });
    }
    if (second.kind === "ok") {
      return { draft: second.value };
    }

    return reply.status(422).send({ error: second.error, raw: truncateRaw(second.raw) });
  });
}
