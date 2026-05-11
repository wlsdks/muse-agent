/**
 * Context-aware tool filter (Context Engineering Phase 4).
 *
 * Reduces the tool catalog advertised to the model on each request
 * based on (a) explicit scope hints in metadata, (b) the user's
 * latest message keywords, and (c) tagged tool domains.
 *
 * Tools opt in by setting `MuseToolDefinition.domain` (we recommend
 * "messaging" | "calendar" | "tasks" | "notes" | "system" | "core").
 * Untagged tools are always included so existing tools keep working.
 */

import type { MuseTool, MuseToolDefinition } from "@muse/tools";

export interface ToolFilterContext {
  readonly userMessage: string;
  readonly scopeHints?: readonly string[];
}

export interface ToolFilter {
  filter(tools: readonly MuseTool[], context: ToolFilterContext): readonly MuseTool[];
}

/**
 * Default filter: keep tools when ANY of the following is true:
 *   - tool has no `domain` (legacy / always-on)
 *   - tool's `domain === "core"`
 *   - tool's `domain` appears in `scopeHints`
 *   - the user's message matches any of the tool's `keywords`
 *   - the user's message matches the tool's domain by simple
 *     keyword heuristic (e.g. mentions "slack" → messaging)
 */
export class DefaultToolFilter implements ToolFilter {
  private readonly extraKeywords: Readonly<Record<string, readonly string[]>>;

  constructor(options: { readonly domainKeywords?: Readonly<Record<string, readonly string[]>> } = {}) {
    this.extraKeywords = options.domainKeywords ?? DEFAULT_DOMAIN_KEYWORDS;
  }

  filter(tools: readonly MuseTool[], context: ToolFilterContext): readonly MuseTool[] {
    const promptLower = context.userMessage.toLowerCase();
    const scopeSet = new Set((context.scopeHints ?? []).map((value) => value.toLowerCase()));
    return tools.filter((tool) => this.shouldKeep(tool.definition, promptLower, scopeSet));
  }

  private shouldKeep(
    definition: MuseToolDefinition,
    promptLower: string,
    scopeSet: ReadonlySet<string>
  ): boolean {
    const domain = inferDomain(definition);
    if (!domain || domain === "core") {
      return true;
    }
    if (scopeSet.has(domain.toLowerCase())) {
      return true;
    }
    for (const keyword of definition.keywords ?? []) {
      if (keyword && promptLower.includes(keyword.toLowerCase())) {
        return true;
      }
    }
    const heuristics = this.extraKeywords[domain] ?? [];
    for (const trigger of heuristics) {
      if (promptLower.includes(trigger.toLowerCase())) {
        return true;
      }
    }
    return false;
  }
}

export const DEFAULT_DOMAIN_KEYWORDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  calendar: ["calendar", "schedule", "meeting", "event", "캘린더", "일정", "회의"],
  messaging: ["slack", "discord", "telegram", "line", "메시지", "채널", "dm", "message"],
  notes: ["note", "memo", "wiki", "doc", "노트", "메모", "문서"],
  system: ["설정", "config", "setting", "version"],
  tasks: ["task", "todo", "reminder", "할일", "태스크", "리마인더"]
});

/**
 * Read the tool's domain. Supports a future `definition.domain` field
 * AND falls back to `definition.scopes` for partial back-compat.
 * Returns undefined when no domain is declared (tool is always-on).
 */
export function inferDomain(definition: MuseToolDefinition): string | undefined {
  const withDomain = definition as MuseToolDefinition & { readonly domain?: string };
  if (typeof withDomain.domain === "string" && withDomain.domain.trim().length > 0) {
    return withDomain.domain.trim();
  }
  const name = definition.name;
  if (name.startsWith("muse.messaging.")) return "messaging";
  if (name.startsWith("muse.calendar.")) return "calendar";
  if (name.startsWith("muse.tasks.")) return "tasks";
  if (name.startsWith("muse.notes.")) return "notes";
  if (name.startsWith("muse.time.")) return "core";
  if (name.startsWith("muse.context.")) return "core";
  return undefined;
}
