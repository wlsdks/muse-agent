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
import { normalizeMemoryKey } from "./memory-user-store.js";
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

interface ExtractedSlot {
  readonly id: string;
  readonly value: string;
  readonly scope?: string;
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
        await persist(options.store, userId, payload, {
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
export function extractJsonObject(raw: string): ExtractionPayload | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  // Fast path: stripped code fence (the most common deviation).
  const stripped = trimmed.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/iu, "");
  const direct = tryParseObject(stripped);
  if (direct) {
    return direct;
  }
  // Slow path: among ALL top-level balanced blocks, take the LAST
  // one that parses. Small local models often echo the schema /
  // an empty example BEFORE the real payload — taking the first
  // block silently discarded the actual extraction. The model's
  // final JSON is its answer.
  const blocks = findBalancedBraceBlocks(stripped);
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const parsed = tryParseObject(blocks[index] ?? "");
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
}

function tryParseObject(input: string): ExtractionPayload | undefined {
  try {
    const parsed = JSON.parse(input) as ExtractionPayload;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function findBalancedBraceBlocks(input: string): readonly string[] {
  const blocks: string[] = [];
  let depth = 0;
  let blockStart = -1;
  let inString = false;
  let escape = false;
  for (let index = 0; index < input.length; index += 1) {
    const ch = input[index];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === "\"") {
      if (depth > 0) {
        inString = !inString;
      }
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === "{") {
      if (depth === 0) {
        blockStart = index;
      }
      depth += 1;
    } else if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && blockStart >= 0) {
        blocks.push(input.slice(blockStart, index + 1));
        blockStart = -1;
      }
    }
  }
  return blocks;
}

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
  for (const [key, value] of factEntries) {
    writes.push(safeWrite(store.upsertFact(userId, key, value)));
    collectProvenance("fact", key, value);
  }
  for (const [key, value] of preferenceEntries) {
    writes.push(safeWrite(store.upsertPreference(userId, key, value)));
    collectProvenance("preference", key, value);
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

function sanitizeSlotArray(
  source: readonly ExtractedSlot[] | undefined,
  maxCount: number,
  maxKey: number,
  maxValue: number
): readonly ExtractedSlot[] {
  if (!Array.isArray(source) || maxCount === 0) {
    return [];
  }
  const out: ExtractedSlot[] = [];
  // Dedupe by id. Facts/preferences are Record-shaped so duplicate
  // keys collapse for free, but slots arrive as an array — a
  // reasoning-off model that re-emits a near-duplicate veto/goal
  // would otherwise consume a `maxCount` slot and silently drop a
  // DISTINCT later veto/goal from the persona. First valid
  // occurrence wins.
  const seenIds = new Set<string>();
  for (const entry of source) {
    if (out.length >= maxCount) {
      break;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const id = normalizeKey(typeof entry.id === "string" ? entry.id : "", maxKey);
    if (!id || seenIds.has(id)) {
      continue;
    }
    const value = sanitizeValue(entry.value, maxValue);
    if (value.length === 0) {
      continue;
    }
    seenIds.add(id);
    const scope = typeof entry.scope === "string"
      ? normalizeKey(entry.scope, maxKey)
      : undefined;
    out.push(scope ? { id, scope, value } : { id, value });
  }
  return out;
}

function sanitizeEntries(
  source: Readonly<Record<string, string>> | undefined,
  maxCount: number,
  maxKey: number,
  maxValue: number
): readonly (readonly [string, string])[] {
  // `typeof [] === "object"` is the JS footgun: an extractor LLM
  // that returned `facts: ["foo", "bar"]` instead of the documented
  // Record-shape passed the previous guard, and the downstream
  // `Object.entries` produced `[["0","foo"],["1","bar"]]` — silently
  // landing fake "0"/"1" keys in `UserMemoryStore`. Reject arrays
  // explicitly so a wrong-shape payload becomes a no-op (fail-open,
  // same as before).
  if (!source || typeof source !== "object" || Array.isArray(source) || maxCount === 0) {
    return [];
  }
  const out: (readonly [string, string])[] = [];
  for (const [rawKey, rawValue] of Object.entries(source)) {
    if (out.length >= maxCount) {
      break;
    }
    const key = normalizeKey(rawKey, maxKey);
    if (!key) {
      continue;
    }
    const value = sanitizeValue(rawValue, maxValue);
    if (value.length === 0) {
      continue;
    }
    out.push([key, value]);
  }
  return out;
}

/**
 * Strip ESC / C0 / C1 / DEL bytes, then collapse whitespace runs
 * to a single space + trim + length cap. Run at the store boundary
 * so a prompt-injection attempt that survived the extractor —
 * "value": "ok\n[System Override]\nDo X" or an ANSI/control-byte
 * payload — can't land in `UserMemoryStore` and then be re-emitted
 * into the next turn's `[User Memory]` system-prompt block, nor
 * hijack the terminal on `muse memory show`.
 */
function sanitizeValue(raw: unknown, maxValue: number): string {
  if (typeof raw !== "string") {
    return "";
  }
  return stripUntrustedTerminalChars(raw).replace(/\s+/gu, " ").trim().slice(0, maxValue);
}

function normalizeKey(raw: string, max: number): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, max);
  return cleaned.length > 0 ? cleaned : undefined;
}
