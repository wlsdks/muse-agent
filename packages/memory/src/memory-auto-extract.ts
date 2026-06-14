/**
 * `createUserMemoryAutoExtractHook` — afterComplete agent hook that
 * runs a small structured-output LLM call against the latest user
 * prompt + assistant response and persists any newly-stated facts /
 * preferences into the `UserMemoryStore`.
 *
 * Enabled by default — JARVIS-class memory is core to the product
 * identity, and the per-turn extraction cost is the operator's own
 * (single-user-personal). Opt out via
 * `MUSE_USER_MEMORY_AUTO_EXTRACT=false` when the extra LLM call is
 * not wanted (cheap-model fallback, offline run, etc).
 *
 * Failure mode: fail-open. Any error in the extraction call (timeout,
 * malformed JSON, store write fail) is swallowed — the agent run that
 * triggered the hook still succeeds.
 */

import type { ModelMessage, ModelProvider, ModelResponse } from "@muse/model";
import { redactSecretsInText, stripUntrustedTerminalChars, type JsonObject } from "@muse/shared";

import type { BeliefProvenance, BeliefProvenanceStore } from "./belief-provenance-store.js";
import { classifyMemoryOperation, normalizeMemoryKey } from "./memory-user-store.js";
import { extractJsonObject } from "./memory-extract-json.js";
export { extractJsonObject } from "./memory-extract-json.js";
import { sanitizeEntries, sanitizeSlotArray, type ExtractedSlot } from "./memory-auto-extract-sanitize.js";
import type {
  UserGoalSlot,
  UserMemoryStore,
  UserVetoSlot
} from "./index.js";

/** Character cap on the user-message snippet stored as belief evidence. */
const PROVENANCE_EXCERPT_MAX = 160;

interface ProvenanceContext {
  readonly store: BeliefProvenanceStore;
  readonly sessionId?: string;
  readonly evidenceExcerpt?: string;
  readonly now: () => number;
}

// Structural duck-type of @muse/agent-core's HookStage / AgentRunContext.
// We avoid importing from agent-core because agent-core depends on
// @muse/memory (circular). Consumers (e.g. autoconfigure) treat the
// return value as a HookStage at the registration call site — TS
// structural typing makes that work without a runtime type tag.
interface AgentRunInputView {
  readonly messages: readonly ModelMessage[];
  readonly metadata?: JsonObject;
}

interface AgentRunContextView {
  readonly runId: string;
  readonly input: AgentRunInputView;
}

interface HookStageShape {
  readonly id: string;
  readonly afterComplete?: (context: AgentRunContextView, response: ModelResponse) => Promise<void>;
}

export interface UserMemoryAutoExtractOptions {
  readonly store: UserMemoryStore;
  readonly modelProvider: ModelProvider;
  readonly model: string;
  /**
   * Optional belief-provenance store (Hindsight evidence pointer). When
   * wired, each auto-extracted fact/preference records where it was learned
   * (when / session / a user-message excerpt). Fail-open: a provenance write
   * failure never blocks the memory write; absent ⇒ exact no-op.
   */
  readonly provenanceStore?: BeliefProvenanceStore;
  readonly maxFactsPerExchange?: number;
  readonly maxPreferencesPerExchange?: number;
  readonly maxVetoesPerExchange?: number;
  readonly maxGoalsPerExchange?: number;
  readonly maxKeyLength?: number;
  readonly maxValueLength?: number;
  /**
   * Character cap on the user-turn slice that's sent to the
   * extraction model. Default 2048. The extractor only needs
   * enough text to identify newly-stated facts; an entire 100KB
   * message would otherwise balloon the extra LLM call.
   */
  readonly maxUserPromptChars?: number;
  /**
   * Character cap on the assistant-reply slice. Default 2048.
   * Mirrors the user-prompt cap.
   */
  readonly maxAssistantOutputChars?: number;
  /**
   * Wall-clock timeout for the extraction `generate()` call in
   * milliseconds. Default 10_000 (10s). If the extractor model
   * hangs (network stall, runaway provider, broken adapter), the
   * hook would otherwise block the `afterComplete` chain forever
   * and prevent the next run from starting. Times out → fail-open
   * (same path as a thrown error).
   */
  readonly extractionTimeoutMs?: number;
  /**
   * Minimum interval between extractions per user
   * (milliseconds). When a turn fires inside the cooldown
   * window for that user, the extraction is skipped silently
   * (fail-open). Default 60_000 (1/min). 0 disables throttling.
   */
  readonly extractionCooldownMs?: number;
  /**
   * Injectable clock for deterministic tests. The
   * throttle compares `now()` against the per-user last-fire
   * timestamp; without this, tests have to wait real seconds
   * to see the cooldown elapse.
   */
  readonly now?: () => number;
}

