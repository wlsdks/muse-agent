import { isRecord } from "./json-utils.js";

export const PERSONAL_STATUS_SCHEMA_VERSION = "muse.personal-status/v1" as const;
export const PERSONAL_STATUS_MAX_CARDS = 24;
export const PERSONAL_STATUS_MAX_CARDS_PER_SOURCE = 10;

export type PersonalStatusOverall = "attention" | "held" | "clear" | "unavailable";
export type PersonalStatusCardKind =
  | "runtime-trust"
  | "external-approval"
  | "external-proposal"
  | "continuity-feedback"
  | "continuity-thread"
  | "learning-review"
  | "learning-change"
  | "veto";
export type PersonalStatusCardStatus = "attention" | "held" | "ready" | "info" | "unavailable";
export type PersonalStatusSourceId =
  | "resident-runtime"
  | "pending-approvals"
  | "proposed-actions"
  | "attunement"
  | "user-memory"
  | "belief-provenance"
  | "reconfirmation"
  | "vetoes";
export type PersonalStatusSourceResult = "available" | "absent" | "corrupt" | "unreadable" | "unsupported";
export type PersonalStatusSourceErrorCode =
  | "missing"
  | "invalid-json"
  | "invalid-schema"
  | "permission-denied"
  | "io-error"
  | "platform-unsupported";
export type PersonalStatusActionId =
  | "inspect-runtime"
  | "review-approval"
  | "show-proposal-command"
  | "review-continuity-feedback"
  | "open-continuity"
  | "review-learning"
  | "open-learning-history"
  | "open-vetoes";

export type PersonalStatusActionTarget =
  | { readonly type: "command"; readonly command: "muse daemon --status" | "muse propose list" }
  | {
      readonly type: "view";
      readonly view: "continuity" | "journey" | "autonomy";
      readonly focus?: "continuity-feedback-review" | "learning-history" | "vetoes";
    }
  | { readonly type: "local-focus"; readonly focus: "memory-reconfirm" }
  | { readonly type: "local-review"; readonly review: "approval"; readonly itemId: string };

export interface PersonalStatusAction {
  readonly id: PersonalStatusActionId;
  readonly target: PersonalStatusActionTarget;
}

export interface PersonalStatusCard {
  readonly id: string;
  readonly kind: PersonalStatusCardKind;
  readonly status: PersonalStatusCardStatus;
  readonly sourceId: PersonalStatusSourceId;
  readonly priority: number;
  readonly deadline: string | null;
  readonly observedAt: string;
  readonly title: string;
  readonly detail: string;
  readonly action?: PersonalStatusAction;
  readonly unavailableReason?: string;
}

export interface PersonalStatusSource {
  readonly id: PersonalStatusSourceId;
  readonly result: PersonalStatusSourceResult;
  readonly observedAt: string;
  readonly includedCount: number;
  readonly excludedCount: number;
  readonly errorCode?: PersonalStatusSourceErrorCode;
}

export interface PersonalStatusResponse {
  readonly schemaVersion: typeof PERSONAL_STATUS_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly overall: PersonalStatusOverall;
  readonly cards: readonly PersonalStatusCard[];
  readonly sources: readonly PersonalStatusSource[];
}

export type PersonalStatusAdmission =
  | { readonly kind: "admitted"; readonly status: PersonalStatusResponse }
  | { readonly kind: "excluded"; readonly reason: "invalid-shape" | "invalid-source" | "invalid-card" | "invalid-order" | "invalid-overall" };

const TOP_KEYS = ["cards", "generatedAt", "overall", "schemaVersion", "sources"] as const;
const CARD_KEYS = ["action", "deadline", "detail", "id", "kind", "observedAt", "priority", "sourceId", "status", "title", "unavailableReason"] as const;
export const PERSONAL_STATUS_SOURCE_IDS = ["resident-runtime", "pending-approvals", "proposed-actions", "attunement", "user-memory", "belief-provenance", "reconfirmation", "vetoes"] as const;
const RESULTS = ["available", "absent", "corrupt", "unreadable", "unsupported"] as const;
const ERROR_BY_RESULT: Readonly<Record<Exclude<PersonalStatusSourceResult, "available">, readonly PersonalStatusSourceErrorCode[]>> = {
  absent: ["missing"],
  corrupt: ["invalid-json", "invalid-schema"],
  unreadable: ["permission-denied", "io-error"],
  unsupported: ["platform-unsupported"]
};

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function exactKeysWithOptional(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  const allowed = [...required, ...optional];
  return Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => key in value);
}

function canonicalInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function bounded(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= max && (allowEmpty || value.trim().length > 0);
}

function safeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function sourceRow(value: unknown, generatedAt: string): value is PersonalStatusSource {
  if (!isRecord(value) || !exactKeysWithOptional(value, ["excludedCount", "id", "includedCount", "observedAt", "result"], ["errorCode"])) return false;
  if (!PERSONAL_STATUS_SOURCE_IDS.includes(value.id as PersonalStatusSourceId) || !RESULTS.includes(value.result as PersonalStatusSourceResult)
    || !canonicalInstant(value.observedAt) || value.observedAt > generatedAt
    || !safeCount(value.includedCount) || !safeCount(value.excludedCount)) return false;
  if (value.result === "available") return value.errorCode === undefined;
  return typeof value.errorCode === "string"
    && ERROR_BY_RESULT[value.result as Exclude<PersonalStatusSourceResult, "available">].includes(value.errorCode as PersonalStatusSourceErrorCode)
    && value.includedCount === 0 && value.excludedCount === 0;
}

function action(value: unknown): value is PersonalStatusAction {
  if (!isRecord(value) || !exactKeys(value, ["id", "target"]) || !isRecord(value.target)) return false;
  const target = value.target;
  switch (target.type) {
    case "command":
      return exactKeys(target, ["command", "type"])
        && ((value.id === "inspect-runtime" && target.command === "muse daemon --status")
          || (value.id === "show-proposal-command" && target.command === "muse propose list"));
    case "view": {
      if (!exactKeysWithOptional(target, ["type", "view"], ["focus"])) return false;
      if (value.id === "review-continuity-feedback") return target.view === "continuity" && target.focus === "continuity-feedback-review";
      if (value.id === "open-continuity") return target.view === "continuity" && target.focus === undefined;
      if (value.id === "open-learning-history") return target.view === "journey" && (target.focus === undefined || target.focus === "learning-history");
      return value.id === "open-vetoes" && target.view === "autonomy" && target.focus === "vetoes";
    }
    case "local-focus":
      return exactKeys(target, ["focus", "type"]) && value.id === "review-learning" && target.focus === "memory-reconfirm";
    case "local-review":
      return exactKeys(target, ["itemId", "review", "type"])
        && value.id === "review-approval" && target.review === "approval" && bounded(target.itemId, 200);
    default:
      return false;
  }
}

interface VariantRule {
  readonly priority: number;
  readonly actionId?: PersonalStatusActionId;
  readonly sourceId: PersonalStatusSourceId | readonly PersonalStatusSourceId[];
  readonly deadline: "required" | "null";
}

