/**
 * The inbound A2A request handler — pure over a transport-agnostic request/
 * response shape, so it's fully testable without a socket and the `muse swarm
 * serve` command is a thin node:http wrapper around it.
 *
 * It exposes exactly two operations, and NOTHING that runs work:
 *   - GET /.well-known/agent-card.json → Muse's minimal Agent Card (discovery).
 *   - POST …                          → classify the A2A message through the
 *       safety core and DEPOSIT accepted know-how to quarantine; respond with a
 *       terminal A2A Message ack (quarantined | rejected). No Task, no `working`
 *       state, no artifacts, no callback — a peer can never trigger compute.
 *
 * Off-by-default (`isA2AEnabled`); a disabled Muse answers 403 to everything.
 */

import { randomUUID } from "node:crypto";

import { A2A_SIGNATURE_HEADER } from "./transport.js";
import type { A2AAgentCard } from "./agent-card.js";
import type { PeerRegistry } from "./peer-registry.js";
import { receiveAndQuarantine, type QuarantineDepositInput } from "./receive-quarantine.js";

export const AGENT_CARD_PATH = "/.well-known/agent-card.json";

export interface A2ARequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
}

export interface A2AResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

export interface A2AHandlerOptions {
  readonly env: { readonly MUSE_A2A_ENABLED?: string | undefined };
  readonly registry: PeerRegistry;
  readonly agentCard: A2AAgentCard;
  readonly deposit: (input: QuarantineDepositInput) => Promise<void>;
  readonly now?: () => number;
  readonly genId?: () => string;
}

function json(status: number, value: unknown): A2AResponse {
  return { body: JSON.stringify(value), contentType: "application/json", status };
}

function ackMessage(text: string): unknown {
  return { kind: "message", messageId: randomUUID(), parts: [{ kind: "text", text }], role: "agent" };
}

export function createA2AHandler(options: A2AHandlerOptions): (request: A2ARequest) => Promise<A2AResponse> {
  return async (request) => {
    // Off-by-default: a disabled Muse is unreachable, even for discovery.
    const enabled = ["true", "1", "yes", "on"].includes((options.env.MUSE_A2A_ENABLED ?? "").trim().toLowerCase());
    if (!enabled) {
      return json(403, { error: "A2A is disabled on this Muse (set MUSE_A2A_ENABLED to opt in)." });
    }
    if (request.method === "GET") {
      if (request.path.split("?")[0] === AGENT_CARD_PATH) {
        return json(200, options.agentCard);
      }
      return json(404, { error: "not found" });
    }
    if (request.method === "POST") {
      const signature = request.headers[A2A_SIGNATURE_HEADER] ?? request.headers[A2A_SIGNATURE_HEADER.toLowerCase()];
      const decision = await receiveAndQuarantine({
        deposit: options.deposit,
        env: options.env,
        rawBody: request.body,
        registry: options.registry,
        signature,
        ...(options.now ? { now: options.now } : {}),
        ...(options.genId ? { genId: options.genId } : {})
      });
      // Terminal ack only — never a Task. Rejected know-how just says so.
      const text = decision.disposition === "quarantine"
        ? "quarantined for review — execute-gated until promoted"
        : `rejected: ${decision.reason}`;
      return json(200, ackMessage(text));
    }
    return json(405, { error: `method ${request.method} not allowed` });
  };
}
