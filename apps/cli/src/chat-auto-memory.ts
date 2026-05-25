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

import { extractJsonObject } from "@muse/memory";

// A sharper, example-bearing extraction prompt than the shared agent-runtime
// one — verified to extract reliably on the LOCAL qwen3:8b tier (the shared
// prompt returned empty on clear facts; see EXPANSION-LOG.md). Output-only JSON
// + concrete examples are what make the small model comply in one shot.
const CHAT_AUTO_EXTRACT_SYSTEM =
  "You extract durable personal facts/preferences the USER stated about THEMSELVES in the conversation. " +
  "Output ONLY a JSON object, no prose: {\"facts\":{\"<snake_key>\":\"<value>\"},\"preferences\":{\"<snake_key>\":\"<value>\"}}. " +
  "Put a FACT when the user states where they live, their name, job, diet, or people/things in their life (e.g. {\"home_city\":\"Busan\"}). " +
  "Put a PREFERENCE for how they like replies/behavior (e.g. {\"reply_length\":\"short\"}). " +
  "If the user stated nothing durable about themselves, return {\"facts\":{},\"preferences\":{}}. Never invent.";

export interface AutoMemoryProvider {
  generate(request: {
    readonly model: string;
    readonly messages: readonly { readonly role: "system" | "user" | "assistant"; readonly content: string }[];
    readonly temperature?: number;
    readonly maxOutputTokens?: number;
  }): Promise<{ readonly output?: string }>;
}

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
    return { facts: pickStrings(payload.facts), preferences: pickStrings(payload.preferences) };
  } catch {
    return empty;
  }
}
