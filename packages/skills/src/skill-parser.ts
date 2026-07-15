/**
 * SKILL.md parser — handles the OpenClaw / Anthropic frontmatter
 * shape. The fenced block at the top of the file (between the
 * first two `---` lines) is interpreted as YAML-ish:
 *   - simple `key: value` pairs for top-level strings
 *   - a `metadata:` block whose body is a JSON object (this
 *     mirrors the inline-JSON pattern OpenClaw uses to keep YAML
 *     parsing dependency-free)
 *
 * Everything below the closing `---` is the markdown body and is
 * preserved verbatim.
 *
 * Intentionally tolerant: malformed frontmatter falls back to
 * "no metadata, body = whole file" so a hand-written skill never
 * crashes the loader.
 */

import { promises as fs } from "node:fs";
import { dirname } from "node:path";

import { isRecord } from "@muse/shared";

import type { Skill, SkillFrontmatter, SkillSource } from "./skill-contract.js";

export class SkillParseError extends Error {
  constructor(message: string, readonly filePath?: string) {
    super(message);
    this.name = "SkillParseError";
  }
}

const FRONTMATTER_DELIM = /^---\s*$/u;

export interface ParseSkillFileOptions {
  readonly source: SkillSource;
}

export async function parseSkillFile(filePath: string, options: ParseSkillFileOptions): Promise<Skill> {
  const raw = await fs.readFile(filePath, "utf8");
  const { frontmatter, body } = splitFrontmatter(raw);
  const parsedFrontmatter = parseSkillFrontmatter(frontmatter);
  if (!parsedFrontmatter.name || parsedFrontmatter.name.trim().length === 0) {
    throw new SkillParseError(`SKILL.md missing required "name" field`, filePath);
  }
  if (!parsedFrontmatter.description || parsedFrontmatter.description.trim().length === 0) {
    throw new SkillParseError(`SKILL.md missing required "description" field`, filePath);
  }
  return {
    body: body.trim(),
    description: parsedFrontmatter.description.trim(),
    frontmatter: parsedFrontmatter,
    name: parsedFrontmatter.name.trim(),
    sourceInfo: {
      baseDir: dirname(filePath),
      filePath,
      source: options.source
    }
  };
}

interface SplitResult {
  readonly frontmatter: string;
  readonly body: string;
}

export function splitFrontmatter(raw: string): SplitResult {
  const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const lines = stripped.split(/\r?\n/u);
  if (lines.length === 0 || !FRONTMATTER_DELIM.test(lines[0] ?? "")) {
    return { body: stripped, frontmatter: "" };
  }
  for (let i = 1; i < lines.length; i++) {
    if (FRONTMATTER_DELIM.test(lines[i] ?? "")) {
      const frontmatter = lines.slice(1, i).join("\n");
      const body = lines.slice(i + 1).join("\n");
      return { body, frontmatter };
    }
  }
  return { body: raw, frontmatter: "" };
}

/**
 * Parses the frontmatter block. Supports two shapes:
 *
 *   - Plain `key: value` lines for simple string fields.
 *   - A `metadata:` line followed by a multi-line indented JSON
 *     object (the OpenClaw convention) OR a one-line JSON object.
 *
 * Always returns a `SkillFrontmatter`; missing fields stay
 * undefined so callers can validate downstream.
 */
