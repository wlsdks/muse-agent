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
/**
 * Default ceiling on the advertised tool catalog. tool-calling.md #1 caps
 * the per-turn set at 5–7; 6 sits at the top of that band. A multi-domain
 * prompt can otherwise keep 10+ tools, blowing past the band and degrading
 * one-shot selection on the local 12B (arXiv:2606.10209 / 2507.21428). The
 * cap is a SOFT ceiling over the optional, lowest-relevance tail — it never
 * drops an always-on (core/untagged) tool or an in-flight (recent) tool.
 */
export const DEFAULT_TOOL_EXPOSURE_CEILING = 6;

/**
 * When the always-on mandatory set (core/untagged/recent) alone meets or exceeds
 * the ceiling, the optional tail would be dropped ENTIRELY — making a tool the
 * user's task explicitly needs (e.g. `file_edit` on a "fix this file" prompt)
 * INVISIBLE behind always-on clutter. Reserve up to this many slots for
 * POSITIVELY-RELEVANT optional tools (a keyword match to the prompt) so a needed
 * tool is never starved. Irrelevant optional tools are NOT admitted past the cap.
 */
const RELEVANT_OPTIONAL_FLOOR = 3;

/**
 * A file-path / filename-with-code-extension mention in the prompt — a strong
 * signal the turn is a FILE task, so the `files`-domain tools (read/grep/edit)
 * are the relevant cluster. Matches an absolute/nested path (`/a/b`, `src/x.ts`)
 * or a bare `name.ext`. Used to boost files-domain relevance so the whole file
 * cluster tops the reserve rather than tying with generic tools on a lone keyword.
 */
const FILE_PATH_RE = /(?:\/[\w.-]+\/[\w./-]*|[\w-]+\.(?:mjs|cjs|js|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|cc|cs|php|swift|json|ya?ml|toml|md|txt|sh|sql|html?|css|scss))/u;
const FILE_PATH_DOMAIN_BONUS = 3;

export class DefaultToolFilter implements ToolFilter {
  private readonly extraKeywords: Readonly<Record<string, readonly string[]>>;
  private readonly maxTools: number;

  constructor(options: {
    readonly domainKeywords?: Readonly<Record<string, readonly string[]>>;
    readonly maxTools?: number;
  } = {}) {
    this.extraKeywords = options.domainKeywords ?? DEFAULT_DOMAIN_KEYWORDS;
    this.maxTools = Math.max(1, Math.trunc(options.maxTools ?? DEFAULT_TOOL_EXPOSURE_CEILING));
  }

  filter(tools: readonly MuseTool[], context: ToolFilterContext): readonly MuseTool[] {
    const promptLower = context.userMessage.toLowerCase();
    const scopeSet = new Set((context.scopeHints ?? []).map((value) => value.toLowerCase()));
    const recentSet = new Set(context.recentToolNames ?? []);
    const kept = tools.filter((tool) => this.shouldKeep(tool.definition, promptLower, scopeSet, recentSet));
    return capToolsByRelevance(kept, {
      domainKeywords: this.extraKeywords,
      maxTools: this.maxTools,
      recentToolNames: context.recentToolNames,
      userMessage: context.userMessage
    });
  }

