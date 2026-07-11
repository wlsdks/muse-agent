import { composeIdentityPrompt } from "./identity-core.js";
import { cleanBlock, compactLines, compactSections } from "./prompt-text.js";

export { composeIdentityPrompt, MUSE_IDENTITY_CORE } from "./identity-core.js";
export {
  composeSurfacePrompt,
  composeSurfacePromptSegments,
  SURFACE_ROLES,
  type ComposedPromptSegment,
  type ComposedPromptSegmentLayer,
  type ComposeSurfaceContext,
  type MuseSurface
} from "./compose.js";

export type ResponseFormat = "text" | "json" | "yaml";

export interface PromptBuildInput {
  readonly basePrompt?: string;
  readonly exemplarContext?: string;
  readonly responseFormat?: ResponseFormat;
  readonly responseSchema?: string;
  readonly retrievedContext?: string;
  readonly toolResults?: string;
  readonly requesterContext?: string;
  readonly userMemoryContext?: string;
  readonly sessionMemoryContext?: string;
  readonly taskMemoryContext?: string;
  readonly providerStablePrefix?: string;
  readonly providerDynamicSuffix?: string;
  readonly delegatedAgent?: string;
  readonly includeCacheBoundary?: boolean;
}

export interface PromptContextPacket {
  readonly retrievedContext?: string;
  readonly toolResults?: string;
  readonly requesterContext?: string;
  readonly userMemoryContext?: string;
  readonly sessionMemoryContext?: string;
  readonly taskMemoryContext?: string;
  readonly delegatedAgent?: string;
}

export interface CacheBoundarySplit {
  readonly stablePrefix: string;
  readonly dynamicSuffix: string;
}

export type PromptLayerSection = "stable" | "dynamic";

export interface PromptLayer {
  readonly id: string;
  readonly content: string;
  readonly section?: PromptLayerSection;
  readonly priority?: number;
  readonly personaIds?: readonly string[];
  readonly promptTemplateIds?: readonly string[];
  readonly providerIds?: readonly string[];
  readonly modelPrefixes?: readonly string[];
}

export interface PromptLayerContext {
  readonly personaId?: string;
  readonly promptTemplateId?: string;
  readonly providerId?: string;
  readonly model?: string;
}

export interface PromptLayerRegistry {
  resolve(context: PromptLayerContext): readonly PromptLayer[];
}

export interface ExemplarDocument {
  readonly id: string;
  readonly index: number;
  readonly title: string;
  readonly scenario: string;
  readonly body: string;
}

export interface ExemplarRetriever {
  retrieveTopK(userPrompt: string, k: number): string | Promise<string>;
}

export interface InMemoryExemplarRetrieverOptions {
  readonly fallback?: ExemplarRetriever;
  readonly headerPreamble?: string;
  readonly minScore?: number;
  readonly pinnedIds?: readonly string[];
  readonly topK?: number;
}

export const MUSE_CACHE_BOUNDARY_MARKER = "<!-- MUSE_CACHE_BOUNDARY -->";
export const DEFAULT_EXEMPLAR_HEADER = "[Answer Quality Examples]";
export const DEFAULT_BASE_PROMPT = composeIdentityPrompt(
  "(agent runtime) Be accurate, concise, and explicit about uncertainty."
);

/**
 * System prompt for `today --brief` (and the web's TodayBriefPanel).
 * Both the CLI and the web console fold this verbatim into the
 * user-message body sent to /api/chat (or, for the CLI's `--local`
 * mode, into the system message of an agentRuntime.run call). Lift
 * here so the two surfaces don't drift on tone / priority order.
 */
export const TODAY_BRIEF_SYSTEM_PROMPT = composeIdentityPrompt(
  "Render the morning briefing JSON as a short, conversational summary (2-3 sentences, max 4). " +
  "Lead with the most time-sensitive thing in this priority: an overdue reminder or overdue followup, then the next event, " +
  "then an overdue or soon-due task. Mention overall task count, the soonest event with its time, " +
  "any pending reminders by count (call out overdue ones explicitly), any followups the agent owes today " +
  "(call those out as 'you said you would …' since they came from the user's own commitments), " +
  "and one recent note if relevant. " +
  "Be warm but concise — no bullet lists, no headers. Match the user's locale. " +
  "All times in the JSON are ALREADY formatted as the user's local clock time (e.g. a `due` of " +
  "'2026-05-19 15:00 (today)') — state them exactly as given; never convert, shift, recompute, or " +
  "reinterpret a time, and never invent one that is not in the JSON."
);