export function parseSkillFrontmatter(frontmatter: string): SkillFrontmatter {
  if (frontmatter.trim().length === 0) {
    return { description: "", name: "" };
  }
  const lines = frontmatter.split(/\r?\n/u);
  const simple: Record<string, string> = {};
  let metadataJson = "";
  let inMetadata = false;
  let inRequires = false;
  let inInstall = false;
  let requiresJson = "";
  let installJson = "";

  for (const line of lines) {
    if (inMetadata) {
      metadataJson += `${line}\n`;
      // Brace-balanced exit. The other two states (`inRequires`,
      // `inInstall`) use a `line.trim() === "}" || "}"` heuristic
      // that breaks on nested objects — the OpenClaw-style
      // `metadata:` block ALWAYS nests (`{ "openclaw": { ... } }`)
      // so the same heuristic here would exit at the FIRST inner
      // `}`, lose the outer fields, and break `safeJsonObject`.
      // Counting braces (string-aware) gives a single deterministic
      // exit at the true close of the object — and also closes the
      // bug where `inMetadata` had no exit at all and greedily
      // consumed every trailing simple-string field below `metadata:`
      // (description / emoji / homepage).
      if (isJsonBlockComplete(metadataJson, "{", "}")) {
        inMetadata = false;
      }
      continue;
    }
    if (inRequires) {
      requiresJson += `${line}\n`;
      // Brace-balanced exit so a nested requires block doesn't
      // terminate at the first inner }.
      if (isJsonBlockComplete(requiresJson, "{", "}")) {
        inRequires = false;
      }
      continue;
    }
    if (inInstall) {
      installJson += `${line}\n`;
      // Bracket-balanced exit — install entries nest their own
      // arrays, so a plain "]" check would exit too early.
      if (isJsonBlockComplete(installJson, "[", "]")) {
        inInstall = false;
      }
      continue;
    }
    const match = /^([\w-]+):\s*(.*)$/u.exec(line);
    if (!match) {
      continue;
    }
    const key = match[1] ?? "";
    const value = match[2] ?? "";
    if (key === "metadata" && (value.trim() === "" || value.trim().startsWith("{"))) {
      metadataJson = value.trim();
      if (!metadataJson.endsWith("}")) {
        inMetadata = true;
      }
      continue;
    }
    if (key === "requires" && value.trim().startsWith("{")) {
      requiresJson = `${value.trim()}\n`;
      if (!value.trim().endsWith("}")) {
        inRequires = true;
      }
      continue;
    }
    if (key === "install" && value.trim().startsWith("[")) {
      installJson = `${value.trim()}\n`;
      if (!value.trim().endsWith("]")) {
        inInstall = true;
      }
      continue;
    }
    simple[key] = stripQuotes(value);
  }

  const metadata = safeJsonObject(metadataJson);
  const out: SkillFrontmatter = {
    description: simple["description"] ?? "",
    ...(simple["emoji"] ? { emoji: simple["emoji"] } : {}),
    ...(simple["homepage"] ? { homepage: simple["homepage"] } : {}),
    ...(metadata ? { metadata } : {}),
    name: simple["name"] ?? ""
  };
  // requires / install can come straight from frontmatter OR from
  // metadata.openclaw / metadata.muse. Merge with explicit wins.
  const requires = safeJsonObject(requiresJson);
  const install = safeJsonArray(installJson);
  const fromMetadata = extractRequiresInstall(metadata);
  const mergedRequires = (requires ?? fromMetadata.requires) as SkillFrontmatter["requires"];
  const mergedInstall = (install ?? fromMetadata.install) as SkillFrontmatter["install"];
  return {
    ...out,
    ...(mergedRequires ? { requires: mergedRequires } : {}),
    ...(mergedInstall ? { install: mergedInstall } : {})
  };
}

function extractRequiresInstall(
  metadata: Record<string, unknown> | undefined
): {
  readonly requires?: unknown;
  readonly install?: unknown;
} {
  if (!metadata) {
    return {};
  }
  // Muse wins per-field; fall through to openclaw for any field the
  // muse block omits. Returning on the first object-valued block
  // would let a present-but-empty `muse: {}` (or one carrying only
  // `install`) mask openclaw's `requires` — silently dropping a
  // skill's binary-requirement gating.
  let requires: unknown;
  let install: unknown;
  for (const vendor of ["muse", "openclaw"]) {
    const block = metadata[vendor];
    if (!isRecord(block)) {
      continue;
    }
    const record = block;
    if (requires === undefined && record.requires) {
      requires = record.requires;
    }
    if (install === undefined && record.install) {
      install = record.install;
    }
  }
  return {
    ...(requires !== undefined ? { requires } : {}),
    ...(install !== undefined ? { install } : {})
  };
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Returns true once the accumulated text contains a fully-balanced
 * top-level block opened by `open` and closed by `close`. String-
 * literal-aware so a `"label": "{ … }"` value does not confuse the
 * depth counter. Used by the multi-line `metadata:` parser to find
 * the real end of a nested JSON object across line breaks.
 */
function isJsonBlockComplete(text: string, open: string, close: string): boolean {
  let depth = 0;
  let inString = false;
  let escape = false;
  let sawOpen = false;
  for (const ch of text) {
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === open) {
      depth += 1;
      sawOpen = true;
    } else if (ch === close) {
      depth -= 1;
    }
  }
  return sawOpen && depth === 0;
}

function safeJsonObject(value: string): Record<string, unknown> | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function safeJsonArray(value: string): unknown[] | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
