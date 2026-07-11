/**
 * Pure helpers for the Prompt Lab persona editor. The API's `PUT
 * /api/prompt/persona` takes one `raw` markdown string (frontmatter fence +
 * body); the UI edits register/maxWords/language as separate fields for
 * usability, so these two functions are the client-side mirror of the
 * server's `parsePersonaMarkdown` / `renderPersonaMarkdown`
 * (`@muse/recall`'s `user-persona.ts`) — kept in sync by contract, not by
 * import, since the web bundle doesn't depend on server packages.
 */

export interface PersonaFieldValues {
  readonly register: string;
  readonly maxWords: string;
  readonly language: string;
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u;

export function buildPersonaRaw(fields: PersonaFieldValues, body: string): string {
  const lines: string[] = [];
  if (fields.register.trim().length > 0) lines.push(`register: ${fields.register.trim()}`);
  if (fields.maxWords.trim().length > 0) lines.push(`maxWords: ${fields.maxWords.trim()}`);
  if (fields.language.trim().length > 0) lines.push(`language: ${fields.language.trim()}`);
  const trimmedBody = body.trim();
  return lines.length === 0 ? `${trimmedBody}\n` : `---\n${lines.join("\n")}\n---\n\n${trimmedBody}\n`;
}

export function splitPersonaBody(raw: string): string {
  const match = FRONTMATTER_PATTERN.exec(raw);
  return (match ? match[2] : raw)?.trim() ?? "";
}

/**
 * Maps a preview segment's `layer` id to its i18n label key. The server
 * emits `surface-role:<surface>` (e.g. `surface-role:chat`) rather than a
 * fixed string, so this matches by prefix; an unrecognized id (a future
 * layer kind) falls back to `undefined` and the view renders the raw id.
 */
export function layerLabelKey(layer: string): "pl.preview.layer.identity-core" | "pl.preview.layer.personality" | "pl.preview.layer.surface-role" | undefined {
  if (layer === "identity-core") return "pl.preview.layer.identity-core";
  if (layer === "personality") return "pl.preview.layer.personality";
  if (layer.startsWith("surface-role")) return "pl.preview.layer.surface-role";
  return undefined;
}