export interface ExtractionPayload {
  readonly facts?: Readonly<Record<string, string>>;
  readonly preferences?: Readonly<Record<string, string>>;
  readonly vetoes?: readonly ExtractedSlot[];
  readonly goals?: readonly ExtractedSlot[];
}

const systemPromptEn = `You analyse a single exchange (the latest user turn + assistant reply) and extract any NEW personal facts, preferences, vetoes, or goals the user revealed. Output strict JSON of shape:
{
  "facts": { "<short_key>": "<value>" },
  "preferences": { "<short_key>": "<value>" },
  "vetoes": [{"id": "<short_id>", "value": "<rule>", "scope": "<optional>"}],
  "goals": [{"id": "<short_id>", "value": "<objective>"}]
}
Rules:
- Only include items the user explicitly stated this turn (not inferred).
- Keys/ids are snake_case ASCII, max 32 chars (e.g. spouse_name, no_eggs, ship_v1).
- Values are concise strings, max 200 chars.
- Vetoes are explicit "do not / never / avoid" rules ("never suggest eggs", "no meetings on Mondays"). Optional scope is a short tag like "food", "tooling", "meetings".
- Goals are multi-session objectives ("I want to ship Muse 1.0 by Q1", "learn Korean by summer"). Skip single-turn intentions.
- If nothing new to record, output {"facts":{},"preferences":{},"vetoes":[],"goals":[]}.
- Output only the JSON object. No prose, no code fence.`;

const systemPromptKo = `이번 대화 한 턴(최신 사용자 발화 + 어시스턴트 응답)을 분석하여 사용자가 새로 드러낸 개인 사실(facts), 선호(preferences), 금기(vetoes), 목표(goals)를 추출하라. 다음 JSON 스키마를 정확히 따르라:
{
  "facts": { "<short_key>": "<value>" },
  "preferences": { "<short_key>": "<value>" },
  "vetoes": [{"id": "<short_id>", "value": "<rule>", "scope": "<optional>"}],
  "goals": [{"id": "<short_id>", "value": "<objective>"}]
}
규칙:
- 이번 턴에서 사용자가 명시적으로 말한 항목만 포함하라(추론 금지).
- key/id는 snake_case ASCII, 최대 32자 (예: spouse_name, no_eggs, ship_v1). 키는 영어로 쓰되 value는 한국어 그대로 둘 수 있다.
- value는 간결한 문자열, 최대 200자.
- vetoes는 명시적 "하지 마라 / 절대 / 피하라" 류 규칙("계란 추천 금지", "월요일에는 회의 잡지 마"). scope는 "food", "tooling", "meetings" 같은 짧은 태그.
- goals는 여러 세션에 걸친 다단계 목표("Q1까지 Muse 1.0 출시", "여름까지 한국어 배우기"). 한 턴짜리 의도는 제외.
- 새로 기록할 게 없으면 {"facts":{},"preferences":{},"vetoes":[],"goals":[]} 출력.
- JSON 객체만 출력하라. 추가 설명, 코드 펜스 금지.`;

/**
 * Pick the auto-extract system prompt based on the user's message
 * language. Heuristic: ratio of Hangul syllables (U+AC00–U+D7AF)
 * over total characters; >= 30% triggers the Korean prompt.
 * Anything else (English, mixed, or non-Korean non-ASCII) keeps
 * the English prompt as the conservative default.
 */
export function pickAutoExtractSystemPrompt(userPrompt: string): string {
  const total = userPrompt.length;
  if (total === 0) {
    return systemPromptEn;
  }
  let hangul = 0;
  for (const char of userPrompt) {
    const code = char.codePointAt(0);
    if (code !== undefined && code >= 0xAC00 && code <= 0xD7AF) {
      hangul += 1;
    }
  }
  return hangul / total >= 0.3 ? systemPromptKo : systemPromptEn;
}

