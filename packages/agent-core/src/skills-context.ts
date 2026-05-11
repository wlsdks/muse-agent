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
  readonly requiresBins?: readonly string[];
}

export interface SkillCatalogProvider {
  list(): readonly SkillCatalogEntry[] | Promise<readonly SkillCatalogEntry[]>;
}

const MAX_SKILLS_PER_PROMPT = 40;

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
    const description = sanitizeInline(entry.description);
    const bins = entry.requiresBins && entry.requiresBins.length > 0
      ? ` (bins: ${entry.requiresBins.map(sanitizeInline).join(", ")})`
      : "";
    lines.push(`- ${emoji}${name}${bins}: ${description}`);
  }
  if (entries.length > MAX_SKILLS_PER_PROMPT) {
    lines.push(`…and ${(entries.length - MAX_SKILLS_PER_PROMPT).toString()} more (call \`muse.skills.list\` to enumerate).`);
  }
  return lines.join("\n");
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
