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
    // `inferDomain` returns the domain already lowercased — every
    // downstream comparison (scopeSet, extraKeywords lookup) is then
    // symmetric. Before iter 25 the heuristics lookup
    // (`extraKeywords[domain]`) was case-sensitive while the scope
    // check (`scopeSet.has(domain.toLowerCase())`) was case-insensitive,
    // so a tool with explicit `domain: "Messaging"` silently lost its
    // heuristic-keyword path. Centralising the lowercase in inferDomain
    // closes the asymmetry.
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
    if (scopeSet.has(domain)) {
      return true;
    }
    for (const keyword of definition.keywords ?? []) {
      if (isMatchableKeyword(keyword) && keywordMatchesPrompt(keyword, promptLower)) {
        return true;
      }
    }
    const heuristics = this.extraKeywords[domain] ?? [];
    for (const trigger of heuristics) {
      if (isMatchableKeyword(trigger) && keywordMatchesPrompt(trigger, promptLower)) {
        return true;
      }
    }
    return false;
  }
}

const ASCII_ONLY_RE = /^[\x00-\x7f]+$/u;

/**
 * Keyword → prompt matcher.
 *
 * Pre-iter-36 every keyword used raw `promptLower.includes(kw)`. That
 * silently substring-matched short ASCII triggers inside larger
 * words — `"dm"` (legitimate Slack DM keyword) fired on `"admin"`,
 * `"freedom"`, `"wisdom"`, etc, expanding the messaging tool catalog
 * for unrelated prompts. The fix routes ASCII-only keywords through
 * a word-boundary regex (`\b…\b`) while keeping the substring path
 * for CJK keywords — Korean / Japanese / Chinese scripts don't use
 * whitespace word boundaries, and JS's ASCII-flavoured `\b` would
 * never match between two CJK chars.
 */
function keywordMatchesPrompt(keyword: string, promptLower: string): boolean {
  const kw = keyword.toLowerCase();
  if (ASCII_ONLY_RE.test(kw)) {
    return wordBoundaryRegexFor(kw).test(promptLower);
  }
  return promptLower.includes(kw);
}

const wordBoundaryCache = new Map<string, RegExp>();

function wordBoundaryRegexFor(keywordLower: string): RegExp {
  const cached = wordBoundaryCache.get(keywordLower);
  if (cached) {
    return cached;
  }
  const re = new RegExp(`\\b${escapeRegex(keywordLower)}\\b`, "u");
  wordBoundaryCache.set(keywordLower, re);
  return re;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Reject keywords that are too short to discriminate. Single-character
 * triggers ("a", "v") would match nearly every English prompt and
 * silently disable the per-domain filter. Two-character minimum
 * matches Korean (most morphemes are 2+ syllables) and English (the
 * shortest meaningful domain word is "gh" / "pr" / "ai") without
 * losing real signal. Empty / whitespace-only entries are also
 * dropped.
 */
function isMatchableKeyword(keyword: unknown): keyword is string {
  return typeof keyword === "string" && keyword.trim().length >= 2;
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
 *
 * Includes the registry-backed `<domain>-multi` variants
 * (iter 47, sibling of iter 39 fix in tool-output-importance.ts).
 * The autoconfigure layer registers `muse.tasks-multi.*`,
 * `muse.calendar-multi.*`, and `muse.notes-multi.*` alongside the
 * single-provider tools; without these mappings they bypassed the
 * domain filter entirely and surfaced on every prompt.
 *
 * `muse.reminders.*` lands in tasks (reminders are task-adjacent).
 */
const BUILTIN_PREFIX_DOMAIN: Readonly<Record<string, string>> = Object.freeze({
  "muse.calendar.": "calendar",
  "muse.calendar-multi.": "calendar",
  "muse.context.": "core",
  "muse.messaging.": "messaging",
  "muse.notes.": "notes",
  "muse.notes-multi.": "notes",
  "muse.reminders.": "tasks",
  "muse.skills.": "core",
  "muse.tasks.": "tasks",
  "muse.tasks-multi.": "tasks",
  "muse.time.": "core"
});

/**
 * Read the tool's domain. Honours an explicit `definition.domain`
 * first (normalised — trimmed + lowercased), then falls back to a
 * name-prefix lookup whose values are already lowercase. Returns
 * undefined when nothing matches (tool is always-on).
 *
 * Domains are a case-insensitive taxonomy: returning the normalised
 * form here means callers can compare with `===` and use the value
 * as a `Record` key (scope set, heuristics lookup) without paying
 * for per-call-site lowercase conversions, and — more importantly —
 * without falling into the case-mismatch bug where a tool tagged
 * `domain: "Messaging"` silently lost its heuristic-keyword path.
 */
export function inferDomain(definition: MuseToolDefinition): string | undefined {
  if (typeof definition.domain === "string" && definition.domain.trim().length > 0) {
    return definition.domain.trim().toLowerCase();
  }
  for (const [prefix, domain] of Object.entries(BUILTIN_PREFIX_DOMAIN)) {
    if (definition.name.startsWith(prefix)) {
      return domain;
    }
  }
  return undefined;
}