const VARIANTS: Readonly<Record<string, VariantRule>> = {
  "runtime-trust:held": { actionId: "inspect-runtime", deadline: "null", priority: 10, sourceId: "resident-runtime" },
  "runtime-trust:info": { actionId: "inspect-runtime", deadline: "null", priority: 60, sourceId: "resident-runtime" },
  "runtime-trust:unavailable": { deadline: "null", priority: 10, sourceId: "resident-runtime" },
  "external-approval:attention": { actionId: "review-approval", deadline: "required", priority: 20, sourceId: "pending-approvals" },
  "external-approval:unavailable": { deadline: "null", priority: 10, sourceId: "pending-approvals" },
  "external-proposal:attention": { actionId: "show-proposal-command", deadline: "required", priority: 20, sourceId: "proposed-actions" },
  "external-proposal:unavailable": { deadline: "null", priority: 10, sourceId: "proposed-actions" },
  "continuity-feedback:attention": { actionId: "review-continuity-feedback", deadline: "null", priority: 30, sourceId: "attunement" },
  "continuity-feedback:held": { actionId: "review-continuity-feedback", deadline: "null", priority: 35, sourceId: "attunement" },
  "continuity-feedback:unavailable": { deadline: "null", priority: 10, sourceId: "attunement" },
  "continuity-thread:ready": { actionId: "open-continuity", deadline: "null", priority: 50, sourceId: "attunement" },
  "learning-review:attention": { actionId: "review-learning", deadline: "null", priority: 40, sourceId: "reconfirmation" },
  "learning-review:unavailable": { deadline: "null", priority: 10, sourceId: "reconfirmation" },
  "learning-change:info": { actionId: "open-learning-history", deadline: "null", priority: 60, sourceId: "belief-provenance" },
  "learning-change:unavailable": { deadline: "null", priority: 10, sourceId: ["user-memory", "belief-provenance"] },
  "veto:info": { actionId: "open-vetoes", deadline: "null", priority: 60, sourceId: "vetoes" },
  "veto:unavailable": { deadline: "null", priority: 10, sourceId: "vetoes" }
};

function idMatches(card: Record<string, unknown>): boolean {
  if (!bounded(card.id, 200)) return false;
  if (card.status === "unavailable") return card.id === `source:${String(card.sourceId)}`;
  const prefix: Readonly<Record<Exclude<PersonalStatusCardKind, "runtime-trust">, string>> = {
    "external-approval": "approval:",
    "external-proposal": "proposal:",
    "continuity-feedback": "feedback:",
    "continuity-thread": "thread:",
    "learning-review": "learning-review:",
    "learning-change": "learning:",
    veto: "veto:"
  };
  return card.kind === "runtime-trust" ? card.id === "runtime:resident" : card.id.startsWith(prefix[card.kind as Exclude<PersonalStatusCardKind, "runtime-trust">]) && card.id.length > prefix[card.kind as Exclude<PersonalStatusCardKind, "runtime-trust">].length;
}

function cardRow(value: unknown, generatedAt: string): value is PersonalStatusCard {
  if (!isRecord(value) || !exactKeysWithOptional(value, CARD_KEYS.filter((key) => key !== "action" && key !== "unavailableReason"), ["action", "unavailableReason"]) || !canonicalInstant(value.observedAt) || value.observedAt > generatedAt
    || !bounded(value.title, 160) || !bounded(value.detail, 500, true) || !idMatches(value)) return false;
  const rule = VARIANTS[`${String(value.kind)}:${String(value.status)}`];
  if (!rule || value.priority !== rule.priority || !PERSONAL_STATUS_SOURCE_IDS.includes(value.sourceId as PersonalStatusSourceId)) return false;
  const allowedSources = Array.isArray(rule.sourceId) ? rule.sourceId : [rule.sourceId];
  if (!allowedSources.includes(value.sourceId as PersonalStatusSourceId)) return false;
  if (rule.deadline === "required") {
    if (!canonicalInstant(value.deadline) || value.deadline <= generatedAt) return false;
  } else if (value.deadline !== null) return false;
  const hasAction = value.action !== undefined;
  const hasUnavailable = value.unavailableReason !== undefined;
  if (hasAction === hasUnavailable) return false;
  if (rule.actionId) return hasAction && action(value.action) && value.action.id === rule.actionId;
  return !hasAction && bounded(value.unavailableReason, 500);
}

export function comparePersonalStatusCards(left: PersonalStatusCard, right: PersonalStatusCard): number {
  return left.priority - right.priority
    || (left.deadline === null && right.deadline === null
      ? 0
      : left.deadline === null
        ? 1
        : right.deadline === null
          ? -1
          : left.deadline.localeCompare(right.deadline))
    || right.observedAt.localeCompare(left.observedAt)
    || left.kind.localeCompare(right.kind)
    || left.id.localeCompare(right.id);
}

