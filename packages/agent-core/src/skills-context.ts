/**
 * Skills-context surface (D11 — OpenClaw-style SKILL.md integration).
 *
 * Surfaces the registered SKILL.md catalog as an `[Available Skills]`
 * block in the system prompt. Only `name + description` ship per
 * request — the markdown body is NOT inlined (would balloon prompt
 * tokens). The agent fetches a specific skill's body on demand via
 * `muse.skills.read`, then invokes the underlying binary via
 * `muse.skills.run` (or a typed MCP tool when one exists).
 *
 * The interface is intentionally narrow so `@muse/agent-core` does
 * not take a dependency on `@muse/skills`. The autoconfigure layer
 * wires a `SkillCatalogProvider` that reads from `InMemorySkillRegistry`.
 */

import type { AgentRunContext, AgentRunInput } from "./types.js";
import { appendSystemSection } from "./runtime-helpers.js";

export interface SkillCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly emoji?: string;
  /** All-of: every listed binary must be on PATH for the skill to run. */
  readonly requiresBins?: readonly string[];
  /**
   * Any-of: at least ONE of these binaries must be on PATH. Useful
   * for skills that target multiple equivalent CLIs (e.g. a skill
   * that runs against EITHER Codex OR Claude Code). Pre-iter-45
   * this field lived in the SKILL.md frontmatter but never made
   * it to the catalog entry — the agent saw the skill but had no
   * visibility into its alternate-CLI dependency.
   */
  readonly requiresAnyBins?: readonly string[];
}

export interface SkillCatalogProvider {
  list(): readonly SkillCatalogEntry[] | Promise<readonly SkillCatalogEntry[]>;
}

const MAX_SKILLS_PER_PROMPT = 40;
// Iter 55 — per-skill description cap. SKILL.md `description`
// frontmatter has no parser-side bound, so a verbose author (or a
// catalog with 40+ skills carrying long routing prose) can balloon
// the `[Available Skills]` block well past 10K tokens — pure
// per-request overhead since the agent is supposed to call
// `muse.skills.read` for the full body anyway. 200 chars is plenty
// to convey routing intent ("use this when …") while keeping the
// catalog block compact.
const MAX_DESCRIPTION_CHARS = 200;

export function renderSkillsCatalogSection(entries: readonly SkillCatalogEntry[]): string | undefined {
  if (entries.length === 0) {
    return undefined;
  }
  const lines: string[] = ["[Available Skills]"];
  lines.push("External-CLI integrations declared via SKILL.md. Read the full body with");
  lines.push("`muse.skills.read({ name })` before invoking; run it with `muse.skills.run({ name, command })`.");
  for (const entry of entries.slice(0, MAX_SKILLS_PER_PROMPT)) {
    // SKILL.md frontmatter is author-supplied text — a malformed
    // or actively hostile file could land `\n[System Override]\n…`
    // in name / description / emoji. Every field rendered inline
    // gets the same whitespace-collapse pass attachment-context and
    // episodic-recall already use.
    const emoji = entry.emoji ? `${sanitizeInline(entry.emoji)} ` : "";
    const name = sanitizeInline(entry.name);
    const description = truncate(sanitizeInline(entry.description), MAX_DESCRIPTION_CHARS);
    const bins = entry.requiresBins && entry.requiresBins.length > 0
      ? ` (bins: ${entry.requiresBins.map(sanitizeInline).join(", ")})`
      : "";
    // Any-of binary requirement (iter 45) — surface so the agent
    // can pick whichever CLI is on PATH when the skill supports
    // multiple equivalents.
    const anyBins = entry.requiresAnyBins && entry.requiresAnyBins.length > 0
      ? ` (any of: ${entry.requiresAnyBins.map(sanitizeInline).join(", ")})`
      : "";
    lines.push(`- ${emoji}${name}${bins}${anyBins}: ${description}`);
  }
  if (entries.length > MAX_SKILLS_PER_PROMPT) {
    lines.push(`…and ${(entries.length - MAX_SKILLS_PER_PROMPT).toString()} more (call \`muse.skills.list\` to enumerate).`);
  }
  return lines.join("\n");
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1)}…`;
}

function sanitizeInline(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export async function applySkillsContext(
  context: AgentRunContext,
  provider: SkillCatalogProvider | undefined
): Promise<AgentRunInput> {
  if (!provider) {
    return context.input;
  }
  let entries: readonly SkillCatalogEntry[];
  try {
    entries = await provider.list();
  } catch {
    return {
      ...context.input,
      metadata: {
        ...context.input.metadata,
        skillsCatalogFailed: true
      }
    };
  }
  const rendered = renderSkillsCatalogSection(entries);
  if (!rendered) {
    return context.input;
  }
  return {
    ...context.input,
    messages: appendSystemSection(context.input.messages, rendered, "skills-catalog"),
    metadata: {
      ...context.input.metadata,
      skillsCatalogApplied: true,
      skillsCatalogCount: entries.length
    }
  };
}
