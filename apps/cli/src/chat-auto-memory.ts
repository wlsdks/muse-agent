/**
 * Background auto-memory for the chat: after a turn, quietly extract durable
 * facts/preferences the user STATED in passing ("I live in Busan", "I prefer
 * short answers") — so Muse remembers without being told "remember this".
 *
 * Reuses the same extractor the agent-runtime hook uses
 * (`pickAutoExtractSystemPrompt` + `extractJsonObject`), but runs it
 * fire-and-forget AFTER the reply so the snappy `provider.stream` chat path
 * isn't slowed (the runtime hook awaits afterComplete, which would block). A
 * cooldown keeps it from firing every trivial turn.
 */

import { dropModelAssertedValues, extractJsonObject, formatLearnedConfirmation, selectNewSupersessions, type UserMemoryStore } from "@muse/memory";

// A sharper, example-bearing extraction prompt than the shared agent-runtime
// one — verified to extract reliably on the LOCAL qwen3:8b tier (the shared
// prompt returned empty on clear facts; see EXPANSION-LOG.md). Output-only JSON
// + concrete examples are what make the small model comply in one shot.
const CHAT_AUTO_EXTRACT_SYSTEM =
  "You extract durable personal facts/preferences the USER stated about THEMSELVES in the conversation. " +
  "Output ONLY a JSON object, no prose: {\"facts\":{\"<snake_key>\":\"<value>\"},\"preferences\":{\"<snake_key>\":\"<value>\"}}. " +
  "Put a FACT when the user states where they live, their name, job, diet, or people/things in their life (e.g. {\"home_city\":\"Busan\"}). " +
  "Put a PREFERENCE for how they like replies/behavior (e.g. {\"reply_length\":\"short\"}). " +
  "ONLY extract from a DECLARATIVE statement the user makes about THEMSELVES. " +
  "Do NOT infer from questions, requests, or topics they merely mention — e.g. " +
  "\"What's the weather in Busan?\" → {\"facts\":{},\"preferences\":{}} (they did NOT say they live in Busan); " +
  "\"Remind me to call mom\" → {\"facts\":{},\"preferences\":{}} (a task, not a durable fact). " +
  "If the user stated nothing durable about themselves, return {\"facts\":{},\"preferences\":{}}. Never invent.";

export interface AutoMemoryProvider {
  generate(request: {
    readonly model: string;
    readonly messages: readonly { readonly role: "system" | "user" | "assistant"; readonly content: string }[];
    readonly temperature?: number;
    readonly maxOutputTokens?: number;
    readonly responseFormat?: Record<string, unknown>;
  }): Promise<{ readonly output?: string }>;
}

/** Schema the extraction is constrained to (native structured output): two
 * string→string maps. Empty maps mean "nothing durable was stated". */
const AUTO_EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    facts: { type: "object", additionalProperties: { type: "string" } },
    preferences: { type: "object", additionalProperties: { type: "string" } }
  },
  required: ["facts", "preferences"],
  additionalProperties: false
} as const;

/** Cooldown gate — don't run the extra extraction call more than once per gap. */
export function shouldAutoExtract(lastMs: number | undefined, nowMs: number, minGapMs = 45_000): boolean {
  return lastMs === undefined || nowMs - lastMs >= minGapMs;
}

/**
 * Extract the facts/preferences newly stated in one user↔assistant exchange.
 * Returns empty records when nothing durable was said (or the model/JSON
 * failed). Bounds the input so a huge turn can't blow the extra call.
 */