function expectedOverall(cards: readonly PersonalStatusCard[], sources: readonly PersonalStatusSource[]): PersonalStatusOverall {
  if (!sources.some((source) => source.result === "available")) return "unavailable";
  if (cards.some((card) => card.status === "unavailable" || (card.kind === "runtime-trust" && card.status === "held"))) return "held";
  if (cards.some((card) => card.status === "attention")) return "attention";
  return "clear";
}

export function admitPersonalStatus(input: unknown): PersonalStatusAdmission {
  if (!isRecord(input) || !exactKeys(input, TOP_KEYS) || input.schemaVersion !== PERSONAL_STATUS_SCHEMA_VERSION
    || !canonicalInstant(input.generatedAt) || !Array.isArray(input.cards) || !Array.isArray(input.sources)
    || !["attention", "held", "clear", "unavailable"].includes(String(input.overall))) return { kind: "excluded", reason: "invalid-shape" };
  const generatedAt = input.generatedAt;
  if (!input.sources.every((row) => sourceRow(row, generatedAt))) return { kind: "excluded", reason: "invalid-source" };
  const sources = input.sources as PersonalStatusSource[];
  if (sources.length !== PERSONAL_STATUS_SOURCE_IDS.length
    || sources.some((source, index) => source.id !== PERSONAL_STATUS_SOURCE_IDS[index])) {
    return { kind: "excluded", reason: "invalid-source" };
  }
  if (input.cards.length > PERSONAL_STATUS_MAX_CARDS || !input.cards.every((row) => cardRow(row, generatedAt))) return { kind: "excluded", reason: "invalid-card" };
  const cards = input.cards as PersonalStatusCard[];
  if (new Set(cards.map((card) => card.id)).size !== cards.length
    || sources.some((source) => cards.filter((card) => card.sourceId === source.id).length > PERSONAL_STATUS_MAX_CARDS_PER_SOURCE)
    || cards.some((card, index) => index > 0 && comparePersonalStatusCards(cards[index - 1]!, card) > 0)) return { kind: "excluded", reason: "invalid-order" };
  if (sources.some((source) => {
    const sourceCards = cards.filter((card) => card.sourceId === source.id);
    if (source.result === "available") return source.includedCount !== sourceCards.length;
    return sourceCards.length !== 1
      || sourceCards[0]?.id !== `source:${source.id}`
      || sourceCards[0]?.status !== "unavailable"
      || sourceCards[0]?.action !== undefined;
  })) {
    return { kind: "excluded", reason: "invalid-source" };
  }
  if (input.overall !== expectedOverall(cards, sources)) return { kind: "excluded", reason: "invalid-overall" };
  return { kind: "admitted", status: input as unknown as PersonalStatusResponse };
}

export function buildPersonalStatus(input: {
  readonly generatedAt: string;
  readonly cards: readonly PersonalStatusCard[];
  readonly sources: readonly PersonalStatusSource[];
}): PersonalStatusResponse {
  const deduped = [...new Map(input.cards.map((card) => [card.id, card])).values()]
    .sort(comparePersonalStatusCards);
  const perSource = new Map<PersonalStatusSourceId, number>();
  const cards = deduped.filter((card) => {
    const count = perSource.get(card.sourceId) ?? 0;
    if (count >= PERSONAL_STATUS_MAX_CARDS_PER_SOURCE) return false;
    perSource.set(card.sourceId, count + 1);
    return true;
  }).slice(0, PERSONAL_STATUS_MAX_CARDS);
  const sources = input.sources.map((row): PersonalStatusSource => {
    if (row.result !== "available") return row;
    const includedCount = cards.filter((card) => card.sourceId === row.id).length;
    return {
      ...row,
      excludedCount: row.excludedCount + Math.max(0, row.includedCount - includedCount),
      includedCount
    };
  });
  const status: PersonalStatusResponse = {
    cards,
    generatedAt: input.generatedAt,
    overall: expectedOverall(cards, sources),
    schemaVersion: PERSONAL_STATUS_SCHEMA_VERSION,
    sources
  };
  const admitted = admitPersonalStatus(status);
  if (admitted.kind === "excluded") throw new TypeError(`Invalid personal status: ${admitted.reason}`);
  return admitted.status;
}
