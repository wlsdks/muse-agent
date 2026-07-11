/**
 * `remember_fact` — lets the agent persist a durable fact/preference ABOUT THE
 * USER from natural conversation ("remember my dentist is Dr. Kim"), the way
 * the `/remember` slash command does manually. Writes to the same user-memory
 * store the persona reads, so it surfaces in future sessions.
 *
 * Single-purpose, unambiguous verb_noun name + a "use when / not when" line so
 * the local model selects it in one shot and doesn't confuse it with the
 * tasks (to-dos) or notes (free-form) tools (tool-calling.md).
 */

import { normalizeMemoryKey } from "@muse/memory";
import { assertNoSecretInPersistedFields, type JsonObject, type JsonValue } from "@muse/shared";
import type { MuseTool, MuseToolContext } from "@muse/tools";

/** Minimal structural store — matches @muse/memory's UserMemoryStore writers. */
export interface RememberFactStore {
  upsertFact(userId: string, key: string, value: string): Promise<unknown> | unknown;
  upsertPreference(userId: string, key: string, value: string): Promise<unknown> | unknown;
}

function readString(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveUserId(context: MuseToolContext): string {
  return context.userId ?? (process.env.MUSE_USER_ID?.trim() || "default");
}

export function createRememberFactTool(options: { readonly store: RememberFactStore }): MuseTool {
  return {
    definition: {
      name: "remember_fact",
      description:
        "Save a durable FACT or PREFERENCE about the USER so you recall it in future sessions — " +
        "their name, home city, the people/things in their life, or how they like you to behave. " +
        "Use when the user tells you to remember something about THEM (e.g. \"remember my dentist is Dr. Kim\", " +
        "\"note that I live in Seoul\", \"I prefer concise answers\"). " +
        "Do NOT use for to-do items (use the tasks tool) or free-form notes (use the notes tool).",
      domain: "memory",
      inputSchema: {
        additionalProperties: false,
        properties: {
          key: { description: "Short snake_case label for what this is, e.g. 'home_city', 'dentist', 'reply_style'.", type: "string" },
          kind: { description: "'fact' for objective info about the user; 'preference' for how they like things. Default 'fact'.", enum: ["fact", "preference"], type: "string" },
          value: { description: "The thing to remember, e.g. 'Seoul', 'Dr. Kim', 'concise Korean replies'.", type: "string" }
        },
        required: ["key", "value"],
        type: "object"
      },
      keywords: ["remember", "memory", "note that", "preference", "prefer", "my name", "i live", "i like"],
      risk: "write"
    },
    execute: async (args: JsonObject, context: MuseToolContext): Promise<JsonObject> => {
      const key = readString(args, "key");
      const value = readString(args, "value");
      if (!key || !value) {
        return { error: "remember_fact needs both `key` and `value`" };
      }
      // Check `key` + `value` COMBINED: the tool splits a natural-language
      // "remember my password is X" into separate structured params, so the
      // label ("password"/"비밀번호") often lands in `key` while the secret
      // itself lands in `value` — checking `value` alone would miss it.
      const guard = assertNoSecretInPersistedFields({ key, value });
      if (!guard.safe) {
        return { blocked: true, error: guard.notice, kinds: guard.kinds as JsonValue };
      }
      const kind = readString(args, "kind") === "preference" ? "preference" : "fact";
      const userId = resolveUserId(context);
      // Canonicalize via the store's own normalizer (keeps Unicode — Korean keys
      // like "취미" survive; the old ASCII-only slug dropped them to "" and refused
      // the write). Guard first that the key carries a real letter/digit, since
      // normalizeMemoryKey falls back to the raw key for an all-punctuation input.
      if (!/[\p{L}\p{N}]/u.test(key)) {
        return { error: "remember_fact `key` must contain letters or digits" };
      }
      const slug = normalizeMemoryKey(key);
      if (kind === "preference") {
        await Promise.resolve(options.store.upsertPreference(userId, slug, value));
      } else {
        await Promise.resolve(options.store.upsertFact(userId, slug, value));
      }
      return { kind, remembered: { [slug]: value } };
    }
  };
}