/**
 * Compose the user-message body that pairs the system prompt above
 * with a structured TodayBriefing JSON payload. Used by callers that
 * post to /api/chat (which has no system-message slot) so the
 * priority/locale guidance ships in-band.
 */
export function buildTodayBriefUserMessage(briefing: unknown): string {
  return `${TODAY_BRIEF_SYSTEM_PROMPT}\n\nBriefing JSON:\n${JSON.stringify(briefing, null, 2)}\n\nRender this as a short conversational morning brief.`;
}

export class InMemoryPromptLayerRegistry implements PromptLayerRegistry {
  private readonly layers = new Map<string, PromptLayer>();

  constructor(layers: Iterable<PromptLayer> = []) {
    for (const layer of layers) {
      this.register(layer);
    }
  }

  register(layer: PromptLayer): void {
    this.layers.set(layer.id, layer);
  }

  unregister(id: string): boolean {
    return this.layers.delete(id);
  }

  list(): readonly PromptLayer[] {
    return [...this.layers.values()].sort(comparePromptLayers);
  }

  resolve(context: PromptLayerContext): readonly PromptLayer[] {
    return this.list().filter((layer) => promptLayerApplies(layer, context));
  }
}

export function buildSystemPrompt(input: PromptBuildInput = {}): string {
  const stableSections = compactSections([
    input.providerStablePrefix,
    input.basePrompt ?? DEFAULT_BASE_PROMPT,
    renderResponseFormatInstruction(input.responseFormat, input.responseSchema)
  ]);
  const dynamicSections = compactSections([
    renderDelegatedAgent(input.delegatedAgent),
    renderExemplarContext(input.exemplarContext),
    input.requesterContext,
    renderMemoryContext("User Memory", input.userMemoryContext),
    renderMemoryContext("Session Memory", input.sessionMemoryContext),
    renderMemoryContext("Task Memory", input.taskMemoryContext),
    renderRetrievedContext(input.retrievedContext),
    renderToolResults(input.toolResults),
    input.providerDynamicSuffix
  ]);

  if (input.includeCacheBoundary) {
    return compactSections([
      stableSections.join("\n\n"),
      MUSE_CACHE_BOUNDARY_MARKER,
      dynamicSections.join("\n\n")
    ]).join("\n\n");
  }

  return compactSections([...stableSections, ...dynamicSections]).join("\n\n");
}

export interface PlanningPromptInput {
  readonly userPrompt: string;
  readonly toolDescriptions: string;
  readonly basePrompt?: string;
  /**
   * A worked plan from a similar PAST request, injected as a few-shot
   * exemplar so a small local model produces a better one-shot plan
   * (Agentic Plan Caching, arXiv 2506.14852 — reuse past plan structure).
   * Pre-rendered by the caller; omitted ⇒ no exemplar section.
   */
  readonly priorPlanExemplar?: string;
}

