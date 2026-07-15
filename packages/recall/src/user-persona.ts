/**
 * User-manageable personality layer (docs/strategy/prompt-architecture.md,
 * decision D2 + the S3 admin surface). `~/.config/muse/PERSONA.md` (override
 * `MUSE_PERSONA_MD_FILE`; a pre-rename lowercase `persona.md` is still
 * honored) carries tone/personality ONLY — optional YAML-lite frontmatter
 * (`register`/`maxWords`/`language`) plus a free-text body — and REPLACES
 * the L1 personality layer in `composeSurfacePrompt`'s stack.
 *
 * Lives in `@muse/recall`, not `@muse/prompts`, because it needs BOTH the
 * `PromptLayer` shape (from `@muse/prompts`) and the deterministic injection
 * scan (`neutralizeInjectionSpans` + `escapeSystemPromptMarkers`, both from
 * `@muse/agent-core`) — and `@muse/agent-core` already depends on
 * `@muse/prompts`, so putting this file IN `@muse/prompts` would create a
 * dependency cycle (prompts -> agent-core -> prompts). `@muse/recall`
 * already sits above both in the build graph, so it is the acyclic home
 * for the load-time scan.
 */

import { existsSync, promises as fs, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createStringSetGuard, withBestEffort } from "@muse/shared";


import { escapeSystemPromptMarkers, neutralizeInjectionSpans } from "@muse/agent-core";
import { InMemoryPromptLayerRegistry } from "@muse/prompts";
import type { PromptLayer, PromptLayerContext } from "@muse/prompts";

export type PersonaRegister = "존댓말" | "반말";

export const PERSONA_REGISTERS: readonly PersonaRegister[] = ["존댓말", "반말"];
export const PERSONA_MAX_WORDS_MIN = 1;
export const PERSONA_MAX_WORDS_MAX = 500;
export const PERSONA_LANGUAGE_MAX_LENGTH = 64;

const isPersonaRegister = createStringSetGuard(PERSONA_REGISTERS);

export interface PersonaFrontmatter {
  readonly register?: PersonaRegister;
  readonly maxWords?: number;
  /** Free text, e.g. "한국어" / "English" / "일본어" — not a closed code list. */
  readonly language?: string;
}

export interface PersonaFrontmatterInput {
  readonly register?: unknown;
  readonly maxWords?: unknown;
  readonly language?: unknown;
}

export type PersonaValidationResult =
  | { readonly ok: true; readonly frontmatter: PersonaFrontmatter }
  | { readonly ok: false; readonly reason: string };

/**
 * Frontmatter fields arrive either as strings (parsed off the on-disk
 * `---` block) or as native JSON types (the PUT/experiment API body) — both
 * are validated here so save-time and load-time share one rulebook. Unknown
 * keys are ignored (forward-compatible); a recognized key with an
 * out-of-range/wrong-shape value is a hard reject with a human-readable
 * reason, never a silent coercion.
 */
export function validatePersonaFrontmatter(input: PersonaFrontmatterInput): PersonaValidationResult {
  const frontmatter: { register?: PersonaRegister; maxWords?: number; language?: string } = {};

  if (input.register !== undefined) {
    const value = String(input.register);
    if (!isPersonaRegister(value)) {
      return { ok: false, reason: `persona frontmatter "register" must be one of ${PERSONA_REGISTERS.join(", ")} — got "${value}"` };
    }
    frontmatter.register = value;
  }

  if (input.language !== undefined) {
    const value = String(input.language).trim();
    if (value.length < 1 || value.length > PERSONA_LANGUAGE_MAX_LENGTH) {
      return {
        ok: false,
        reason: `persona frontmatter "language" must be 1-${String(PERSONA_LANGUAGE_MAX_LENGTH)} characters — got "${value}"`
      };
    }
    frontmatter.language = value;
  }

  if (input.maxWords !== undefined) {
    const numeric = typeof input.maxWords === "number" ? input.maxWords : Number(input.maxWords);
    if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric < PERSONA_MAX_WORDS_MIN || numeric > PERSONA_MAX_WORDS_MAX) {
      return {
        ok: false,
        reason: `persona frontmatter "maxWords" must be an integer between ${PERSONA_MAX_WORDS_MIN} and ${PERSONA_MAX_WORDS_MAX} — got "${String(input.maxWords)}"`
      };
    }
    frontmatter.maxWords = numeric;
  }

  return { ok: true, frontmatter };
}

