/**
 * Muse's A2A (Agent2Agent, https://a2a-protocol.org, v1.0) Agent Card — the
 * discovery surface a standard A2A client fetches to learn what a Muse peer
 * accepts. We adopt A2A's discovery + envelope VOCABULARY (card, skills, parts,
 * extensions) but deliberately NOT its task-execution model: A2A's
 * message/send → Task → working → completed lifecycle assumes the remote agent
 * EXECUTES, which is exactly the thing Muse forbids. The card honestly
 * advertises that via a REQUIRED profile extension (acceptsExecution:false), and
 * the inert guarantee stays deterministic code (`a2a-safety.classifyInbound`),
 * never mere advertised intent.
 *
 * Minimal local type defs (a subset of the A2A v1.0 AgentCard) — we align to the
 * spec WITHOUT taking the execution-first `@a2a-js/sdk` as a load-bearing dep,
 * keeping Muse lean + local-first. Per the spec, A2A conformance is best-effort
 * interop, never a dependency of the safety core.
 */

import type { A2APayloadKind } from "@muse/agent-core";

export const MUSE_A2A_PROTOCOL_VERSION = "1.0";
/** Versioned URI for Muse's required know-how-only profile extension. */
export const KNOW_HOW_ONLY_EXT_URI = "https://muse.local/a2a/ext/know-how-only/v1";
/** Media type that frames a Muse know-how payload as an A2A DataPart. */
export const KNOW_HOW_MEDIA_TYPE = "application/vnd.muse.knowhow+json";

const SHAREABLE_KINDS: readonly A2APayloadKind[] = ["skill", "strategy", "council-utterance"];

export interface A2AAgentSkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly inputModes?: readonly string[];
  readonly outputModes?: readonly string[];
}

export interface A2AAgentExtension {
  readonly uri: string;
  readonly description?: string;
  readonly required?: boolean;
  readonly params?: Record<string, unknown>;
}

export interface A2AAgentCard {
  readonly protocolVersion: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly url: string;
  readonly capabilities: {
    readonly streaming: boolean;
    readonly pushNotifications: boolean;
    readonly extensions: readonly A2AAgentExtension[];
  };
  readonly skills: readonly A2AAgentSkill[];
  readonly defaultInputModes: readonly string[];
  readonly defaultOutputModes: readonly string[];
  readonly securitySchemes: Record<string, unknown>;
}

function knowHowSkill(kind: A2APayloadKind): A2AAgentSkill {
  return {
    description: `Receive a PII-redacted ${kind} into quarantine (execute-gated). Never executed; the user promotes it.`,
    id: `know-how.${kind}`,
    inputModes: [KNOW_HOW_MEDIA_TYPE],
    name: `Know-how: ${kind}`,
    outputModes: [KNOW_HOW_MEDIA_TYPE],
    tags: ["know-how", "inert", "no-exec"]
  };
}

/**
 * Build Muse's Agent Card. Intentionally MINIMAL (no PII, no real provider
 * identity, no internal tool names — the card is A2A's primary recon surface).
 * `streaming` + `pushNotifications` are false (a webhook target is an SSRF /
 * egress hole Muse's local-first posture must not open). The required extension
 * tells any A2A client: this agent only accepts know-how and never executes.
 */
export function buildMuseAgentCard(options: { readonly url: string; readonly name?: string }): A2AAgentCard {
  return {
    capabilities: {
      extensions: [{
        description: "Muse accepts and sends ONLY PII-redacted know-how (skills / strategies / reasoning). Inbound is inert — quarantined or rejected, never executed. A peer cannot trigger compute.",
        params: {
          acceptsExecution: false,
          inboundDisposition: ["quarantine", "reject"],
          payloadKinds: SHAREABLE_KINDS,
          piiRedacted: true,
          sharePolicy: "know-how-only"
        },
        required: true,
        uri: KNOW_HOW_ONLY_EXT_URI
      }],
      pushNotifications: false,
      streaming: false
    },
    defaultInputModes: [KNOW_HOW_MEDIA_TYPE],
    defaultOutputModes: [KNOW_HOW_MEDIA_TYPE],
    description: "A private, local-first assistant. Accepts ONLY know-how (skills / strategies / reasoning), never executes remote tasks.",
    name: options.name ?? "Muse",
    protocolVersion: MUSE_A2A_PROTOCOL_VERSION,
    securitySchemes: {
      museHmac: {
        description: "Per-envelope HMAC-SHA256 in the x-muse-a2a-signature header, keyed by the peer's shared secret.",
        scheme: "muse-a2a-hmac",
        type: "http"
      }
    },
    skills: SHAREABLE_KINDS.map(knowHowSkill),
    url: options.url,
    version: "1.0.0"
  };
}
