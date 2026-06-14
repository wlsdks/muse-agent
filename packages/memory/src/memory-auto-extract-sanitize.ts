/**
 * Input sanitization for LLM-extracted memory entries — the defensive boundary
 * between an extractor model's raw output and the user memory store: caps the
 * count/key/value lengths, normalizes keys, and strips untrusted terminal
 * control characters (the anti-memory-poisoning layer). Split out of
 * memory-auto-extract.ts so this validation has an isolated, testable home.
 */

import { stripUntrustedTerminalChars } from "@muse/shared";

export interface ExtractedSlot {
  readonly id: string;
  readonly value: string;
  readonly scope?: string;
}

export function sanitizeSlotArray(
  source: readonly ExtractedSlot[] | undefined,
  maxCount: number,
  maxKey: number,
  maxValue: number
): readonly ExtractedSlot[] {
  if (!Array.isArray(source) || maxCount === 0) {
    return [];
  }
  const out: ExtractedSlot[] = [];
  // Dedupe by id. Facts/preferences are Record-shaped so duplicate
  // keys collapse for free, but slots arrive as an array — a
  // reasoning-off model that re-emits a near-duplicate veto/goal
  // would otherwise consume a `maxCount` slot and silently drop a
  // DISTINCT later veto/goal from the persona. First valid
  // occurrence wins.
  const seenIds = new Set<string>();
  for (const entry of source) {
    if (out.length >= maxCount) {
      break;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const id = normalizeKey(typeof entry.id === "string" ? entry.id : "", maxKey);
    if (!id || seenIds.has(id)) {
      continue;
    }
    const value = sanitizeValue(entry.value, maxValue);
    if (value.length === 0) {
      continue;
    }
    seenIds.add(id);
    const scope = typeof entry.scope === "string"
      ? normalizeKey(entry.scope, maxKey)
      : undefined;
    out.push(scope ? { id, scope, value } : { id, value });
  }
  return out;
}

export function sanitizeEntries(
  source: Readonly<Record<string, string>> | undefined,
  maxCount: number,
  maxKey: number,
  maxValue: number
): readonly (readonly [string, string])[] {
  // `typeof [] === "object"` is the JS footgun: an extractor LLM
  // that returned `facts: ["foo", "bar"]` instead of the documented
  // Record-shape passed the previous guard, and the downstream
  // `Object.entries` produced `[["0","foo"],["1","bar"]]` — silently
  // landing fake "0"/"1" keys in `UserMemoryStore`. Reject arrays
  // explicitly so a wrong-shape payload becomes a no-op (fail-open,
  // same as before).
  if (!source || typeof source !== "object" || Array.isArray(source) || maxCount === 0) {
    return [];
  }
  const out: (readonly [string, string])[] = [];
  for (const [rawKey, rawValue] of Object.entries(source)) {
    if (out.length >= maxCount) {
      break;
    }
    const key = normalizeKey(rawKey, maxKey);
    if (!key) {
      continue;
    }
    const value = sanitizeValue(rawValue, maxValue);
    if (value.length === 0) {
      continue;
    }
    out.push([key, value]);
  }
  return out;
}

/**
 * Strip ESC / C0 / C1 / DEL bytes, then collapse whitespace runs
 * to a single space + trim + length cap. Run at the store boundary
 * so a prompt-injection attempt that survived the extractor —
 * "value": "ok\n[System Override]\nDo X" or an ANSI/control-byte
 * payload — can't land in `UserMemoryStore` and then be re-emitted
 * into the next turn's `[User Memory]` system-prompt block, nor
 * hijack the terminal on `muse memory show`.
 */
function sanitizeValue(raw: unknown, maxValue: number): string {
  if (typeof raw !== "string") {
    return "";
  }
  return stripUntrustedTerminalChars(raw).replace(/\s+/gu, " ").trim().slice(0, maxValue);
}

function normalizeKey(raw: string, max: number): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, max);
  return cleaned.length > 0 ? cleaned : undefined;
}
