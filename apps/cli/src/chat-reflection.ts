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

import { extractJsonObject } from "@muse/memory";
import { stripUntrustedTerminalChars } from "@muse/shared";

import { recurringEpisodeThreads, type RecurringThread } from "./chat-ink-core.js";

export const CHAT_REFLECTION_SYSTEM =
  "You are Muse reflecting on the user's PAST SESSIONS. From ONLY the session summaries and recurring topics given, write ONE short, useful observation a personal assistant would notice — a thread the user keeps returning to, an unresolved follow-up they mentioned, or a pattern across sessions. " +
  "Output ONLY a JSON object, no prose: {\"insight\":\"<one sentence, second person, under 30 words>\"}. " +
  "If there is no honest cross-session pattern, output {\"insight\":\"\"}. " +
  "Ground EVERY word in the given summaries — never invent a fact, name, date, number, or topic that is not present. Prefer a recurring or unresolved thread over a one-off. " +
  "Examples: summaries that mention the Q3 budget in three different sessions without resolving it → {\"insight\":\"You've come back to the Q3 budget across several sessions without closing it — want to make a plan?\"}; " +
  "a single session about an unrelated one-off, or summaries with no shared thread → {\"insight\":\"\"}. Never fabricate a pattern to fill the field.";

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
    const payload = extractJsonObject(response.output) as unknown as Record<string, unknown> | undefined;
    const insight = payload && typeof payload.insight === "string" ? payload.insight : "";
    return stripUntrustedTerminalChars(insight).replace(/\s+/gu, " ").trim().slice(0, 240);
  } catch {
    return "";
  }
}

/** Wrap the insight (or its absence) into the line `/reflect` prints. */
export function formatReflection(insight: string): string {
  return insight.length > 0
    ? `🪞 ${insight}`
    : "Nothing stands out across your sessions yet — I'll reflect once there's more of a thread.";
}
