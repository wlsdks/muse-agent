import type { ModelMessage } from "@muse/model";

import type { CouncilModelOptions } from "./council.js";
import { lexicalTokens } from "./knowledge-recall.js";

/**
 * Multi-agent orchestration for one answer — the **Mixture-of-Agents** pattern
 * (parallel specialized proposers → one aggregator), the 2026 best practice for
 * local multi-agent (arXiv:2511.15755 — quality, not speed, is the win; the
 * parallelism keeps wall-clock contained, which the local Ollama batches).
 *
 * The orchestration is controlled by the five decisions of arXiv:2605.02801:
 *   • spawn   — `shouldOrchestrate(question)` routes simple turns to ONE fast
 *               call and complex turns to the panel (don't pay for a greeting).
 *   • delegate — `roles`, each a distinct specialist (practical / thorough /
 *               skeptic), so specialization beats one generalist.
 *   • communicate — proposers run INDEPENDENTLY in parallel (no inter-agent
 *               dependency, so the GPU batches them; a debate round is a later
 *               refinement).
 *   • aggregate — `synthesizeCouncilAnswer` folds the proposals into one grounded
 *               answer, dropping any proposal it can't support (this is what kills
 *               an off-topic / hallucinated proposal).
 *   • stop      — one round, then synthesize.
 */
export interface OrchestrationRole {
  readonly id: string;
  readonly systemPrompt: string;
}

export interface OrchestrationProposal {
  readonly id: string;
  readonly text: string;
}

export interface OrchestratedAnswer {
  readonly answer: string;
  readonly mode: "single" | "orchestrated";
  /** Each proposer's output — the visible "process" (and the audit trail). */
  readonly proposals: readonly OrchestrationProposal[];
  /** Proposer ids the synthesized answer actually drew on. */
  readonly contributors: readonly string[];
  /**
   * Role ids whose proposer call threw — the panel degraded to the survivors but
   * still produced an answer. Empty/absent on a clean run; surfaced (never
   * swallowed) so a caller can see the panel ran short.
   */
  readonly failedRoles?: readonly string[];
}

export interface OrchestrateOptions extends CouncilModelOptions {
  readonly roles?: readonly OrchestrationRole[];
  /** spawn decision — true ⇒ run the panel, false ⇒ one fast call. */
  readonly shouldOrchestrate?: (question: string) => boolean;
  /** Ask the proposers to reason natively first (Qwen `think`). */
  readonly reasoning?: boolean;
  /** Called as each proposer finishes — for streaming the live process. */
  readonly onProposal?: (proposal: OrchestrationProposal) => void;
}

/**
 * Dedupe proposer roles by id (first occurrence wins) — MAST "no duplicated
 * sub-agent work": two roles with the same id would run a redundant proposer
 * (wasted inference) AND yield two proposals sharing an id, corrupting
 * contributor attribution. Order-preserving. Empty/blank-id roles are kept as-is
 * (id integrity is the caller's; this only collapses exact-id duplicates).
 */
export function dedupeRolesById(roles: readonly OrchestrationRole[]): readonly OrchestrationRole[] {
  const seen = new Set<string>();
  const out: OrchestrationRole[] = [];
  for (const role of roles) {
    if (seen.has(role.id)) continue;
    seen.add(role.id);
    out.push(role);
  }
  return out;
}

/** Three complementary lenses — diverse enough to cover, aligned with the grounding edge. */
export const DEFAULT_ROLES: readonly OrchestrationRole[] = [
  {
    id: "practical",
    systemPrompt:
      "You are a practical assistant. Answer the user's question directly and concisely with concrete, actionable steps. Stay STRICTLY on the user's topic — never drift to an unrelated subject. Plain text."
  },
  {
    id: "thorough",
    systemPrompt:
      "You are a thorough assistant. Answer the user's question completely and carefully, covering the important details and caveats. Stay STRICTLY on the user's topic. Plain text."
  },
  {
    id: "skeptic",
    systemPrompt:
      "You are a careful fact-checker. Answer the user's question, but flag anything uncertain and never invent specifics you don't know. If you cannot answer from real knowledge, say so plainly rather than guessing. Stay STRICTLY on the user's topic. Plain text."
  }
];

/**
 * Default spawn heuristic: trivial / chit-chat turns stay single (a panel adds
 * latency with no quality gain on "hi"); substantive questions get the panel.
 * Cheap + deterministic — no extra model call to decide.
 */
export function defaultShouldOrchestrate(question: string): boolean {
  const q = question.trim();
  if (q.length < 14) return false;
  // A question mark, an imperative ask, or multiple clauses ⇒ worth the panel.
  const substantive = /[?？]|어떻게|왜|방법|알려|설명|정리|비교|분석|how|why|what|explain|compare|write|code|작성|코드/iu.test(q)
    || q.length >= 40;
  return substantive;
}

const AGGREGATOR_SYSTEM_PROMPT =
  "You are given the user's question and several candidate answers written by different assistants. " +
  "Produce the SINGLE BEST answer to the user's question by merging the candidates' strengths. " +
  "Keep concrete details VERBATIM (code blocks, exact steps, numbers, commands). Discard anything off-topic, " +
  "incorrect, or merely hedging. Answer the user directly, in the user's language. Do NOT mention the candidates " +
  "or that you merged anything. Output only the answer.";