export function buildPlanningSystemPrompt(input: PlanningPromptInput): string {
  const segments: string[] = [];

  if (input.basePrompt && input.basePrompt.trim().length > 0) {
    segments.push(input.basePrompt.trim());
    segments.push("");
  }

  segments.push("[Role]");
  segments.push("당신은 도구 호출 계획을 세우는 플래너입니다.");
  segments.push("사용자의 요청을 분석하고, 필요한 도구 호출 순서를 JSON으로 출력하세요.");
  segments.push("절대 도구를 직접 실행하지 마세요. 계획만 출력합니다.");
  segments.push("");
  segments.push("[Available Tools]");
  segments.push("아래 도구만 계획에 포함할 수 있습니다.");
  segments.push("목록에 없는 도구는 사용할 수 없습니다.");
  segments.push("");
  segments.push(input.toolDescriptions);
  segments.push("");
  segments.push("[Output Format]");
  segments.push("반드시 JSON 배열만 출력하세요. 다른 텍스트, 설명, 마크다운은 금지합니다.");
  segments.push("각 단계는 다음 필드를 포함합니다:");
  segments.push("- tool: 도구 이름 (Available Tools에 있는 것만)");
  segments.push("- args: 도구에 전달할 인자 (객체)");
  segments.push("- description: 이 단계의 목적 (간단한 한국어 설명)");
  segments.push("");
  segments.push("예시:");
  segments.push(
    '[{"tool":"jira_get_issue","args":{"issueKey":"EXAMPLE-1"},"description":"이슈 상세 조회"},'
  );
  segments.push(
    ' {"tool":"confluence_search_by_text","args":{"keyword":"온보딩 가이드"},"description":"관련 문서 검색"}]'
  );
  segments.push("");
  segments.push("[Constraints]");
  segments.push("1. 도구가 필요 없으면 빈 배열 []을 반환하세요.");
  segments.push("2. 단계 순서는 실행 순서입니다. 의존 관계를 고려하세요.");
  segments.push("3. 동일 도구를 다른 인자로 여러 번 호출할 수 있습니다.");
  segments.push("4. 각 단계의 args는 해당 도구의 입력 스키마에 맞춰야 합니다.");
  segments.push("5. 응답은 [ 로 시작하고 ] 로 끝나야 합니다.");
  if (input.priorPlanExemplar && input.priorPlanExemplar.trim().length > 0) {
    segments.push("");
    segments.push("[Similar Past Plan]");
    segments.push("이전에 비슷한 요청을 아래 계획으로 처리했습니다. 구조가 맞으면 참고하되,");
    segments.push("현재 요청에 맞게 도구와 인자를 반드시 다시 맞추세요 (그대로 복사 금지).");
    segments.push(input.priorPlanExemplar.trim());
  }

  segments.push("");
  segments.push("[User Request]");
  segments.push(input.userPrompt);

  return segments.join("\n");
}

export function buildLayeredSystemPrompt(
  input: PromptBuildInput = {},
  layers: readonly PromptLayer[] = []
): string {
  const stableLayerText = renderPromptLayerSection(layers, "stable");
  const dynamicLayerText = renderPromptLayerSection(layers, "dynamic");

  return buildSystemPrompt({
    ...input,
    providerDynamicSuffix: mergePromptContext(dynamicLayerText, input.providerDynamicSuffix),
    providerStablePrefix: mergePromptContext(input.providerStablePrefix, stableLayerText)
  });
}

export function parseExemplarMarkdown(markdown: string): readonly ExemplarDocument[] {
  const matches = [...markdown.matchAll(EXEMPLAR_HEADER_PATTERN)];

  if (matches.length === 0) {
    return [];
  }

  const documents: ExemplarDocument[] = [];
  const seenIds = new Set<string>();

  for (const [position, match] of matches.entries()) {
    if (match.index === undefined) {
      continue;
    }

    const next = matches[position + 1];
    const block = markdown.slice(match.index, next?.index ?? markdown.length).trim();
    const index = Number.parseInt(match[1] ?? "", 10);
    const rawTitle = (match[2] ?? "").trim();
    const scenario = SCENARIO_PATTERN.exec(block)?.[1]?.trim();

    if (!Number.isFinite(index) || !rawTitle || !scenario) {
      continue;
    }

    // `id` keyed off the human number stays `exemplar-N` for a
    // well-formed file, but two blocks can legitimately share a
    // number (a bilingual file with `[Example 1 …]` AND
    // `[예시 1 …]`). Suffix collisions with the parse position so
    // the second isn't silently dropped by id-dedup / unreachable
    // by pinnedIds.
    const baseId = `exemplar-${index}`;
    const id = seenIds.has(baseId) ? `${baseId}-${position}` : baseId;
    seenIds.add(id);

    documents.push({
      body: block,
      id,
      index,
      scenario,
      title: `[${match[0].slice(1, -1).trim()}]`
    });
  }

  return documents.sort((left, right) => left.index - right.index);
}