export interface PersonaBodySanitizeResult {
  readonly text: string;
  readonly sanitized: boolean;
}

/**
 * Span-level neutralization (never a whole-body reject) — the same
 * `escapeSystemPromptMarkers(neutralizeInjectionSpans(text))` composition
 * already used for note/episode/tool prose (see `present.ts`/`select.ts`),
 * so a benign personality sentence that merely names a rule survives while
 * an imperative override / forged grounding-marker break-out is scrubbed in
 * place before the text ever reaches a live system prompt.
 */
export function sanitizePersonaBody(body: string): PersonaBodySanitizeResult {
  const text = escapeSystemPromptMarkers(neutralizeInjectionSpans(body));
  return { sanitized: text !== body, text };
}

export const PERSONALITY_LAYER_ID = "personality";
// Between identity-core's IDENTITY_LAYER_PRIORITY (-1000) and
// composeSurfacePrompt's SURFACE_ROLE_LAYER_PRIORITY (500) — the L1 slot in
// the canonical stack (docs/strategy/prompt-architecture.md).
export const PERSONALITY_LAYER_PRIORITY = 0;

export const DEFAULT_PERSONALITY_TEXT = [
  "말투는 따뜻하고 담백하며, 가끔 가볍고 짓궂은 농담을 섞는다 — 과하거나 오글거리지 않게.",
  "Warm, understated tone with an occasional light, playful joke — never over-the-top or cringe."
].join("\n");

function renderPersonaLayerText(frontmatter: PersonaFrontmatter, body: string): string {
  const directives: string[] = [];
  if (frontmatter.language) {
    directives.push(`기본 언어: ${frontmatter.language} (사용자가 다른 언어로 물으면 그 언어를 따라간다).`);
  }
  if (frontmatter.register === "반말") directives.push("반말(캐주얼한 말투)을 사용하라 — 사용자가 존댓말을 요청하지 않는 한.");
  if (frontmatter.register === "존댓말") directives.push("항상 존댓말을 사용하라.");
  if (frontmatter.maxWords !== undefined) {
    directives.push(`답변은 ${frontmatter.maxWords.toString()}단어 이내로 유지하라 — 사용자가 명시적으로 더 자세한 설명을 요청하지 않는 한.`);
  }
  return [...directives, body].filter((line) => line.trim().length > 0).join("\n");
}

export function buildPersonaLayer(frontmatter: PersonaFrontmatter, sanitizedBody: string): PromptLayer {
  return {
    content: renderPersonaLayerText(frontmatter, sanitizedBody),
    id: PERSONALITY_LAYER_ID,
    priority: PERSONALITY_LAYER_PRIORITY,
    section: "stable"
  };
}

export function defaultPersonaLayer(): PromptLayer {
  return { content: DEFAULT_PERSONALITY_TEXT, id: PERSONALITY_LAYER_ID, priority: PERSONALITY_LAYER_PRIORITY, section: "stable" };
}

export interface ParsedPersonaMarkdown {
  readonly frontmatterFields: Readonly<Record<string, string>>;
  readonly body: string;
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u;

export function parsePersonaMarkdown(raw: string): ParsedPersonaMarkdown {
  const match = FRONTMATTER_PATTERN.exec(raw);
  if (!match) {
    return { body: raw, frontmatterFields: {} };
  }
  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf(":");
    if (separator < 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/gu, "");
    if (key.length > 0) fields[key] = value;
  }
  return { body: match[2] ?? "", frontmatterFields: fields };
}

export function renderPersonaMarkdown(frontmatter: PersonaFrontmatter, body: string): string {
  const lines: string[] = [];
  if (frontmatter.register !== undefined) lines.push(`register: ${frontmatter.register}`);
  if (frontmatter.maxWords !== undefined) lines.push(`maxWords: ${frontmatter.maxWords.toString()}`);
  if (frontmatter.language !== undefined) lines.push(`language: ${frontmatter.language}`);
  const trimmedBody = body.trim();
  return lines.length === 0 ? `${trimmedBody}\n` : `---\n${lines.join("\n")}\n---\n\n${trimmedBody}\n`;
}