export function createUserMemoryAutoExtractHook(options: UserMemoryAutoExtractOptions): HookStageShape {
  const maxFacts = Math.max(0, Math.trunc(options.maxFactsPerExchange ?? 5));
  const maxPreferences = Math.max(0, Math.trunc(options.maxPreferencesPerExchange ?? 5));
  const maxVetoes = Math.max(0, Math.trunc(options.maxVetoesPerExchange ?? 3));
  const maxGoals = Math.max(0, Math.trunc(options.maxGoalsPerExchange ?? 3));
  const maxKey = Math.max(1, Math.trunc(options.maxKeyLength ?? 32));
  const maxValue = Math.max(1, Math.trunc(options.maxValueLength ?? 200));
  const maxUserPrompt = Math.max(64, Math.trunc(options.maxUserPromptChars ?? 2_048));
  const maxAssistantOutput = Math.max(64, Math.trunc(options.maxAssistantOutputChars ?? 2_048));
  const extractionTimeoutMs = Math.max(100, Math.trunc(options.extractionTimeoutMs ?? 10_000));
  // Per-user cooldown stops a burst of short turns from churning
  // user-memory.json. Explicit 0 disables.
  const extractionCooldownMs = Math.max(0, Math.trunc(options.extractionCooldownMs ?? 60_000));
  const now = options.now ?? (() => Date.now());
  const lastFiredByUser = new Map<string, number>();

  return {
    afterComplete: async (context, response) => {
      const userId = readUserId(context);
      if (!userId) {
        return;
      }
      // Per-run opt-out for READ/recall surfaces (e.g. `muse ask`). Auto-extract
      // mines the assistant output too, so a one-shot Q&A would distil the
      // MODEL's own general-knowledge assertions ("WireGuard default MTU is
      // 1420") as facts ABOUT the user — a provenance fabrication the next recall
      // cites as "from what you told me". A recall command sets this so only the
      // conversational surface (chat) and the explicit `muse remember` author
      // durable memory.
      if (readSkipAutoExtract(context)) {
        return;
      }
      const userPrompt = latestUserMessage(context);
      const assistantOutput = response.output?.trim() ?? "";
      if (!userPrompt || !assistantOutput) {
        return;
      }
      // Throttle gate — skip silently within the cooldown window.
      // Fail-open: a lost extraction beats blocking later runs.
      if (extractionCooldownMs > 0) {
        const lastFiredAt = lastFiredByUser.get(userId);
        const nowMs = now();
        if (lastFiredAt !== undefined && nowMs - lastFiredAt < extractionCooldownMs) {
          return;
        }
        lastFiredByUser.set(userId, nowMs);
      }

      // Bound the extraction-call cost: a 100KB user turn would
      // otherwise echo all 100KB into the extra LLM call. The
      // extractor only needs enough text to identify newly-stated
      // facts in this turn.
      const boundedUser = userPrompt.length > maxUserPrompt
        ? `${userPrompt.slice(0, maxUserPrompt - 1)}…`
        : userPrompt;
      const boundedAssistant = assistantOutput.length > maxAssistantOutput
        ? `${assistantOutput.slice(0, maxAssistantOutput - 1)}…`
        : assistantOutput;
      try {
        const payload = await runWithTimeout(
          runExtraction(options.modelProvider, options.model, boundedUser, boundedAssistant),
          extractionTimeoutMs
        );
        if (!payload) {
          return;
        }
        // Provenance gate: a fact/preference whose value the MODEL asserted (in
        // its reply) but the USER never said (absent from their turn) is dropped
        // — never persisted as "what you told me". Vetoes/goals are explicit
        // user directives and left as-is.
        // Only filter a proper Record — a malformed array-shaped facts/preferences
        // (a reasoning-off model sometimes emits one) is left untouched so the
        // downstream sanitizer still rejects it instead of being silently coerced.
        const groundedPayload: ExtractionPayload = {
          ...payload,
          ...(payload.facts && !Array.isArray(payload.facts)
            ? { facts: dropModelAssertedValues(payload.facts, boundedUser, boundedAssistant) }
            : {}),
          ...(payload.preferences && !Array.isArray(payload.preferences)
            ? { preferences: dropModelAssertedValues(payload.preferences, boundedUser, boundedAssistant) }
            : {})
        };
        const provenance: ProvenanceContext | undefined = options.provenanceStore
          ? {
              store: options.provenanceStore,
              now,
              ...(readSessionId(context) ? { sessionId: readSessionId(context) } : {}),
              evidenceExcerpt: redactSecretsInText(stripUntrustedTerminalChars(userPrompt))
                .replace(/\s+/gu, " ")
                .trim()
                .slice(0, PROVENANCE_EXCERPT_MAX)
            }
          : undefined;
        await persist(options.store, userId, groundedPayload, {
          maxFacts,
          maxGoals,
          maxKey,
          maxPreferences,
          maxValue,
          maxVetoes
        }, provenance);
      } catch {
        // fail-open — including the timeout path. The next run
        // is not blocked.
      }
    },
    id: "user-memory-auto-extract"
  };
}

