/**
 * Mixture-of-Agents advisory fan-out (DS-15).
 *
 * A DIFFERENT axis from `council-*` (which is a peer/swarm DEBATE with rounds,
 * consensus and dissent detection). This is the simpler single-device,
 * single-turn quality booster: N advisory "reference" local models answer the
 * SAME question in PARALLEL, read-only and tool-less, then ONE "acting" model
 * writes the final answer HAVING SEEN the references. No rounds, no voting.
 *
 * Two deliberate properties carried over from the Mixture-of-Agents idea:
 *
 *   - **Prefix-stable prompt.** The reference guidance is appended as a NEW
 *     system message at the END of the acting model's messages, AFTER the
 *     original conversation. The prefix (everything the reference calls also
 *     saw) is byte-identical across every reference call and the acting call,
 *     so provider-side prompt caching is preserved.
 *   - **Advisory only.** Reference slots run with NO tools and `reasoning:false`
 *     (fast) — they produce text on the user's question and nothing else. Only
 *     the acting model's response is the answer.
 *
 * Fully opt-in: this is a standalone exported function a caller invokes
 * explicitly. It is NOT wired into the default `muse ask` / chat runtime loop.
 */

import type { ModelMessage, ModelProvider, ModelRequest, ModelResponse, ModelUsage } from "@muse/model";

export interface MoaSlot {
  readonly provider: Pick<ModelProvider, "generate">;
  readonly model: string;
  /**
   * Label for this advisor in the appended reference block, e.g. "gemma".
   * Omitted ⇒ a positional default ("Advisor A", "Advisor B", …).
   */
  readonly label?: string;
}

export interface MoaReferenceUsage {
  readonly index: number;
  readonly label: string;
  readonly model: string;
  readonly usage?: ModelUsage;
}

export interface MoaActingUsage {
  readonly model: string;
  readonly usage?: ModelUsage;
}

export interface MoaFanoutOptions {
  /** The conversation to answer — the SAME messages every reference sees. */
  readonly messages: readonly ModelMessage[];
  /** Advisory models run in parallel, read-only. 2–3 typical. May be empty. */
  readonly references: readonly MoaSlot[];
  /** The model that writes the final answer, having seen the references. */
  readonly acting: MoaSlot;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  /** Threaded into every reference call AND the acting call. */
  readonly signal?: AbortSignal;
  /**
   * Native reasoning for the ACTING call only (references are always
   * `reasoning:false`). Off by default.
   */
  readonly actingReasoning?: boolean;
  /**
   * Per-reference usage attribution — invoked once per reference slot (even a
   * failed one, with `usage` absent) so a caller wiring a usage sink can
   * attribute each advisor to ITS OWN model, never folded into the acting
   * model's count. Optional: omit to skip attribution entirely.
   */
  readonly onReferenceUsage?: (info: MoaReferenceUsage) => void;
  /** Usage attribution for the acting call. Optional. */
  readonly onActingUsage?: (info: MoaActingUsage) => void;
}

export interface MoaReferenceResult {
  readonly index: number;
  readonly label: string;
  readonly model: string;
  readonly ok: boolean;
  readonly output?: string;
  readonly error?: unknown;
}

export interface MoaFanoutResult {
  /** The acting model's response — the final answer. */
  readonly response: ModelResponse;
  /** One entry per reference slot, in input order (successes and failures). */
  readonly references: readonly MoaReferenceResult[];
  /**
   * The exact messages sent to the acting model. When at least one reference
   * succeeded this is `[...messages, <appended reference system message>]`;
   * when NO reference succeeded it is the original `messages` unchanged.
   */
  readonly actingMessages: readonly ModelMessage[];
  /** True when the reference block was appended (≥1 reference succeeded). */
  readonly referenceBlockAppended: boolean;
}

const DEFAULT_LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function labelFor(slot: MoaSlot, index: number): string {
  const trimmed = slot.label?.trim();
  if (trimmed) return trimmed;
  return `Advisor ${DEFAULT_LABELS[index] ?? String(index + 1)}`;
}

/**
 * The reference guidance block, appended as a trailing system message. Kept
 * deterministic (pure) so it can be asserted directly in tests.
 */
export function buildReferenceBlock(references: readonly { readonly label: string; readonly output: string }[]): string {
  const perspectives = references
    .map(({ label, output }) => `[${label}]:\n${output.trim()}`)
    .join("\n\n");
  return (
    "Other perspectives on this question, from independent local models (advisory only — " +
    "weigh them and reconcile disagreement; do NOT merely repeat them, and do not treat them " +
    "as authoritative):\n\n" +
    perspectives
  );
}

/**
 * Run the advisory fan-out. Reference `generate()` calls fire in PARALLEL via
 * `Promise.allSettled` — one rejecting reference never kills the others or the
 * whole call. If ALL references fail (or none are supplied) the acting model is
 * called with just the original messages, so the fan-out degrades to a plain
 * single-model answer rather than emitting an empty/malformed block.
 */
export async function moaFanout(options: MoaFanoutOptions): Promise<MoaFanoutResult> {
  const { messages, references, acting } = options;

  const settled = await Promise.allSettled(
    references.map((slot) => {
      const request: ModelRequest = {
        model: slot.model,
        messages,
        temperature: options.temperature,
        maxOutputTokens: options.maxOutputTokens,
        signal: options.signal,
        reasoning: false,
      };
      return slot.provider.generate(request);
    }),
  );

  const results: MoaReferenceResult[] = references.map((slot, index) => {
    const label = labelFor(slot, index);
    const outcome = settled[index]!;
    if (outcome.status === "fulfilled") {
      options.onReferenceUsage?.({ index, label, model: slot.model, usage: outcome.value.usage });
      return { index, label, model: slot.model, ok: true, output: outcome.value.output };
    }
    options.onReferenceUsage?.({ index, label, model: slot.model });
    return { index, label, model: slot.model, ok: false, error: outcome.reason };
  });

  const usable = results.filter(
    (r): r is MoaReferenceResult & { output: string } => r.ok && typeof r.output === "string" && r.output.trim().length > 0,
  );

  const referenceBlockAppended = usable.length > 0;
  const actingMessages: readonly ModelMessage[] = referenceBlockAppended
    ? [...messages, { role: "system", content: buildReferenceBlock(usable) }]
    : messages;

  const actingRequest: ModelRequest = {
    model: acting.model,
    messages: actingMessages,
    temperature: options.temperature,
    maxOutputTokens: options.maxOutputTokens,
    signal: options.signal,
    reasoning: options.actingReasoning ?? false,
  };
  const response = await acting.provider.generate(actingRequest);
  options.onActingUsage?.({ model: acting.model, usage: response.usage });

  return { response, references: results, actingMessages, referenceBlockAppended };
}