/**
 * Canonical file is uppercase `PERSONA.md` (the SOUL.md/AGENTS.md
 * convention); installs that predate the rename keep working because a
 * still-present lowercase `persona.md` wins when no uppercase file exists.
 * Read AND write sites share this resolution, so a legacy install keeps
 * reading and saving the same file instead of forking into two.
 */
export function resolvePersonaFilePath(
  env: NodeJS.ProcessEnv = process.env,
  configDir: string = join(homedir(), ".config", "muse")
): string {
  const override = env.MUSE_PERSONA_MD_FILE?.trim();
  if (override && override.length > 0) return override;
  const canonical = join(configDir, "PERSONA.md");
  if (existsSync(canonical)) return canonical;
  const legacy = join(configDir, "persona.md");
  if (existsSync(legacy)) return legacy;
  return canonical;
}

export type PersonaContentResult =
  | {
      readonly ok: true;
      readonly frontmatter: PersonaFrontmatter;
      /** The body actually composed into the prompt (post injection-scan). */
      readonly body: string;
      /** The body as read from disk / submitted, pre injection-scan (for the editor to echo back). */
      readonly rawBody: string;
      readonly sanitized: boolean;
      readonly layer: PromptLayer;
    }
  | { readonly ok: false; readonly reason: string };

/** Pure — validates frontmatter, sanitizes the body, and builds the layer. No I/O. */
export function parsePersonaContent(raw: string): PersonaContentResult {
  const { body, frontmatterFields } = parsePersonaMarkdown(raw);
  const validated = validatePersonaFrontmatter(frontmatterFields);
  if (!validated.ok) {
    return validated;
  }
  const trimmedBody = body.trim();
  const sanitizedResult = sanitizePersonaBody(trimmedBody);
  return {
    body: sanitizedResult.text,
    frontmatter: validated.frontmatter,
    layer: buildPersonaLayer(validated.frontmatter, sanitizedResult.text),
    ok: true,
    rawBody: trimmedBody,
    sanitized: sanitizedResult.sanitized
  };
}

export type PersonaLoadResult = { readonly exists: false } | ({ readonly exists: true } & PersonaContentResult);

/**
 * Async load for request-handler call sites (the persona API routes). Any
 * read failure — absent file (ENOENT) or otherwise — collapses to
 * `exists:false` rather than throwing: this is a cosmetic layer, and a
 * broken/missing file must never take down a caller that merely wants to
 * know "is a persona configured".
 */
export async function loadUserPersona(filePath: string = resolvePersonaFilePath()): Promise<PersonaLoadResult> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return { exists: false };
  }
  return { exists: true, ...parsePersonaContent(raw) };
}

/**
 * Sync twin of `loadUserPersona`, for the ONE call site that cannot await:
 * `createMuseRuntimeAssembly` is called synchronously from dozens of CLI
 * command sites, so the startup persona load has to be sync too (mirrors
 * `mergeModelKeysFromFile`'s existing sync-config-read pattern).
 */
export function loadUserPersonaSync(filePath: string = resolvePersonaFilePath()): PersonaLoadResult {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return { exists: false };
  }
  return { exists: true, ...parsePersonaContent(raw) };
}

/**
 * Runtime convenience: absent OR invalid file -> the default bluebird
 * personality layer (warm, understated, an occasional light joke) rather than
 * NO character. A fresh install with no persona file previously got `undefined`
 * here, so the flagship chat surface ran with zero personality while the
 * bluebird/tagline surfaces had one — Muse read as a generic voice box. Fail
 * OPEN to the default so every install has a consistent warm character (a user
 * PERSONA.md still overrides it). The typed `reason` a broken file produces is
 * for `loadUserPersona`'s caller (the save/preview API), not this path.
 */