/**
 * Race a promise against a wall-clock timer. Resolves with the
 * promise's value if it lands first, rejects with a timeout error
 * otherwise. The underlying promise is NOT cancelled — JS has no
 * native cancellation primitive — but the caller stops awaiting it
 * so downstream lifecycle (the agent's next run) is unblocked.
 *
 * Used by the auto-extract hook to keep a misbehaving extractor
 * model from hanging `afterComplete` indefinitely.
 */
async function runWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timerHandle: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => {
    timerHandle = setTimeout(() => reject(new Error("auto-extract: extraction timed out")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timer]);
  } finally {
    if (timerHandle !== undefined) {
      clearTimeout(timerHandle);
    }
  }
}

function readUserId(context: AgentRunContextView): string | undefined {
  const candidate = context.input.metadata?.userId;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : undefined;
}

/**
 * Whether this run explicitly opted out of user-memory auto-extraction via
 * `metadata.skipUserMemoryAutoExtract`. Read/recall surfaces set it so a
 * question-answering turn never authors durable memory from the model's output.
 */
export function readSkipAutoExtract(context: AgentRunContextView): boolean {
  return context.input.metadata?.skipUserMemoryAutoExtract === true;
}

// Generic / boolean-ish value words that carry no provenance signal — a fact
// value of just "yes" (e.g. allergy_penicillin: yes, inferred from the user
// saying "I'm allergic to penicillin") must NOT be judged by where the word
// "yes" appears. Only DISTINCTIVE value tokens (a number, a name, a place) tell
// us whose assertion it was.
const NON_DISTINCTIVE_VALUE_TOKENS = new Set([
  "yes", "no", "true", "false", "none", "null", "na", "ok", "okay", "unknown",
  "the", "a", "an", "is", "are", "was", "were", "to", "of", "in", "on", "at", "and", "or"
]);

function distinctiveValueTokens(text: string): string[] {
  return [...new Set(
    text.toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length >= 2 && !NON_DISTINCTIVE_VALUE_TOKENS.has(token))
  )];
}

/**
 * Drop any fact/preference whose VALUE is demonstrably the MODEL's assertion,
 * not the user's: all of its distinctive tokens appear in the assistant reply
 * yet NONE appear in the user's own turn. This closes a provenance fabrication —
 * a one-shot Q&A ("what's WireGuard's default MTU?" → "1420") would otherwise
 * distil `wireguard_default_mtu: 1420` as a fact the USER stated, which a later
 * recall cites as "from what you told me". A user-stated value (its tokens are
 * in the user turn) survives; an inferred boolean ("yes"/"none", no distinctive
 * tokens) survives (fail-open — we can't attribute it, so we keep it). Pure +
 * exported; the same shape as the citation gate (code, not a prompt plea).
 */
export function dropModelAssertedValues(
  record: Readonly<Record<string, string>>,
  userTurn: string,
  assistantOutput: string
): Record<string, string> {
  const userTokens = new Set(distinctiveValueTokens(userTurn));
  const assistantTokens = new Set(distinctiveValueTokens(assistantOutput));
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    const valueTokens = distinctiveValueTokens(value);
    const modelAsserted = valueTokens.length > 0
      && valueTokens.every((token) => assistantTokens.has(token))
      && valueTokens.every((token) => !userTokens.has(token));
    if (!modelAsserted) {
      out[key] = value;
    }
  }
  return out;
}

