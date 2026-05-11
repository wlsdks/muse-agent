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
  /**
   * Tools the agent invoked on previous turns of this run /
   * session. The filter retains any tool whose name appears here so
   * a follow-up question ("reply to that") does not lose access to
   * the messaging / calendar / etc. capability that's already in
   * flight. Populated by the runtime from
   * `metadata.recentToolNames`.
   */
  readonly recentToolNames?: readonly string[];
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
    const recentSet = new Set(context.recentToolNames ?? []);
    return tools.filter((tool) => this.shouldKeep(tool.definition, promptLower, scopeSet, recentSet));
  }

  private shouldKeep(
    definition: MuseToolDefinition,
    promptLower: string,
    scopeSet: ReadonlySet<string>,
    recentSet: ReadonlySet<string>
  ): boolean {
    const domain = inferDomain(definition);
    if (!domain || domain === "core") {
      return true;
    }
    // Retain tools the agent already used on a prior turn — a
    // follow-up like "reply to that" doesn't repeat the original
    // keyword and would otherwise drop the matching domain.
    if (recentSet.has(definition.name)) {
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
  notes: ["note", "memo", "wiki", "doc", "노트", "메모", "문서", "위키"],
  system: ["설정", "config", "setting", "version", "버전"],
  tasks: ["task", "todo", "reminder", "할일", "태스크", "리마인더"]
});

/**
 * `muse.<prefix>.*` → domain mapping. Lookup table rather than an
 * if-chain so adding a new built-in domain is a one-line change.
 * `core` tools are always-on; non-core domains gate the tool behind
 * the prompt-keyword / scope-hint / recent-tool filter.
 */
const BUILTIN_PREFIX_DOMAIN: Readonly<Record<string, string>> = Object.freeze({
  "muse.calendar.": "calendar",
  "muse.context.": "core",
  "muse.messaging.": "messaging",
  "muse.notes.": "notes",
  "muse.skills.": "core",
  "muse.tasks.": "tasks",
  "muse.time.": "core"
});

/**
 * Read the tool's domain. Honours an explicit `definition.domain`
 * first, then falls back to a name-prefix lookup. Returns undefined
 * when nothing matches (tool is always-on).
 */
export function inferDomain(definition: MuseToolDefinition): string | undefined {
  if (typeof definition.domain === "string" && definition.domain.trim().length > 0) {
    return definition.domain.trim();
  }
  for (const [prefix, domain] of Object.entries(BUILTIN_PREFIX_DOMAIN)) {
    if (definition.name.startsWith(prefix)) {
      return domain;
    }
  }
  return undefined;
}