export class FullExemplarRetriever implements ExemplarRetriever {
  constructor(private readonly fullExemplarsContent: string) {}

  retrieveTopK(): string {
    return this.fullExemplarsContent;
  }
}

export class InMemoryExemplarRetriever implements ExemplarRetriever {
  private readonly documents: readonly ExemplarDocument[];
  private readonly fallback: ExemplarRetriever;
  private readonly headerPreamble: string;
  private readonly minScore: number;
  private readonly pinnedIds: readonly string[];
  private readonly topK: number;

  constructor(markdownOrDocuments: string | readonly ExemplarDocument[], options: InMemoryExemplarRetrieverOptions = {}) {
    this.documents = typeof markdownOrDocuments === "string"
      ? parseExemplarMarkdown(markdownOrDocuments)
      : [...markdownOrDocuments].sort((left, right) => left.index - right.index);
    this.fallback = options.fallback ?? new FullExemplarRetriever(
      typeof markdownOrDocuments === "string"
        ? markdownOrDocuments.trim()
        : renderExemplarDocuments(markdownOrDocuments, options.headerPreamble)
    );
    this.headerPreamble = cleanBlock(options.headerPreamble) ?? DEFAULT_EXEMPLAR_HEADER;
    this.minScore = Math.max(1, options.minScore ?? 1);
    this.pinnedIds = options.pinnedIds ?? [];
    this.topK = Math.max(1, options.topK ?? 3);
  }

  async retrieveTopK(userPrompt: string, k: number = this.topK): Promise<string> {
    const query = cleanBlock(userPrompt);
    const limit = Math.max(0, k);

    if (!query || limit <= 0) {
      return this.fallback.retrieveTopK(userPrompt, k);
    }

    const scored = this.documents
      .map((document) => ({ document, score: scoreExemplar(query, document) }))
      .filter((item) => item.score >= this.minScore)
      .sort((left, right) => {
        const score = right.score - left.score;
        return score !== 0 ? score : left.document.index - right.document.index;
      })
      .slice(0, limit)
      .map((item) => item.document);
    const pinned = this.pinnedIds
      .map((id) => this.documents.find((document) => document.id === id))
      .filter((document): document is ExemplarDocument => document !== undefined);

    if (scored.length === 0 && pinned.length === 0) {
      return this.fallback.retrieveTopK(userPrompt, k);
    }

    // A pinned id can also be a top scorer; without dedup the same
    // exemplar is rendered twice — wasted context + a degraded
    // few-shot signal. Scored order is kept; pins fill the gaps.
    const deduped: ExemplarDocument[] = [];
    const seen = new Set<string>();
    for (const document of [...scored, ...pinned]) {
      if (seen.has(document.id)) continue;
      seen.add(document.id);
      deduped.push(document);
    }

    return renderExemplarDocuments(deduped, this.headerPreamble);
  }
}

export function renderExemplarContext(exemplars?: string): string | undefined {
  const value = cleanBlock(exemplars);

  if (!value) {
    return undefined;
  }

  return value.startsWith("[")
    ? value
    : `${DEFAULT_EXEMPLAR_HEADER}\n${value}`;
}

export function renderResponseFormatInstruction(
  responseFormat: ResponseFormat | undefined,
  responseSchema?: string
): string | undefined {
  if (responseFormat === "json") {
    return renderJsonInstruction(responseSchema);
  }

  if (responseFormat === "yaml") {
    return renderYamlInstruction(responseSchema);
  }

  return undefined;
}

export function renderJsonInstruction(responseSchema?: string): string {
  return compactLines([
    "[Response Format]",
    "Respond with valid JSON only.",
    "- Do not wrap the response in markdown code fences.",
    "- Do not include text before or after the JSON value.",
    "- The response must start with '{' or '[' and end with '}' or ']'.",
    responseSchema ? `Expected JSON schema:\n${responseSchema}` : undefined
  ]).join("\n");
}