function readSessionId(context: AgentRunContextView): string | undefined {
  const candidate = context.input.metadata?.sessionId;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : undefined;
}

function latestUserMessage(context: AgentRunContextView): string | undefined {
  const messages = context.input.messages;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && typeof message.content === "string") {
      return message.content.trim();
    }
  }
  return undefined;
}

/**
 * JSON Schema for the extraction output (native structured output where the
 * provider supports it → guaranteed shape; extractJsonObject stays the fallback
 * otherwise). Matches the {facts,preferences,vetoes,goals} contract the prompt
 * already demands. Empty maps/arrays mean "nothing new to record".
 */
const AUTO_EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    facts: { type: "object", additionalProperties: { type: "string" } },
    preferences: { type: "object", additionalProperties: { type: "string" } },
    vetoes: {
      type: "array",
      items: { type: "object", properties: { id: { type: "string" }, value: { type: "string" }, scope: { type: "string" } }, required: ["id", "value"] }
    },
    goals: {
      type: "array",
      items: { type: "object", properties: { id: { type: "string" }, value: { type: "string" } }, required: ["id", "value"] }
    }
  },
  required: ["facts", "preferences", "vetoes", "goals"],
  additionalProperties: false
};

async function runExtraction(
  modelProvider: ModelProvider,
  model: string,
  userPrompt: string,
  assistantOutput: string
): Promise<ExtractionPayload | undefined> {
  const systemPrompt = pickAutoExtractSystemPrompt(userPrompt);
  const response = await modelProvider.generate({
    maxOutputTokens: 512,
    messages: [
      { content: systemPrompt, role: "system" },
      {
        content: `User turn:\n${userPrompt}\n\nAssistant reply:\n${assistantOutput}`,
        role: "user"
      }
    ],
    model,
    responseFormat: AUTO_EXTRACT_SCHEMA,
    temperature: 0
  });

  if (!response.output) {
    return undefined;
  }
  return extractJsonObject(response.output);
}

/**
 * Best-effort JSON-object extractor. The model is told to emit raw
 * JSON, but smaller models sometimes wrap the payload in
 * `Here's the JSON:\n{...}` prose or stick a trailing comment after
 * the closing brace. This helper:
 *   1. strips outer whitespace
 *   2. strips a markdown code fence if present
 *   3. otherwise scans for the FIRST balanced `{ ... }` block in the
 *      text and parses it
 * Returns undefined when no parseable object is found so the caller
 * fails open just like before.
 */
interface PersistLimits {
  readonly maxFacts: number;
  readonly maxPreferences: number;
  readonly maxVetoes: number;
  readonly maxGoals: number;
  readonly maxKey: number;
  readonly maxValue: number;
}