export async function resolveRuntimePersonaLayer(filePath: string = resolvePersonaFilePath()): Promise<PromptLayer> {
  const result = await loadUserPersona(filePath);
  if (!result.exists) return defaultPersonaLayer();
  return result.ok ? result.layer : defaultPersonaLayer();
}

export function resolveRuntimePersonaLayerSync(filePath: string = resolvePersonaFilePath()): PromptLayer {
  const result = loadUserPersonaSync(filePath);
  if (!result.exists) return defaultPersonaLayer();
  return result.ok ? result.layer : defaultPersonaLayer();
}

interface PersonaFileSignature {
  readonly ino: number;
  readonly mtimeMs: number;
  readonly size: number;
}

function statPersonaSignature(filePath: string): PersonaFileSignature | undefined {
  try {
    const stats = statSync(filePath);
    return { ino: stats.ino, mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return undefined;
  }
}

function personaSignaturesEqual(a: PersonaFileSignature | undefined, b: PersonaFileSignature | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/**
 * Prompt-layer registry whose L1 personality entry hot-applies DIRECT edits
 * to PERSONA.md: `resolve`/`list` stat the file first (ino/size/mtime — the
 * cost is one statSync, not a read) and re-run the full load path
 * (frontmatter validation + injection scan + fail-open bluebird default)
 * only when the signature changed. Without this, a long-lived process (API
 * server, channel daemon) only picked up persona changes made through the
 * save API; a `vim ~/.config/muse/PERSONA.md` edit was invisible until
 * restart. The save API's register/unregister also records the file's
 * post-save signature so a save is never followed by a redundant re-read —
 * and a registry mutation is never clobbered by a stale-signature refresh.
 */
export class PersonaHotReloadRegistry extends InMemoryPromptLayerRegistry {
  private signature: PersonaFileSignature | undefined;

  constructor(private readonly personaFilePath: string) {
    super();
    this.refreshPersonaLayer();
  }

  override register(layer: PromptLayer): void {
    super.register(layer);
    if (layer.id === PERSONALITY_LAYER_ID) {
      this.signature = statPersonaSignature(this.personaFilePath);
    }
  }

  override unregister(id: string): boolean {
    const removed = super.unregister(id);
    if (id === PERSONALITY_LAYER_ID) {
      this.signature = statPersonaSignature(this.personaFilePath);
    }
    return removed;
  }

  override resolve(context: PromptLayerContext): readonly PromptLayer[] {
    this.refreshPersonaIfChanged();
    return super.resolve(context);
  }

  override list(): readonly PromptLayer[] {
    this.refreshPersonaIfChanged();
    return super.list();
  }

  private refreshPersonaIfChanged(): void {
    if (!personaSignaturesEqual(statPersonaSignature(this.personaFilePath), this.signature)) {
      this.refreshPersonaLayer();
    }
  }

  // Mirrors the save API's semantics (prompt-routes applyPersonaToRegistry):
  // a whitespace-only body means "no personality override", so the entry is
  // unregistered rather than registered empty. Absent/invalid files never
  // land here empty — resolveRuntimePersonaLayerSync fails open to the
  // default bluebird layer, which is always non-empty.
  private refreshPersonaLayer(): void {
    this.signature = statPersonaSignature(this.personaFilePath);
    const layer = resolveRuntimePersonaLayerSync(this.personaFilePath);
    if (layer.content.trim().length > 0) {
      super.register(layer);
    } else {
      super.unregister(PERSONALITY_LAYER_ID);
    }
  }
}

/**
 * Atomic write (tmp file + rename) at 0600 — mirrors the pattern in
 * `packages/calendar/src/credential-store.ts`. `frontmatter`/`body` must
 * already be `validatePersonaFrontmatter`/`sanitizePersonaBody`-clean; this
 * function does no validation of its own.
 */
export async function writePersonaFile(filePath: string, frontmatter: PersonaFrontmatter, body: string): Promise<void> {
  const rendered = renderPersonaMarkdown(frontmatter, body);
  const tmp = `${filePath}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
  await fs.mkdir(dirname(filePath), { recursive: true });
  await fs.writeFile(tmp, rendered, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, filePath);
  await withBestEffort(fs.chmod(filePath, 0o600), undefined);
}