export function renderYamlInstruction(responseSchema?: string): string {
  return compactLines([
    "[Response Format]",
    "Respond with valid YAML only.",
    "- Do not wrap the response in markdown code fences.",
    "- Do not include text before or after the YAML document.",
    "- Use 2 spaces for indentation.",
    responseSchema ? `Expected YAML structure:\n${responseSchema}` : undefined
  ]).join("\n");
}

export function renderRetrievedContext(retrievedContext?: string): string | undefined {
  const context = cleanBlock(retrievedContext);

  if (!context) {
    return undefined;
  }

  return compactLines([
    "[Retrieved Context]",
    "The following information was retrieved from a knowledge source and may be relevant.",
    "Use it when it directly supports the answer.",
    "If it does not contain the answer, say that the available sources do not answer it.",
    "Do not fill private workspace gaps with general knowledge.",
    "",
    context
  ]).join("\n");
}

export function renderToolResults(toolResults?: string): string | undefined {
  const context = cleanBlock(toolResults);

  if (!context) {
    return undefined;
  }

  return compactLines([
    "[Tool Results]",
    "The following information came from executed tools, not from retrieved documents.",
    "Use tool results as the primary source for current runtime facts.",
    "If tool results and retrieved context conflict, prefer the newer or more authoritative source.",
    "",
    context
  ]).join("\n");
}

export function mergePromptContext(primary?: string, secondary?: string): string | undefined {
  const parts = compactSections([primary, secondary]);
  return parts.length === 0 ? undefined : parts.join("\n\n");
}

export function splitPromptCacheBoundary(prompt: string): CacheBoundarySplit | undefined {
  const index = prompt.indexOf(MUSE_CACHE_BOUNDARY_MARKER);

  if (index < 0) {
    return undefined;
  }

  return {
    dynamicSuffix: prompt.slice(index + MUSE_CACHE_BOUNDARY_MARKER.length).trimStart(),
    stablePrefix: prompt.slice(0, index).trimEnd()
  };
}

export function stripPromptCacheBoundary(prompt: string): string {
  // The production-case layout `buildSystemPrompt` produces is
  //   `<stable>\n\n<marker>\n\n<dynamic>`
  // — two newlines on each side because every section is joined with
  // `\n\n`. The double-newline branch handles that exact shape and
  // collapses the marker + surrounding gap back to a single section
  // separator. The single-newline branch handles an inline
  // `text\n<marker>\nmore` shape. Final replaceAll catches any bare
  // marker that survived (no surrounding newlines), and `replaceAll`
  // everywhere so multiple markers are all removed. Without the
  // double-newline branch the production case leaks a `\n\n\n` gap
  // exactly where the marker used to sit.
  return prompt
    .replaceAll(`\n\n${MUSE_CACHE_BOUNDARY_MARKER}\n\n`, "\n\n")
    .replaceAll(`\n${MUSE_CACHE_BOUNDARY_MARKER}\n`, "\n")
    .replaceAll(MUSE_CACHE_BOUNDARY_MARKER, "");
}

export function buildPromptContextPacket(input: PromptBuildInput): PromptContextPacket {
  return {
    delegatedAgent: cleanBlock(input.delegatedAgent),
    requesterContext: cleanBlock(input.requesterContext),
    retrievedContext: cleanBlock(input.retrievedContext),
    sessionMemoryContext: cleanBlock(input.sessionMemoryContext),
    taskMemoryContext: cleanBlock(input.taskMemoryContext),
    toolResults: cleanBlock(input.toolResults),
    userMemoryContext: cleanBlock(input.userMemoryContext)
  };
}

function renderDelegatedAgent(delegatedAgent?: string): string | undefined {
  const value = cleanBlock(delegatedAgent);
  return value ? `[Delegated Agent]\n${value}` : undefined;
}

function renderPromptLayerSection(layers: readonly PromptLayer[], section: PromptLayerSection): string | undefined {
  const content = layers
    .filter((layer) => (layer.section ?? "stable") === section)
    .sort(comparePromptLayers)
    .map((layer) => cleanBlock(layer.content))
    .filter((value): value is string => value !== undefined);

  return content.length > 0 ? content.join("\n\n") : undefined;
}

