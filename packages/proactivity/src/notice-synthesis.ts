// Proactive-notice synthesis — one-shot LLM prose over an imminent item's
// factSheet, gated by an optional faithfulness reverify before delivery.

import { composeSurfacePrompt } from "@muse/prompts";

import type { ImminentItem } from "./notice-imminent.js";
import type { RunDueProactiveNoticesOptions } from "./proactive-notice-loop.js";

/**
 * Structural duck-type of `@muse/agent-core`'s `AgentRuntime.run`.
 * Avoids a cross-package dep (@muse/proactivity doesn't import
 * agent-core to dodge the circular path).
 * Consumers (apps/api) pass the real AgentRuntime — TS structural
 * typing makes that work without a runtime type tag.
 *
 * @deprecated Notice synthesis is one-shot text generation; the
 * tool registry the AgentRuntime wires in causes small models
 * (≤ 3B params) to emit raw `tool_calls` JSON instead of prose.
 * Prefer `ProactiveModelProviderLike` (set `modelProvider` in
 * the options).
 */
export interface ProactiveAgentRuntimeLike {
  run(input: {
    readonly model: string;
    readonly messages: readonly { readonly role: "system" | "user" | "assistant"; readonly content: string }[];
    /** Marks a machine-authored run so conversational layers (register/brevity) stay off. */
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): Promise<{ readonly response: { readonly output: string } }>;
}

/**
 * Structural duck-type of `@muse/model`'s `ModelProvider.generate`.
 * Notice synthesis only needs raw text generation — no tools, no
 * agent loop. Calling `generate({ tools: undefined })` keeps the
 * model from seeing the (otherwise distracting) `muse.tasks.*` /
 * `muse.calendar.*` registry and emitting tool-call JSON instead
 * of plain prose. Discovered via local-LLM dogfood with qwen2.5
 * 1.5B; cloud models silently accepted the system instruction
 * but small local models followed the tools instead.
 */
export interface ProactiveModelProviderLike {
  generate(request: {
    readonly model: string;
    readonly messages: readonly { readonly role: "system" | "user" | "assistant"; readonly content: string }[];
    readonly maxOutputTokens?: number;
    readonly temperature?: number;
  }): Promise<{ readonly output: string }>;
}

const PHASE_D_BASE_PROMPT = "Examples of a good next step: \"want me to pull up yesterday's notes?\", \"shall I "
  + "draft the reply?\". Skip the suggestion if nothing obvious fits. Do NOT prefix with the time emoji — the "
  + "surface adds it. No markdown, no lists, no JSON, plain text only.";

/**
 * Compose the Phase D system prompt, folding an optional persona preamble in
 * as the L1 personality layer (between identity and the proactive role text)
 * rather than string-prepending it — a raw prepend would push identity out of
 * position 0 of the overall system content.
 */
function buildProactiveSystemPrompt(personaPreamble?: string): string {
  const trimmed = personaPreamble?.trim();
  return composeSurfacePrompt(
    "proactive",
    { basePrompt: PHASE_D_BASE_PROMPT },
    trimmed ? { layers: [{ content: trimmed, id: "personality", section: "stable" }] } : {}
  );
}

const PHASE_D_SYSTEM_PROMPT = buildProactiveSystemPrompt();

/**
 * Faithfulness judge for a synthesized proactive notice — re-checks the LLM prose
 * against the item's factSheet (its only source) and returns YES/NO. Structural type
 * (no agent-core dependency in this package); the daemon caller builds it from the
 * same reverify primitives the reflection gate uses.
 */
export type NoticeGroundingReverify = (input: {
  readonly answer: string;
  readonly evidence: string;
  readonly query: string;
}) => Promise<boolean>;

const NOTICE_GROUNDING_QUERY =
  "Does this heads-up state ONLY facts present in the item details (time, title, location)?";

export async function synthesizeNoticeText(
  item: ImminentItem,
  options: Pick<RunDueProactiveNoticesOptions, "agentModel" | "modelProvider" | "agentRuntime" | "personaPreamble" | "reverify">
): Promise<string> {
  if (!options.agentModel) {
    return item.text;
  }
  const systemContent = options.personaPreamble && options.personaPreamble.trim().length > 0
    ? buildProactiveSystemPrompt(options.personaPreamble)
    : PHASE_D_SYSTEM_PROMPT;
  const messages = [
    { content: systemContent, role: "system" as const },
    { content: item.factSheet, role: "user" as const }
  ];
  let reply: string;
  if (options.modelProvider) {
    // Preferred path — raw text gen, no tools, no agent loop.
    const result = await options.modelProvider.generate({
      maxOutputTokens: 200,
      messages,
      model: options.agentModel,
      temperature: 0.4
    });
    reply = result.output.trim();
  } else if (options.agentRuntime) {
    // Machine-authored synthesis input — not a human conversational turn.
    const result = await options.agentRuntime.run({ messages, metadata: { internalTurn: true }, model: options.agentModel });
    reply = result.response.output.trim();
  } else {
    return item.text;
  }
  // Defensive: if the model output looks like a tool-call JSON object
  // (small local models love doing this even when the prompt forbids
  // it), drop back to the flat text instead of delivering junk.
  if (reply.length === 0 || looksLikeToolCallJson(reply)) {
    return item.text;
  }
  // Faithfulness gate: the synthesized heads-up is free T=0.4 prose over the
  // factSheet — re-check it's grounded there before PUSHING it (an unasked notice
  // with a wrong time / invented location is a maximally-damaging fabrication). A
  // NO / throw / empty-evidence verdict fails CLOSE to the verbatim, store-grounded
  // item.text — never silence, never the unverified synthesis.
  if (options.reverify) {
    const evidence = item.factSheet.trim();
    if (evidence.length === 0) return item.text;
    let grounded: boolean;
    try {
      grounded = await options.reverify({ answer: reply, evidence: item.factSheet, query: NOTICE_GROUNDING_QUERY });
    } catch {
      return item.text;
    }
    if (!grounded) return item.text;
  }
  // Prepend the same emoji the flat path uses so the messaging
  // channel keeps a visual signal.
  const prefix = item.kind === "calendar" ? "⏰" : "📋";
  return reply.startsWith(prefix) ? reply : `${prefix} ${reply}`;
}

/**
 * Heuristic: a synthesized notice should be prose, not JSON. The
 * 1.5B / 3B local models occasionally emit a `{"name":"muse.tasks.add",...}`
 * payload despite the "plain text only" instruction in the system
 * prompt. Catch and reject so the messaging channel never receives
 * a literal tool-call envelope as the user-visible text.
 */
function looksLikeToolCallJson(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  // Tolerate a leading emoji + space — that's our own prefix.
  const stripped = trimmed.replace(/^[^\w{[]+/, "");
  if (!stripped.startsWith("{") && !stripped.startsWith("[")) return false;
  try {
    const parsed = JSON.parse(stripped) as unknown;
    // Any JSON parse success on a synthesized reply is a tool-call leak.
    return parsed !== null && typeof parsed === "object";
  } catch {
    return false;
  }
}
