/**
 * Cross-session reflection ("Hindsight"-style synthesis) for `/reflect`: given
 * the user's recent session summaries + the deterministically-detected recurring
 * threads, ask the LOCAL model for ONE grounded observation a personal assistant
 * would notice — a thread they keep returning to, an unresolved follow-up, a
 * pattern. Distinct from `recurringEpisodeThreads` (pure counting): this is the
 * LLM synthesis layer, deliberately fenced so a small model can't hallucinate.
 *
 * The fence is the same discipline that made auto-memory reliable on qwen3:8b:
 * output-ONLY JSON, concrete + NEGATIVE examples, "ground every word / never
 * invent", and an empty-signal (`{"insight":""}`) so "no honest pattern" is a
 * first-class answer rather than a forced fabrication.
 */

import {
  REFLECTION_GROUNDING_QUERY,
  REVERIFY_RESPONSE_FORMAT,
  REVERIFY_SYSTEM_PROMPT,
  buildGroundingReverifyPrompt,
  parseGroundingReverifyJson,
  type GroundingReverify
} from "@muse/agent-core";
import { extractJsonObject } from "@muse/memory";
import { composeSurfacePrompt } from "@muse/prompts";
import { isRecord, stripUntrustedTerminalChars } from "@muse/shared";

import { recurringEpisodeThreads, type RecurringThread } from "./chat-ink-core.js";

const CHAT_REFLECTION_SYSTEM = composeSurfacePrompt("chatReflect", {});

export interface ReflectionEpisode {
  readonly endedAt: string;
  readonly summary: string;
  readonly topics?: readonly string[];
}

export interface ReflectionProvider {
  generate(request: {
    readonly model: string;
    readonly messages: readonly { readonly role: "system" | "user" | "assistant"; readonly content: string }[];
    readonly temperature?: number;
    readonly maxOutputTokens?: number;
    readonly responseFormat?: Record<string, unknown>;
  }): Promise<{ readonly output?: string }>;
}

/** Schema the reflection output is constrained to (native structured output);
 * `""` is a valid insight = "no honest cross-session pattern". */
const REFLECTION_SCHEMA = {
  type: "object",
  properties: { insight: { type: "string" } },
  required: ["insight"],
  additionalProperties: false
} as const;

/** Minimum distinct sessions before a reflection is worth attempting — below
 * this there is no cross-session material and the model would only guess. */
export const REFLECTION_MIN_EPISODES = 2;

/** The material block handed to the model: dated summaries + the recurring
 * threads, both bounded so a long history can't blow the synthesis call. */
export function buildReflectionInput(
  episodes: readonly ReflectionEpisode[],
  threads: readonly RecurringThread[]
): string {
  const summaryLines = episodes
    .slice(-12)
    .map((episode) => {
      const date = /^\d{4}-\d{2}-\d{2}/u.test(episode.endedAt) ? episode.endedAt.slice(0, 10) : episode.endedAt;
      const topicSuffix = episode.topics && episode.topics.length > 0 ? ` [${episode.topics.join(", ")}]` : "";
      return `- ${date}: ${stripUntrustedTerminalChars(episode.summary).replace(/\s+/gu, " ").trim().slice(0, 200)}${topicSuffix}`;
    });
  const threadLine = threads.length > 0
    ? `Recurring topics (sessions): ${threads.map((t) => `${t.topic} (${t.sessions})`).join(", ")}`
    : "Recurring topics: none detected.";
  return `Session summaries (oldest first):\n${summaryLines.join("\n")}\n\n${threadLine}`;
}

/**
 * Synthesize one grounded cross-session insight, or "" when there is no honest
 * pattern / too little material / the model or JSON failed. Deterministically
 * short-circuits below `REFLECTION_MIN_EPISODES` so the model is never asked to
 * reflect on nothing.
 */
export async function synthesizeReflection(opts: {
  readonly provider: ReflectionProvider;
  readonly model: string;
  readonly episodes: readonly ReflectionEpisode[];
  /**
   * Faithfulness gate (RGV) — re-checks the synthesized insight against the TEXT
   * of the episodes it abstracts, exactly as the OFFLINE dreaming path does
   * ({@link verifyReflectionsGrounding}). Fail-close: an insight the judge does
   * not support — or an unverifiable one (empty evidence / judge error) — is
   * DROPPED, so a confabulated "I've noticed you keep …" cross-session
   * observation never reaches the live chat (GROUNDED≠TRUE on the user-facing
   * reflection surface). Optional → mirrors the offline path's optional reverify;
   * the in-chat caller always supplies it.
   */
  readonly reverify?: GroundingReverify;
}): Promise<string> {
  const episodes = opts.episodes.filter((episode) => episode.summary.trim().length > 0);
  if (episodes.length < REFLECTION_MIN_EPISODES) return "";
  const threads = recurringEpisodeThreads(episodes, { minSessions: 2, max: 5 });
  try {
    const response = await opts.provider.generate({
      maxOutputTokens: 256,
      messages: [
        { content: CHAT_REFLECTION_SYSTEM, role: "system" },
        { content: buildReflectionInput(episodes, threads), role: "user" }
      ],
      model: opts.model,
      // Native structured output where supported → guaranteed {"insight": …}
      // JSON; extractJsonObject below stays as the fallback for providers that
      // ignore responseFormat (no structuredOutput capability).
      responseFormat: REFLECTION_SCHEMA,
      temperature: 0
    });
    if (!response.output) return "";
    const rawPayload = extractJsonObject(response.output);
    const payload = isRecord(rawPayload) ? rawPayload : undefined;
    const raw = payload && typeof payload.insight === "string" ? payload.insight : "";
    const insight = stripUntrustedTerminalChars(raw).replace(/\s+/gu, " ").trim().slice(0, 240);
    if (insight.length === 0 || !opts.reverify) return insight;
    // Re-check the insight against the episodes it abstracts. Empty evidence is
    // unverifiable → fail-close; a judge NO or error drops the insight.
    const evidence = episodes.map((episode) => episode.summary.trim()).filter(Boolean).join("\n");
    if (evidence.length === 0) return "";
    try {
      const supported = await opts.reverify({ answer: insight, evidence, query: REFLECTION_GROUNDING_QUERY });
      return supported ? insight : "";
    } catch {
      return "";
    }
  } catch {
    return "";
  }
}

/**
 * Build the one-shot local-model faithfulness judge the in-chat reflection passes
 * to {@link synthesizeReflection} — the SAME reverify the offline dreaming path uses
 * (`runReflectionPass`), so the live `/reflect` surface is gated identically. The
 * judge re-checks the insight against its cited evidence and returns YES/NO.
 */
export function buildModelGroundingReverify(provider: ReflectionProvider, model: string): GroundingReverify {
  return async ({ answer, evidence, query }) => {
    const judged = await provider.generate({
      maxOutputTokens: 24,
      messages: [
        { content: REVERIFY_SYSTEM_PROMPT, role: "system" },
        { content: buildGroundingReverifyPrompt({ answer, evidence, query }), role: "user" }
      ],
      model,
      responseFormat: REVERIFY_RESPONSE_FORMAT,
      temperature: 0
    });
    return parseGroundingReverifyJson(judged.output ?? "");
  };
}

/** Wrap the insight (or its absence) into the line `/reflect` prints. */
export function formatReflection(insight: string): string {
  return insight.length > 0
    ? `🪞 ${insight}`
    : "Nothing stands out across your sessions yet — I'll reflect once there's more of a thread.";
}