async function persist(
  store: UserMemoryStore,
  userId: string,
  payload: ExtractionPayload,
  limits: PersistLimits,
  provenance?: ProvenanceContext
): Promise<void> {
  const factEntries = sanitizeEntries(payload.facts, limits.maxFacts, limits.maxKey, limits.maxValue);
  const preferenceEntries = sanitizeEntries(
    payload.preferences,
    limits.maxPreferences,
    limits.maxKey,
    limits.maxValue
  );
  const vetoSlots = sanitizeSlotArray(payload.vetoes, limits.maxVetoes, limits.maxKey, limits.maxValue);
  const goalSlots = sanitizeSlotArray(payload.goals, limits.maxGoals, limits.maxKey, limits.maxValue);

  // parallelise the writes. Pre-iter-51 this loop ran 16
  // sequential `await store.upsertX(...)` calls per turn (5 facts +
  // 5 prefs + 3 vetoes + 3 goals). For an `InMemoryUserMemoryStore`
  // that's a fixed cost in microseconds — fine. For a Kysely-backed
  // `KyselyUserMemoryStore` against Postgres each call is a round
  // trip; 16 sequential trips at ~10ms each = ~160ms blocking
  // `afterComplete` on every assistant turn. Parallelising drops
  // wall-clock to ~one round trip.
  //
  // The keys are unique within each list (sanitize dedupes via
  // Object.entries / id-keyed slots) so there's no within-batch
  // ordering dependency. Per-write `catch` swallows individual
  // failures: the surrounding `afterComplete` is already
  // fail-open, and partial success across 16 writes is preferable
  // to all-or-nothing on the first failure.
  const writes: Promise<void>[] = [];
  // Provenance entries are COLLECTED and written in one batch after the
  // memory writes — recording them as concurrent per-key writes would race
  // on the shared provenance file (last write wins).
  const learnedAt = provenance ? new Date(provenance.now()).toISOString() : "";
  const provenanceEntries: BeliefProvenance[] = [];
  const collectProvenance = (kind: "fact" | "preference", key: string, value: string): void => {
    if (!provenance) return;
    provenanceEntries.push({
      userId,
      key: normalizeMemoryKey(key),
      kind,
      value,
      learnedAt,
      source: "auto",
      ...(provenance.sessionId ? { sessionId: provenance.sessionId } : {}),
      ...(provenance.evidenceExcerpt ? { evidenceExcerpt: provenance.evidenceExcerpt } : {})
    });
  };
  // Mem0 (arXiv 2504.19413): classify each candidate against existing memory
  // (ADD/UPDATE/NOOP/DELETE) instead of blind-upserting — NOOP skips the
  // redundant write + provenance on a re-confirmation, DELETE drops a key the
  // extractor reported as a no-value/retraction token rather than storing junk.
  const existing = await Promise.resolve(store.findByUserId(userId)).catch(() => undefined);
  const forget = store.forget?.bind(store);
  const applyOp = (kind: "fact" | "preference", key: string, value: string, current: string | undefined): void => {
    const op = classifyMemoryOperation(current, value);
    if (op === "noop") {
      return;
    }
    if (op === "delete") {
      // Scope the retraction to THIS namespace — a fact retraction must not also
      // wipe a same-key preference (and vice versa).
      if (forget) writes.push(safeWrite(Promise.resolve(forget(userId, key, kind))));
      return;
    }
    writes.push(safeWrite(kind === "fact" ? store.upsertFact(userId, key, value) : store.upsertPreference(userId, key, value)));
    collectProvenance(kind, key, value);
  };
  for (const [key, value] of factEntries) {
    applyOp("fact", key, value, existing?.facts?.[normalizeMemoryKey(key)]);
  }
  for (const [key, value] of preferenceEntries) {
    applyOp("preference", key, value, existing?.preferences?.[normalizeMemoryKey(key)]);
  }
  // Typed-slot writes are skipped silently when the store doesn't
  // support upsertUserModelSlot (an optional method on
  // UserMemoryStore). The first-party InMemory + Kysely stores
  // implement it; this branch no-ops for third-party impls.
  const upsertSlot = store.upsertUserModelSlot?.bind(store);
  if (upsertSlot) {
    const now = new Date();
    for (const slot of vetoSlots) {
      const veto: UserVetoSlot = {
        id: slot.id,
        kind: "veto",
        updatedAt: now,
        value: slot.value,
        ...(slot.scope ? { scope: slot.scope } : {})
      };
      writes.push(safeWrite(upsertSlot(userId, veto)));
    }
    for (const slot of goalSlots) {
      const goal: UserGoalSlot = {
        id: slot.id,
        kind: "goal",
        updatedAt: now,
        value: slot.value
      };
      writes.push(safeWrite(upsertSlot(userId, goal)));
    }
  }
  await Promise.all(writes);
  if (provenance && provenanceEntries.length > 0) {
    await safeWrite(provenance.store.recordMany(provenanceEntries));
  }
}

/**
 * Per-write catch. The auto-extract hook is fail-open at the
 * `afterComplete` boundary, so a single store-write failure must
 * not poison `Promise.all` and abort the other 15 in-flight
 * writes. Returning `undefined` on rejection lets the parallel
 * batch settle so every salvageable extraction lands.
 *
 * Accepts `Awaitable<T>` (the shape `UserMemoryStore.upsertX`
 * methods return) — synchronous stores resolve through the
 * `await` boundary cleanly.
 */
async function safeWrite(awaitable: unknown): Promise<void> {
  try {
    await awaitable;
  } catch {
    // partial failure tolerated
  }
}