export async function extractMemoryFromTurn(opts: {
  readonly provider: AutoMemoryProvider;
  readonly model: string;
  readonly user: string;
  readonly assistant: string;
}): Promise<{ facts: Record<string, string>; preferences: Record<string, string> }> {
  const empty = { facts: {}, preferences: {} };
  const user = opts.user.slice(0, 4000);
  const assistant = opts.assistant.slice(0, 4000);
  try {
    const response = await opts.provider.generate({
      maxOutputTokens: 512,
      messages: [
        { content: CHAT_AUTO_EXTRACT_SYSTEM, role: "system" },
        { content: `User: ${user}\nAssistant: ${assistant}`, role: "user" }
      ],
      model: opts.model,
      // Constrain to the {facts,preferences} schema where supported (Ollama);
      // extractJsonObject below stays as the fallback for providers that ignore it.
      responseFormat: AUTO_EXTRACT_SCHEMA,
      temperature: 0
    });
    if (!response.output) return empty;
    const payload = extractJsonObject(response.output);
    if (!payload) return empty;
    const pickStrings = (record: Readonly<Record<string, string>> | undefined): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(record ?? {})) {
        if (typeof value === "string" && value.trim().length > 0) out[key] = value;
      }
      return out;
    };
    // Provenance gate: drop a fact/preference whose value the MODEL asserted in
    // its reply but the USER never said (absent from their turn) — so a question
    // answered with a fact ("what's WireGuard's MTU?" → "1420") is never stored
    // as "what you told me". A user-stated value survives.
    return {
      facts: dropModelAssertedValues(pickStrings(payload.facts), user, assistant),
      preferences: dropModelAssertedValues(pickStrings(payload.preferences), user, assistant)
    };
  } catch {
    return empty;
  }
}

/**
 * One-line, terminal-safe summary of what auto-memory just learned, for a
 * subtle in-chat notice so the user SEES what Muse stored (and can /forget it).
 * Returns undefined when nothing was learned.
 */
export function formatLearnedSummary(
  facts: Readonly<Record<string, string>>,
  preferences: Readonly<Record<string, string>>
): string | undefined {
  const parts = [...Object.entries(facts), ...Object.entries(preferences)]
    .map(([key, value]) => `${key} = ${value.replace(/\s+/gu, " ").trim().slice(0, 40)}`);
  return parts.length > 0 ? `📝 remembered: ${parts.join(" · ")} (/forget <key> to undo)` : undefined;
}

/**
 * Write a chat turn's extracted facts/preferences to the store and report what
 * the user can SEE: a cited confirmation for CHANGES (a correction — "Got it,
 * home city is now Busan, changed from Seoul", from selectNewSupersessions +
 * formatLearnedConfirmation over the factHistory before/after) and a plain
 * "remembered" summary for the newly-learned keys. A changed key appears only in
 * the confirmation (not double-listed). Deterministic + cited; the model never
 * picks what to surface.
 */
export async function applyTurnLearnings(
  store: UserMemoryStore,
  userId: string,
  facts: Readonly<Record<string, string>>,
  preferences: Readonly<Record<string, string>>
): Promise<{ readonly summary?: string; readonly confirmation?: string }> {
  const before = (await Promise.resolve(store.findByUserId(userId)))?.factHistory ?? [];
  const wroteFacts: Record<string, string> = {};
  const wrotePrefs: Record<string, string> = {};
  for (const [key, value] of Object.entries(facts).slice(0, 5)) {
    await Promise.resolve(store.upsertFact(userId, key, value));
    wroteFacts[key] = value;
  }
  for (const [key, value] of Object.entries(preferences).slice(0, 5)) {
    await Promise.resolve(store.upsertPreference(userId, key, value));
    wrotePrefs[key] = value;
  }
  const after = await Promise.resolve(store.findByUserId(userId));
  const changes = selectNewSupersessions(before, after?.factHistory ?? []);
  const changedKeys = new Set(changes.map((entry) => entry.key));
  const confirmation = after ? formatLearnedConfirmation(changes, after) : undefined;
  const newFacts = Object.fromEntries(Object.entries(wroteFacts).filter(([key]) => !changedKeys.has(key)));
  const newPrefs = Object.fromEntries(Object.entries(wrotePrefs).filter(([key]) => !changedKeys.has(key)));
  const summary = formatLearnedSummary(newFacts, newPrefs);
  return { ...(summary ? { summary } : {}), ...(confirmation ? { confirmation } : {}) };
}