/**
 * Which proposals the merged answer ACTUALLY drew on — a proposal counts as a
 * contributor when the merge lexically covers at least `floor` of its content
 * tokens (the aggregator discards off-topic/incorrect proposals, so a dropped
 * one shows near-zero overlap). Honest attribution for the audit trail (MAST:
 * the `contributors` claim must match what aggregation did, not list everyone).
 * If NO proposal clears the floor (a heavy paraphrase), fall back to ALL ids —
 * never under-claim to an empty trail on a real merged answer.
 */
export function attributeContributors(
  merged: string,
  proposals: readonly OrchestrationProposal[],
  floor = 0.4
): readonly string[] {
  const mergedTokens = lexicalTokens(merged);
  const drawn = proposals.filter((p) => {
    const pt = lexicalTokens(p.text);
    if (pt.size === 0) return false;
    let covered = 0;
    for (const t of pt) if (mergedTokens.has(t)) covered += 1;
    return covered / pt.size >= floor;
  });
  return (drawn.length > 0 ? drawn : proposals).map((p) => p.id);
}

/** aggregate = merge the parallel proposals into the single best answer (MoA). */
async function aggregate(question: string, proposals: readonly OrchestrationProposal[], options: OrchestrateOptions): Promise<string> {
  const candidates = proposals.map((p, i) => `### Candidate ${(i + 1).toString()}\n${p.text}`).join("\n\n");
  const messages: ModelMessage[] = [
    { content: AGGREGATOR_SYSTEM_PROMPT, role: "system" },
    { content: `User question:\n${options.redact ? options.redact(question) : question}\n\nCandidate answers:\n${candidates}`, role: "user" }
  ];
  const response = await options.modelProvider.generate({
    messages,
    model: options.model,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {})
  });
  return response.output.trim();
}

async function runRole(question: string, role: OrchestrationRole, options: OrchestrateOptions): Promise<string> {
  const messages: ModelMessage[] = [
    { content: role.systemPrompt, role: "system" },
    { content: options.redact ? options.redact(question) : question, role: "user" }
  ];
  const response = await options.modelProvider.generate({
    messages,
    model: options.model,
    ...(options.reasoning ? { reasoning: true } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {})
  });
  return response.output.trim();
}

export async function orchestrateAnswer(question: string, options: OrchestrateOptions): Promise<OrchestratedAnswer> {
  const decide = options.shouldOrchestrate ?? defaultShouldOrchestrate;
  const roleList = dedupeRolesById(options.roles && options.roles.length > 0 ? options.roles : DEFAULT_ROLES);
  const primary = roleList[0];
  if (!primary) throw new Error("orchestrateAnswer requires at least one role");

  // spawn = false → single fast path.
  if (!decide(question)) {
    const single = await runRole(question, primary, options);
    return { answer: single, contributors: [primary.id], mode: "single", proposals: [{ id: primary.id, text: single }] };
  }

  // communicate = parallel independent proposers (the GPU batches them).
  // Resilient by allSettled: one proposer failing (a flaky local-model call) must
  // not sink the whole panel — degrade to the survivors and surface which dropped.
  const settled = await Promise.allSettled(
    roleList.map(async (role): Promise<OrchestrationProposal> => {
      const text = await runRole(question, role, options);
      const proposal: OrchestrationProposal = { id: role.id, text };
      options.onProposal?.(proposal);
      return proposal;
    })
  );
  const proposals: OrchestrationProposal[] = [];
  const failedRoles: string[] = [];
  // An empty/whitespace proposer output is a degraded sub-agent, not a candidate.
  settled.forEach((outcome, index) => {
    if (outcome.status === "fulfilled" && outcome.value.text.trim().length > 0) {
      proposals.push(outcome.value);
    } else {
      failedRoles.push(roleList[index]?.id ?? `role-${index.toString()}`);
    }
  });
  // fail-close: every proposer failed → nothing to synthesize, surface it loudly.
  if (proposals.length === 0) {
    throw new Error(`orchestrateAnswer: all ${roleList.length.toString()} proposers failed`);
  }
  const degraded = failedRoles.length > 0 ? { failedRoles } : {};

  // One survivor → its answer IS the panel result; a merge of a single candidate
  // only risks the aggregator mangling a good answer, so skip the wasted call.
  const [only] = proposals;
  if (proposals.length === 1 && only) {
    return { answer: only.text, contributors: [only.id], mode: "orchestrated", proposals, ...degraded };
  }

  // A flaky aggregator call must degrade like a proposer (allSettled above), not sink the
  // whole panel — a throw becomes an empty merge, which the fallback below handles.
  let merged: string;
  try {
    merged = await aggregate(question, proposals, options);
  } catch {
    merged = "";
  }
  if (merged.length === 0) {
    // Aggregator returned nothing → fall back to the thorough proposal if present.
    const fallback = proposals.find((p) => p.id === "thorough") ?? proposals[0] ?? { id: primary.id, text: "" };
    return { answer: fallback.text, contributors: [fallback.id], mode: "orchestrated", proposals, ...degraded };
  }
  return { answer: merged, contributors: attributeContributors(merged, proposals), mode: "orchestrated", proposals, ...degraded };
}