  private shouldKeep(
    definition: MuseToolDefinition,
    promptLower: string,
    scopeSet: ReadonlySet<string>,
    recentSet: ReadonlySet<string>
  ): boolean {
    // `inferDomain` returns the domain already lowercased — every
    // downstream comparison (scopeSet, extraKeywords lookup) is then
    // symmetric. Without it the heuristics lookup
    // (`extraKeywords[domain]`) would be case-sensitive while the
    // scope check (`scopeSet.has(domain.toLowerCase())`) is
    // case-insensitive, so a tool with explicit `domain: "Messaging"`
    // would silently lose its heuristic-keyword path.
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

export interface ToolExposureCeilingContext {
  readonly userMessage: string;
  readonly maxTools?: number;
  readonly recentToolNames?: readonly string[];
  readonly domainKeywords?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Enforce the soft exposure ceiling without losing the most-relevant matches.
 *
 * Mandatory tools — always-on (core / untagged) and in-flight
 * (`recentToolNames`) — are ALWAYS retained, even past the cap: dropping an
 * in-flight follow-up tool or a core capability to satisfy a soft ceiling
 * would break the turn. The cap applies only to the OPTIONAL tail, which is
 * truncated by PROMPT-RELEVANCE (keyword-match count, mirroring `@muse/tools`
 * `relevanceScore`), not array order — with a stable tie-break on the original
 * input order so the result is deterministic. If mandatory tools alone exceed
 * the cap they are all kept (the ceiling is soft). Input order of the
 * surviving set is preserved.
 *
 * Reused by both `DefaultToolFilter` (the opt-in domain filter) and the
 * AgentRuntime (which applies the default ceiling unconditionally, so the
 * live path is bounded even when the domain filter is off).
 */
export function capToolsByRelevance(
  tools: readonly MuseTool[],
  context: ToolExposureCeilingContext
): readonly MuseTool[] {
  const maxTools = Math.max(1, Math.trunc(context.maxTools ?? DEFAULT_TOOL_EXPOSURE_CEILING));
  if (tools.length <= maxTools) {
    return tools;
  }

  const promptLower = context.userMessage.toLowerCase();
  const recentSet = new Set(context.recentToolNames ?? []);
  const heuristics = context.domainKeywords ?? DEFAULT_DOMAIN_KEYWORDS;

  const order = new Map<MuseTool, number>();
  tools.forEach((tool, index) => order.set(tool, index));

  const mandatory: MuseTool[] = [];
  const optional: MuseTool[] = [];
  for (const tool of tools) {
    if (isMandatoryTool(tool.definition, recentSet)) {
      mandatory.push(tool);
    } else {
      optional.push(tool);
    }
  }

  const remaining = Math.max(0, maxTools - mandatory.length);

  // A file-path mention boosts the `files`-domain cluster so its tools (read/
  // grep/edit) top the reserve together instead of tying generic tools on a lone
  // keyword (so file_edit, not just file_read, survives on a "fix this file" task).
  const pathMention = FILE_PATH_RE.test(context.userMessage);
  const scoreFor = (definition: MuseToolDefinition): number =>
    relevanceScore(definition, promptLower, heuristics) +
    (pathMention && inferDomain(definition) === "files" ? FILE_PATH_DOMAIN_BONUS : 0);

  const rankedOptional = [...optional].sort((a, b) => {
    const byScore = scoreFor(b.definition) - scoreFor(a.definition);
    if (byScore !== 0) {
      return byScore;
    }
    return (order.get(a) ?? 0) - (order.get(b) ?? 0);
  });

  // Reserve slots for POSITIVELY-RELEVANT optional tools so a large always-on
  // mandatory set (≥ the cap) can never starve a tool the user's task needs —
  // the structural bug where `file_edit` went invisible on a "fix this file"
  // prompt because 10 core tools filled the 6-cap (remaining=0). Only
  // keyword-matched optional tools qualify; irrelevant ones are not admitted.
  const relevantReserve = rankedOptional
    .filter((tool) => scoreFor(tool.definition) > 0)
    .slice(0, RELEVANT_OPTIONAL_FLOOR);

  const survivors = new Set<MuseTool>([...mandatory, ...rankedOptional.slice(0, remaining), ...relevantReserve]);
  return tools.filter((tool) => survivors.has(tool));
}

/**
 * Prompt-relevance score for cap ranking: the number of the tool's keywords
 * (its own + the domain heuristics) that match the prompt. Higher = more
 * relevant, mirroring `@muse/tools` `relevanceScore` so the live path's two
 * ranking layers agree.
 */
function relevanceScore(
  definition: MuseToolDefinition,
  promptLower: string,
  heuristics: Readonly<Record<string, readonly string[]>>
): number {
  let score = 0;
  for (const keyword of definition.keywords ?? []) {
    if (isMatchableKeyword(keyword) && keywordMatchesPrompt(keyword, promptLower)) {
      score += 1;
    }
  }
  const domain = inferDomain(definition);
  const domainTriggers = domain ? (heuristics[domain] ?? []) : [];
  for (const trigger of domainTriggers) {
    if (isMatchableKeyword(trigger) && keywordMatchesPrompt(trigger, promptLower)) {
      score += 1;
    }
  }
  return score;
}

/**
 * A tool that must survive the soft ceiling: an always-on tool (no domain
 * or `domain === "core"`) or one already in flight this run (`recentSet`).
 * These are the same tools `shouldKeep` retains unconditionally; the cap
 * trims only the optional, domain-gated tail beneath them.
 */
function isMandatoryTool(definition: MuseToolDefinition, recentSet: ReadonlySet<string>): boolean {
  if (recentSet.has(definition.name)) {
    return true;
  }
  const domain = inferDomain(definition);
  return !domain || domain === "core";
}

const NON_ASCII_RE = /[^\u0000-\u007f]/u;

/**
 * Keyword → prompt matcher — INFLECTION-AWARE, mirroring `@muse/tools`
 * `tokenMatchesKeywordWord` / `keywordMatchesPromptTokens` exactly so the
 * agent-core ranking layer (cap / `shouldKeep`) and the `@muse/tools`
 * selection layer agree on which tools a prompt makes relevant. They used
 * to disagree: selection accepted inflections (`lights`→`light`) while this
 * copy demanded a strict `\blight\b`, so a domain tool ranked HIGH by
 * selection scored 0 here and could be evicted from the ≤6 window.
 *
 * The rule (per word of the keyword; multi-word keywords need EVERY word to
 * hit some token):
 *  - ASCII word ≥4 chars: a token matches when `token.startsWith(word)` and
 *    the suffix is ≤3 chars — `lights`→`light`, but `research`≠`search`,
 *    `homework`≠`home`.
 *  - ASCII word <4 chars: EXACT token only, so `on`/`off` don't prefix-match
 *    inside `online`/`office`.
 *  - CJK word: containment (Korean/CJK attach particles to the stem and have
 *    no whitespace word boundary).
 *
 * Tokenization matches `@muse/tools`: lowercase, split on any non-
 * letter/digit (Unicode-aware).
 */
function keywordMatchesPrompt(keyword: string, promptLower: string): boolean {
  const tokens = tokenizePromptCache(promptLower);
  if (tokens.size === 0) {
    return false;
  }
  const words = keyword
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
  if (words.length === 0) {
    return false;
  }
  return words.every((word) => {
    for (const token of tokens) {
      if (tokenMatchesKeywordWord(token, word)) {
        return true;
      }
    }
    return false;
  });
}

function tokenMatchesKeywordWord(token: string, word: string): boolean {
  if (token === word) {
    return true;
  }
  if (NON_ASCII_RE.test(word)) {
    return word.length >= 2 ? token.includes(word) : false;
  }
  return word.length >= 4 && token.startsWith(word) && token.length - word.length <= 3;
}

const promptTokenCache = new Map<string, Set<string>>();

function tokenizePromptCache(promptLower: string): Set<string> {
  const cached = promptTokenCache.get(promptLower);
  if (cached) {
    return cached;
  }
  const tokens = new Set<string>();
  for (const token of promptLower.split(/[^\p{L}\p{N}]+/u)) {
    if (token.length > 0) {
      tokens.add(token);
    }
  }
  promptTokenCache.set(promptLower, tokens);
  return tokens;
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
  calendar: ["calendar", "schedule", "meeting", "meetings", "event", "events", "appointment", "appointments", "agenda", "캘린더", "일정", "회의", "약속"],
  home: ["home", "light", "lights", "lamp", "door", "lock", "locked", "unlock", "unlocked", "garage", "thermostat", "sensor", "device", "devices", "smart home", "조명", "불", "문", "잠금", "온도", "센서"],
  // Episodic + pattern tools carry `domain: "memory"`; without this set they
  // were gated behind a keyword list that didn't exist → NEVER exposed, so the
  // model could never recall a past session or list a detected pattern.
  memory: ["episode", "episodes", "session", "sessions", "history", "past", "previously", "recall", "conversation", "conversations", "pattern", "patterns", "habit", "habits", "routine", "routines", "세션", "기록", "지난", "예전", "과거", "대화", "패턴", "습관", "루틴"],
  messaging: ["slack", "discord", "telegram", "line", "메시지", "채널", "dm", "message", "messages", "inbox", "email", "mail", "이메일", "메일", "받은"],
  notes: ["note", "notes", "memo", "memos", "wiki", "doc", "docs", "document", "노트", "메모", "문서", "위키"],
  system: ["설정", "config", "setting", "version", "버전"],
  tasks: ["task", "tasks", "todo", "todos", "to-do", "to-dos", "reminder", "reminders", "remind", "할일", "할 일", "투두", "태스크", "리마인더", "리마인드"],
  web: ["browser", "chrome", "tab", "tabs", "webpage", "web page", "website", "page", "url", "navigate", "click", "scroll", "screenshot", "브라우저", "페이지", "탭", "웹"]
});

/**
 * `muse.<prefix>.*` → domain mapping. Lookup table rather than an
 * if-chain so adding a new built-in domain is a one-line change.
 * `core` tools are always-on; non-core domains gate the tool behind
 * the prompt-keyword / scope-hint / recent-tool filter.
 *
 * Includes the registry-backed `<domain>-multi` variants
 *.
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
