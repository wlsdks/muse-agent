/**
 * A2A swarm safety policy — the deterministic core that makes Muse-to-Muse
 * networking safe enough to ship. Muses may federate KNOW-HOW (authored skills,
 * playbook strategies, reasoning utterances) but NEVER personal data, and a
 * received payload can NEVER run anything on your machine. This module is the
 * fail-closed seam every transport/mode (personal swarm, council, multi-user
 * federation) routes through — networking is the EXCEPTION, off by default.
 *
 * The guarantees, enforced in code (not prompt, not hope):
 *  1. Only know-how crosses. `prepareOutbound` refuses any kind that isn't on
 *     the shareable allowlist — a note / fact / credential / tool payload is not
 *     even expressible as an outbound message.
 *  2. PII never leaves. Outbound content is `redactSecretsInText`-scrubbed
 *     before it can leave; the envelope records that it was redacted.
 *  3. Inbound is inert. `classifyInbound` returns only `quarantine` | `reject` —
 *     there is NO "execute" disposition, so a peer cannot trigger a tool, an
 *     action, or any compute on your machine. A received skill lands
 *     execute-gated (like an authored skill) until YOU promote it.
 *  4. Allowlisted peers only. An unknown sender is rejected.
 *  5. Off by default. `isA2AEnabled` is fail-closed; the swarm is opt-in.
 *
 * Pure + framework-independent (lives in core like `local-only-policy`); the
 * network transport is a separate package that routes through these gates.
 */

import { redactSecretsInText } from "@muse/shared";

/** The ONLY payload kinds allowed to cross the swarm — procedural know-how, never data. */
export type A2APayloadKind = "skill" | "strategy" | "council-utterance";

const SHAREABLE_KINDS: ReadonlySet<string> = new Set<A2APayloadKind>([
  "skill",
  "strategy",
  "council-utterance"
]);

/**
 * Upper bound on know-how payload size. Inbound content is untrusted peer data;
 * an unbounded payload is a memory-exhaustion vector when quarantined/stored, so
 * the gate is fail-closed on size too (a skill doc is well under this). Applied
 * to outbound as well so an oversized local payload is refused before it leaves.
 */
export const A2A_MAX_CONTENT_CHARS = 65_536;

export interface A2AOutbound {
  readonly kind: A2APayloadKind;
  /** The skill markdown / strategy text / reasoning utterance. NEVER a note, fact, or credential. */
  readonly content: string;
  readonly label?: string;
}

export interface A2AEnvelope {
  readonly kind: A2APayloadKind;
  /** Redacted content. */
  readonly content: string;
  readonly label?: string;
  readonly fromPeerId: string;
  /** True when redaction changed the content (a secret was scrubbed before send). */
  readonly redacted: boolean;
}

export class A2ASafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "A2ASafetyError";
  }
}

/** Fail-closed opt-in gate — the swarm is OFF unless explicitly enabled. */
export function isA2AEnabled(env: { readonly MUSE_A2A_ENABLED?: string | undefined }): boolean {
  const raw = env.MUSE_A2A_ENABLED?.trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

/**
 * Build a safe outbound envelope. Refuses any non-shareable kind (only know-how
 * crosses) and redacts PII/secrets before the content can leave. Throws
 * `A2ASafetyError` rather than send something it shouldn't.
 */
export function prepareOutbound(
  payload: A2AOutbound,
  fromPeerId: string,
  redact: (text: string) => string = redactSecretsInText
): A2AEnvelope {
  if (!SHAREABLE_KINDS.has(payload.kind)) {
    throw new A2ASafetyError(
      `A2A refuses to send '${String(payload.kind)}' — only know-how (skill / strategy / council-utterance) may cross the swarm, never personal data.`
    );
  }
  if (typeof payload.content !== "string" || payload.content.trim().length === 0) {
    throw new A2ASafetyError("A2A outbound content is empty.");
  }
  if (payload.content.length > A2A_MAX_CONTENT_CHARS) {
    throw new A2ASafetyError(
      `A2A outbound content exceeds the ${A2A_MAX_CONTENT_CHARS.toString()}-char limit (${payload.content.length.toString()}).`
    );
  }
  if (fromPeerId.trim().length === 0) {
    throw new A2ASafetyError("A2A outbound requires a sender peer id.");
  }
  const content = redact(payload.content);
  const label = payload.label !== undefined ? redact(payload.label) : undefined;
  // `redacted` is the audit record that scrubbing happened — it must flip if
  // EITHER the content OR the label was changed, not the content alone.
  const redacted = content !== payload.content || (label !== undefined && label !== payload.label);
  const envelope: A2AEnvelope = { content, fromPeerId, kind: payload.kind, redacted };
  return label !== undefined ? { ...envelope, label } : envelope;
}

/** Inbound is ALWAYS inert — quarantine (execute-gated) or reject. There is no "execute". */
export type InboundDisposition = "quarantine" | "reject";

export interface InboundDecision {
  readonly disposition: InboundDisposition;
  readonly reason: string;
  /** The accepted envelope when quarantined; undefined when rejected. */
  readonly envelope?: A2AEnvelope;
}

function isEnvelope(value: unknown): value is A2AEnvelope {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return typeof e.kind === "string"
    && typeof e.content === "string"
    && typeof e.fromPeerId === "string"
    && typeof e.redacted === "boolean";
}

/**
 * Classify an inbound message. A well-formed know-how payload from an allowlisted
 * peer is QUARANTINED (execute-gated, the user promotes it later); everything
 * else — an unknown peer, a malformed envelope, or a non-shareable kind (a
 * disguised note / tool-call / compute request) — is REJECTED. The return type
 * has no "execute" path, so a peer can never run anything here.
 */
export function classifyInbound(message: unknown, allowedPeers: ReadonlySet<string>): InboundDecision {
  if (!isEnvelope(message)) {
    return { disposition: "reject", reason: "malformed A2A envelope" };
  }
  if (!allowedPeers.has(message.fromPeerId)) {
    return { disposition: "reject", reason: `peer '${message.fromPeerId}' is not in the allowlist` };
  }
  if (!SHAREABLE_KINDS.has(message.kind)) {
    return {
      disposition: "reject",
      reason: `kind '${String(message.kind)}' is not shareable know-how — only skill / strategy / council-utterance are accepted, and never to execute`
    };
  }
  if (message.content.length > A2A_MAX_CONTENT_CHARS) {
    return {
      disposition: "reject",
      reason: `inbound content exceeds the ${A2A_MAX_CONTENT_CHARS.toString()}-char limit (${message.content.length.toString()}) — refused as untrusted oversized payload`
    };
  }
  return {
    disposition: "quarantine",
    envelope: message,
    reason: `accepted ${message.kind} from ${message.fromPeerId} into quarantine (execute-gated until you promote it)`
  };
}
