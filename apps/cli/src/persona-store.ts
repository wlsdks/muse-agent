/**
 * Persona template store.
 *
 * Persona = a system-prompt preamble Muse prepends to every
 * model-bound turn (ask / brief / today / proactive synthesis)
 * to shift the model's voice. Built-in personas live in code so
 * `muse persona use jarvis` works on a fresh install; user-
 * defined personas live under `custom` in `~/.muse/persona.json`.
 *
 * Shape:
 *   { activeId: "<built-in or custom id>",
 *     custom: { <id>: { preamble, tone? } } }
 *
 * Missing / malformed file → `{ activeId: "default", custom: {} }`
 * (no error). Built-in ids are read-only — writes to a built-in
 * id land under `custom` instead.
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { isRecord } from "@muse/shared";
import { withBestEffort } from "./async-promises.js";

export interface PersonaTemplate {
  readonly id: string;
  readonly description: string;
  readonly preamble: string;
}

export interface PersonaStoreShape {
  readonly activeId: string;
  readonly custom: Readonly<Record<string, { readonly preamble: string }>>;
}

export const BUILTIN_PERSONAS: readonly PersonaTemplate[] = [
  {
    id: "default",
    description: "No preamble — the user's facts/preferences carry the tone.",
    preamble: ""
  },
  {
    id: "jarvis",
    description: "Formal British butler tone. Brief, dry, anticipatory.",
    preamble: [
      "Speak as JARVIS — a formal, lightly dry British butler.",
      "Address the user as 'sir' (or by their stored preferred address if different).",
      "Keep replies brief (1-3 sentences) unless the user explicitly asks for detail.",
      "Anticipate one obvious next step at the end of each reply when it's natural.",
      "Avoid emoji and excessive enthusiasm. Stay precise."
    ].join(" ")
  },
  {
    id: "casual",
    description: "Chill, lowercase, brief — for off-hours chat.",
    preamble: [
      "speak casually — lowercase is fine, no honorifics, keep it short.",
      "skip preamble and meta-commentary. just answer."
    ].join(" ")
  },
  {
    id: "professional",
    description: "Precise, complete sentences, no emoji.",
    preamble: [
      "Reply in clear, professional prose — complete sentences, no emoji.",
      "Lead with the answer, then any necessary qualifications.",
      "Cite sources or assumptions inline when they materially change the answer."
    ].join(" ")
  }
];

const BUILTIN_IDS = new Set(BUILTIN_PERSONAS.map((p) => p.id));

export function defaultPersonaFile(): string {
  const fromEnv = process.env.MUSE_PERSONA_FILE?.trim();
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".muse", "persona.json");
}

export async function readPersonaStore(file: string): Promise<PersonaStoreShape> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return { activeId: "default", custom: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { activeId: "default", custom: {} };
  }
  if (!parsed || typeof parsed !== "object") {
    return { activeId: "default", custom: {} };
  }
  const candidate = isRecord(parsed) ? parsed : {};
  const activeId = typeof candidate.activeId === "string" && candidate.activeId.length > 0
    ? candidate.activeId
    : "default";
  const customRaw = isRecord(candidate.custom) ? candidate.custom : {};
  // Null-prototype: a hand-edited file with a `__proto__` /
  // `constructor` key can't mutate a real prototype or leak an
  // inherited member through later bracket access.
  const custom: Record<string, { preamble: string }> = Object.create(null);
  for (const [id, value] of Object.entries(customRaw)) {
    if (!isRecord(value)) continue;
    const preamble = value.preamble;
    if (typeof preamble !== "string") continue;
    custom[id] = { preamble };
  }
  return { activeId, custom };
}

export async function writePersonaStore(file: string, store: PersonaStoreShape): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
  await fs.writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
  await withBestEffort(fs.chmod(file, 0o600), undefined);
}

/**
 * Resolved preamble for the active persona. Order: custom
 * override (same id under `custom`) → built-in match → empty
 * (default). Pure so the system-prompt builders + tests can
 * call it with an injected `store`.
 *
 * Returns the preamble string; an empty string means "no
 * preamble" (the `default` persona). Caller decides whether to
 * prepend a separator line. Own-property check so an activeId
 * like `toString` / `__proto__` resolves to undefined instead
 * of an inherited Object.prototype member (`.preamble.length`
 * would otherwise throw).
 */
export function resolveActivePersonaPreamble(store: PersonaStoreShape): string {
  const custom = Object.hasOwn(store.custom, store.activeId)
    ? store.custom[store.activeId]
    : undefined;
  if (custom && custom.preamble.length > 0) return custom.preamble;
  const builtin = BUILTIN_PERSONAS.find((p) => p.id === store.activeId);
  return builtin?.preamble ?? "";
}

/**
 * Async loader for the system-prompt builders that just want
 * "give me the active preamble". Silent-fail to empty on every
 * IO error so a malformed file can't break the ask / brief /
 * proactive paths.
 */
export async function loadActivePersonaPreamble(file: string = defaultPersonaFile()): Promise<string> {
  try {
    return resolveActivePersonaPreamble(await readPersonaStore(file));
  } catch {
    return "";
  }
}

export function isBuiltinPersonaId(id: string): boolean {
  return BUILTIN_IDS.has(id);
}

/**
 * Whether `id` actually resolves to a real persona entry (a
 * built-in, or an own custom key). A dangling `activeId` — a
 * hand-edited file that removed the active custom, or a typo —
 * returns `false`; `resolveActivePersonaPreamble` then silently
 * yields "" and the user has no signal without this predicate.
 */
export function personaIdIsKnown(store: PersonaStoreShape, id: string): boolean {
  return isBuiltinPersonaId(id) || Object.hasOwn(store.custom, id);
}
