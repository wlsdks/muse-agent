/**
 * Council request/response over the A2A transport. Unlike a one-way know-how
 * share, a council is REQUEST→RESPONSE: the initiator asks each peer to reason
 * about a question, the peer returns a bounded reasoning utterance, the
 * initiator synthesises locally.
 *
 * Safety (separate, narrower gate than know-how deposit):
 *   - Opt-in twice: the swarm must be on AND the participant must enable council
 *     (`MUSE_A2A_COUNCIL`) — a non-participant rejects council requests.
 *   - Signed + allowlisted: the request is HMAC-signed over its canonical form;
 *     an unknown peer or bad signature is rejected.
 *   - Bounded compute: the only thing a council request triggers is
 *     `produceCouncilReasoning` (a short, tool-free, PII-redacted reasoning).
 *     No corpus, no tools, no state change.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { A2APeer } from "./peer-registry.js";
import type { A2AEnv } from "./transport.js";

export const COUNCIL_METHOD = "council/reason";

export interface CouncilRequest {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly method: typeof COUNCIL_METHOD;
  readonly params: { readonly fromPeerId: string; readonly question: string };
}

export interface CouncilResponse {
  readonly kind: "council-reasoning";
  readonly fromPeerId: string;
  readonly reasoning: string;
}

function canonicalCouncilRequest(fromPeerId: string, question: string): string {
  return `${COUNCIL_METHOD}\n\u0000\n${fromPeerId}\n\u0000\n${question}`;
}

export function signCouncilRequest(fromPeerId: string, question: string, secret: string): string {
  return createHmac("sha256", secret).update(canonicalCouncilRequest(fromPeerId, question)).digest("hex");
}

export function verifyCouncilRequest(fromPeerId: string, question: string, signature: string | undefined, secret: string): boolean {
  if (typeof signature !== "string") return false;
  const expected = signCouncilRequest(fromPeerId, question, secret);
  if (signature.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

export function buildCouncilRequest(fromPeerId: string, question: string, rpcId: string): CouncilRequest {
  return { id: rpcId, jsonrpc: "2.0", method: COUNCIL_METHOD, params: { fromPeerId, question } };
}

/** Pull a council request out of a parsed body, or null if it isn't one. */
export function parseCouncilRequest(body: unknown): { readonly fromPeerId: string; readonly question: string } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { method?: unknown; params?: { fromPeerId?: unknown; question?: unknown } };
  if (b.method !== COUNCIL_METHOD || !b.params) return null;
  const { fromPeerId, question } = b.params;
  if (typeof fromPeerId !== "string" || typeof question !== "string" || question.trim().length === 0) return null;
  return { fromPeerId, question };
}

/** Max accepted peer-reasoning length — a trust-boundary bound so a buggy/compromised
 *  (even allowlisted) peer can't flood the initiator's local synthesis context. A valid
 *  but over-long reasoning is TRUNCATED (kept, bounded), not rejected — the council still
 *  uses its content, capped. */
export const MAX_COUNCIL_REASONING_CHARS = 4000;

/**
 * Pull a well-formed council RESPONSE out of a parsed body, or null if it isn't
 * one — the symmetric accepting-side boundary to parseCouncilRequest. Rejects on
 * a bad kind or a missing/empty reasoning (the load-bearing content); an
 * over-long reasoning is truncated to MAX_COUNCIL_REASONING_CHARS (bounded
 * compute at the trust seam — a buggy/compromised peer can't flood local
 * synthesis). `fromPeerId` is carried through (coerced to "" when absent) but is
 * NOT a rejection reason: the producer itself emits "" when selfPeerId is unset
 * (handler.ts), and the caller discards it, so requiring it would only drop
 * legitimate reasoning.
 */
export function parseCouncilResponse(body: unknown): CouncilResponse | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { kind?: unknown; fromPeerId?: unknown; reasoning?: unknown };
  if (b.kind !== "council-reasoning") return null;
  if (typeof b.reasoning !== "string" || b.reasoning.trim().length === 0) return null;
  const reasoning = b.reasoning.length > MAX_COUNCIL_REASONING_CHARS ? b.reasoning.slice(0, MAX_COUNCIL_REASONING_CHARS) : b.reasoning;
  const fromPeerId = typeof b.fromPeerId === "string" ? b.fromPeerId : "";
  return { kind: "council-reasoning", fromPeerId, reasoning };
}

export interface RequestCouncilReasoningOptions {
  readonly env: A2AEnv;
  readonly peer: A2APeer;
  readonly question: string;
  readonly fromPeerId: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Ask a peer to reason about the question. Returns the peer's reasoning string,
 * or null if the swarm is off, the peer doesn't participate, or anything fails.
 */
export async function requestCouncilReasoning(options: RequestCouncilReasoningOptions): Promise<string | null> {
  const enabled = ["true", "1", "yes", "on"].includes((options.env.MUSE_A2A_ENABLED ?? "").trim().toLowerCase());
  if (!enabled || options.question.trim().length === 0) return null;
  const signature = signCouncilRequest(options.fromPeerId, options.question, options.peer.secret);
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(options.peer.url, {
      body: JSON.stringify(buildCouncilRequest(options.fromPeerId, options.question, randomUUID())),
      headers: { "content-type": "application/json", "x-muse-a2a-signature": signature },
      method: "POST"
    });
    if (!response.ok) return null;
    const parsed = parseCouncilResponse(await response.json());
    return parsed ? parsed.reasoning : null;
  } catch {
    return null;
  }
}