function renderExemplarDocuments(documents: readonly ExemplarDocument[], headerPreamble = DEFAULT_EXEMPLAR_HEADER): string {
  const seen = new Set<string>();
  const bodies: string[] = [];

  for (const document of documents) {
    const body = cleanBlock(document.body);

    if (body && !seen.has(body)) {
      seen.add(body);
      bodies.push(body);
    }
  }

  return compactSections([headerPreamble, ...bodies]).join("\n\n");
}

function scoreExemplar(query: string, document: ExemplarDocument): number {
  const queryTokens = tokenSet(query);
  const haystack = tokenSet(`${document.title} ${document.scenario} ${document.body}`);
  let score = 0;

  for (const token of queryTokens) {
    if (haystack.has(token)) {
      score += 1;
    }
  }

  return score;
}

// Unambiguous function words that carry no topical signal. A query
// sharing only these with an exemplar (e.g. "what"/"the"/"do" or the
// Korean topic/subject/object particles) is NOT topically related —
// counting that overlap injects an off-topic few-shot into the small
// local window. Conservative by design: every entry is a pure function
// word, NEVER a content noun; when a Korean token is ambiguous it is
// left OUT so the filter can only drop noise, never a real term.
const EXEMPLAR_STOP_WORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "do", "does", "did", "can", "could", "would", "should", "will", "shall",
  "what", "which", "who", "whom", "when", "where", "why", "how",
  "about", "of", "to", "in", "on", "for", "and", "or", "but", "if",
  "with", "from", "into", "out", "this", "that", "these", "those",
  "i", "you", "he", "she", "it", "we", "they", "me", "my", "your",
  "not", "any", "all", "as", "at", "by", "so",
  // Korean particles / pro-form function words — unambiguous, never a noun.
  "은", "는", "이", "가", "을", "를", "도", "의", "에", "와", "과", "그", "어떻게"
]);

function tokenSet(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9가-힣]+/u)
      .map((token) => token.trim())
      // A single ASCII letter/digit is noise, but a single Hangul
      // syllable is a full content word (물=water, 책=book, 돈=money)
      // — Korean is a primary user language; dropping it silently
      // discarded the most salient term from exemplar scoring.
      .filter((token) => token.length >= 2 || /[가-힣]/u.test(token))
      // Additive on top of the length/Hangul rule: drop pure function
      // words so only content-word overlap scores an exemplar.
      .filter((token) => !EXEMPLAR_STOP_WORDS.has(token))
  );
}

export function comparePromptLayers(left: PromptLayer, right: PromptLayer): number {
  const priority = (left.priority ?? 100) - (right.priority ?? 100);
  return priority !== 0 ? priority : left.id.localeCompare(right.id);
}

function promptLayerApplies(layer: PromptLayer, context: PromptLayerContext): boolean {
  return matchesOptionalScope(layer.personaIds, context.personaId) &&
    matchesOptionalScope(layer.promptTemplateIds, context.promptTemplateId) &&
    matchesOptionalScope(layer.providerIds, context.providerId) &&
    matchesModelPrefix(layer.modelPrefixes, context.model);
}

function matchesOptionalScope(scope: readonly string[] | undefined, value: string | undefined): boolean {
  return !scope || scope.length === 0 || (value !== undefined && scope.includes(value));
}

function matchesModelPrefix(prefixes: readonly string[] | undefined, model: string | undefined): boolean {
  return !prefixes || prefixes.length === 0 || (model !== undefined && prefixes.some((prefix) => model.startsWith(prefix)));
}

function renderMemoryContext(title: string, context?: string): string | undefined {
  const value = cleanBlock(context);
  return value ? `[${title}]\n${value}` : undefined;
}
const EXEMPLAR_HEADER_PATTERN = /\[(?:Example|예시)\s*(\d+)\s*[-\u2010-\u2015]\s*([^\]]+?)\]/gu;
const SCENARIO_PATTERN = /<scenario>(.*?)<\/scenario>/su;
