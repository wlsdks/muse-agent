import { canonicalizeImmutableEnvelope } from "./canonical-immutable-envelope.js";

export type SettlementAxis = "depth" | "considered" | "visited" | "assertions" | "token" | "bytes";
export type BudgetReasonId = `budget:${SettlementAxis}`;
export type SkippedReasonId = "skipped:core-not-admitted" | "skipped:after-first-failure" | "skipped:core-only-fallback" | "skipped:abstain-fallback";
export type CandidateSettlementErrorCode = "INVALID_REQUEST" | "INTERNAL_POSTCONDITION_FAILED";
type ErrorReason = "invalid-field-set" | "invalid-container" | "invalid-schema-version" | "invalid-role" | "too-many-optionals" | "duplicate-candidate-id" | "invalid-candidate-id" | "invalid-reason-id" | "invalid-number" | "invalid-rank" | "invalid-preflight-status" | "invalid-rejected-shape" | "unsafe-counter-state" | "invalid-ledger-postcondition";

export class CandidateSettlementError extends Error {
  readonly code: CandidateSettlementErrorCode;
  readonly details: Readonly<{ readonly reason: ErrorReason; readonly path: string }>;
  constructor(reason: ErrorReason, path: string) {
    super(reason);
    this.name = "CandidateSettlementError";
    this.code = reason === "invalid-ledger-postcondition" ? "INTERNAL_POSTCONDITION_FAILED" : "INVALID_REQUEST";
    this.details = Object.freeze({ path, reason });
  }
}

export type SettlementEntry =
  | Readonly<{ candidateId: string; role: "core" | "optional"; terminalState: "admitted" }>
  | Readonly<{ candidateId: string; role: "core" | "optional"; terminalState: "rejected"; reasonId: `semantic:${string}` }>
  | Readonly<{ candidateId: string; role: "core" | "optional"; terminalState: "failed"; reasonId: BudgetReasonId }>
  | Readonly<{ candidateId: string; role: "core" | "optional"; terminalState: "skipped"; reasonId: SkippedReasonId }>;
export interface SettlementCounters { readonly candidateCount: number; readonly admitted: number; readonly rejected: number; readonly failed: number; readonly skipped: number; readonly maxDepth: number; readonly consideredAssertions: number; readonly visitedRefs: number; readonly selectedAssertions: number; readonly selectedPayloadEstimatedTokens: number; readonly selectedPayloadBytes: number; }
export interface NormalLedgerV1 { readonly schemaVersion: 1; readonly ledgerId: string; readonly inventoryId: string; readonly mode: "normal"; readonly counters: SettlementCounters; readonly entries: readonly SettlementEntry[]; readonly firstViolatedAxis?: never; }
export interface CoreOnlyLedgerV1 { readonly schemaVersion: 1; readonly ledgerId: string; readonly inventoryId: string; readonly mode: "core-only"; readonly counters: SettlementCounters; readonly entries: readonly SettlementEntry[]; readonly firstViolatedAxis: "token" | "bytes"; }
export type AbstainLedgerV1 = Readonly<{ schemaVersion: 1; ledgerId: string; inventoryId: string; mode: "abstain"; counters: SettlementCounters; entries: readonly SettlementEntry[]; firstViolatedAxis: SettlementAxis }> | Readonly<{ schemaVersion: 1; ledgerId: string; inventoryId: string; mode: "abstain"; counters: SettlementCounters; entries: readonly SettlementEntry[]; firstViolatedAxis?: never }>;
export type BoundedLedgerV1 = NormalLedgerV1 | CoreOnlyLedgerV1 | AbstainLedgerV1;
export interface BoundedSettlementResult { readonly status: "settled"; readonly ledger: BoundedLedgerV1; readonly canonicalJson: string; readonly canonicalByteLength: number; readonly totalOutputBytes: number; readonly estimatedTokens: number; }
export interface CapacityErrorEnvelopeV1 { readonly schemaVersion: 1; readonly errorId: string; readonly inventoryId: string; readonly mode: "invalid-input"; readonly reasonId: "minimum-abstention-exceeds-budget"; readonly firstViolatedAxis: "token" | "bytes"; readonly minimumRequired: Readonly<{ readonly maxEstimatedTokens: number; readonly maxOutputBytes: number }>; }
export interface CapacitySettlementResult { readonly status: "invalid-input"; readonly error: CapacityErrorEnvelopeV1; readonly canonicalJson: string; readonly canonicalByteLength: number; }
export type CandidateSettlementResult = BoundedSettlementResult | CapacitySettlementResult;

interface Cost { depth: number; consideredAssertions: number; visitedRefs: number; assertions: number; estimatedTokens: number; outputBytes: number; }
interface Candidate { candidateId: string; role: "core" | "optional"; preflight: { status: "eligible" } | { status: "rejected"; reasonId: `semantic:${string}` }; rank: number; cost: Cost; }
interface Budget { maxDepth: number; maxConsideredAssertions: number; maxVisitedRefs: number; maxAssertions: number; maxEstimatedTokens: number; maxOutputBytes: number; }
interface Inventory { inventoryId: string; budget: Budget; core: Candidate; optionals: Candidate[]; }
interface Work { depth: number; considered: number; visited: number; assertions: number; token: number; bytes: number; }
interface Attempt { readonly entry: SettlementEntry; readonly work: Work; readonly axis?: SettlementAxis; }

const INVENTORY_SPEC = Object.freeze({ hashDomain: "attunegraph.candidate-inventory.v1", idField: "inventoryId", idPrefix: "attunegraph-candidate-inventory:sha256:" });
const LEDGER_SPEC = Object.freeze({ hashDomain: "attunegraph.candidate-settlement-ledger.v1", idField: "ledgerId", idPrefix: "attunegraph-candidate-ledger:sha256:" });
const ERROR_SPEC = Object.freeze({ hashDomain: "attunegraph.candidate-settlement-capacity-error.v1", idField: "errorId", idPrefix: "attunegraph-candidate-capacity-error:sha256:" });
const candidateIdPattern = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u;
const reasonIdPattern = /^semantic:[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const maxSafe = Number.MAX_SAFE_INTEGER;

function pointer(base: string, segment: string): string { return `${base}/${segment.replaceAll("~", "~0").replaceAll("/", "~1")}`; }
function fail(reason: ErrorReason, path: string): never { throw new CandidateSettlementError(reason, path); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value: unknown, fields: readonly string[], path: string): Record<string, unknown> { if (!isRecord(value)) fail("invalid-container", path); const keys = Object.keys(value); if (keys.length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) fail("invalid-field-set", path); return value; }
function optionalExact(value: unknown, fields: readonly string[], optional: string, path: string): Record<string, unknown> { if (!isRecord(value)) fail("invalid-container", path); const keys = Object.keys(value); if (keys.length < fields.length || keys.length > fields.length + 1 || fields.some((field) => !Object.hasOwn(value, field)) || (keys.length === fields.length + 1 && !Object.hasOwn(value, optional))) fail("invalid-field-set", path); return value; }
function nonNegative(value: unknown, path: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("invalid-number", path); return value; }
function id(value: unknown, path: string): string { if (typeof value !== "string" || Buffer.byteLength(value, "ascii") !== value.length || value.length < 1 || value.length > 96 || !candidateIdPattern.test(value)) fail("invalid-candidate-id", path); return value; }
function semantic(value: unknown, path: string): `semantic:${string}` { if (typeof value !== "string" || Buffer.byteLength(value, "ascii") !== value.length || value.length > 80 || !reasonIdPattern.test(value)) fail("invalid-reason-id", path); return value as `semantic:${string}`; }
function zero(cost: Cost): boolean { return cost.depth === 0 && cost.consideredAssertions === 0 && cost.visitedRefs === 0 && cost.assertions === 0 && cost.estimatedTokens === 0 && cost.outputBytes === 0; }

function candidate(value: unknown, role: "core" | "optional", path: string): Candidate {
  const record = exact(value, ["candidateId", "role", "preflight", "rank", "cost"], path);
  if (record.role !== role) fail("invalid-role", pointer(path, "role"));
  const candidateId = id(record.candidateId, pointer(path, "candidateId"));
  const rank = nonNegative(record.rank, pointer(path, "rank"));
  const ppath = pointer(path, "preflight");
  const preflight = record.preflight;
  if (!isRecord(preflight)) fail("invalid-container", ppath);
  const preflightKeys = Object.keys(preflight);
  const hasStatusOnly = preflightKeys.length === 1 && Object.hasOwn(preflight, "status");
  const hasRejectedShape = preflightKeys.length === 2 && Object.hasOwn(preflight, "status") && Object.hasOwn(preflight, "reasonId");
  if (!hasStatusOnly && !hasRejectedShape) fail("invalid-field-set", ppath);
  let checked: Candidate["preflight"];
  if (preflight.status === "eligible") { if (!hasStatusOnly) fail("invalid-field-set", ppath); checked = { status: "eligible" }; }
  else if (preflight.status === "rejected") { if (!hasRejectedShape) fail("invalid-field-set", ppath); checked = { reasonId: semantic(preflight.reasonId, pointer(ppath, "reasonId")), status: "rejected" }; }
  else { fail("invalid-preflight-status", pointer(ppath, "status")); }
  const cpath = pointer(path, "cost"); const costs = exact(record.cost, ["depth", "consideredAssertions", "visitedRefs", "assertions", "estimatedTokens", "outputBytes"], cpath);
  const cost: Cost = { depth: nonNegative(costs.depth, pointer(cpath, "depth")), consideredAssertions: nonNegative(costs.consideredAssertions, pointer(cpath, "consideredAssertions")), visitedRefs: nonNegative(costs.visitedRefs, pointer(cpath, "visitedRefs")), assertions: nonNegative(costs.assertions, pointer(cpath, "assertions")), estimatedTokens: nonNegative(costs.estimatedTokens, pointer(cpath, "estimatedTokens")), outputBytes: nonNegative(costs.outputBytes, pointer(cpath, "outputBytes")) };
  if ((role === "core" || checked.status === "rejected") && rank !== 0) fail("invalid-rank", pointer(path, "rank"));
  if (checked.status === "rejected" && !zero(cost)) fail("invalid-rejected-shape", cpath);
  return { candidateId, cost, preflight: checked, rank, role };
}

function inventory(request: unknown): Inventory {
  const snap = canonicalizeImmutableEnvelope(request, "external-mutable", INVENTORY_SPEC).envelope;
  const root = optionalExact(snap, ["schemaVersion", "budget", "core", "optionals"], "inventoryId", "");
  if (root.schemaVersion !== 1) fail("invalid-schema-version", "/schemaVersion");
  const b = exact(root.budget, ["maxDepth", "maxConsideredAssertions", "maxVisitedRefs", "maxAssertions", "maxEstimatedTokens", "maxOutputBytes"], "/budget");
  const budget: Budget = { maxDepth: nonNegative(b.maxDepth, "/budget/maxDepth"), maxConsideredAssertions: nonNegative(b.maxConsideredAssertions, "/budget/maxConsideredAssertions"), maxVisitedRefs: nonNegative(b.maxVisitedRefs, "/budget/maxVisitedRefs"), maxAssertions: nonNegative(b.maxAssertions, "/budget/maxAssertions"), maxEstimatedTokens: nonNegative(b.maxEstimatedTokens, "/budget/maxEstimatedTokens"), maxOutputBytes: nonNegative(b.maxOutputBytes, "/budget/maxOutputBytes") };
  const core = candidate(root.core, "core", "/core");
  if (!Array.isArray(root.optionals)) fail("invalid-container", "/optionals");
  if (root.optionals.length > 255) fail("too-many-optionals", "/optionals");
  const optionals: Candidate[] = []; const seen = new Set<string>([core.candidateId]);
  for (let index = 0; index < root.optionals.length; index += 1) { const value = candidate(root.optionals[index], "optional", `/optionals/${index}`); if (seen.has(value.candidateId)) fail("duplicate-candidate-id", `/optionals/${index}/candidateId`); seen.add(value.candidateId); optionals.push(value); }
  if (typeof root.inventoryId !== "string") fail("invalid-ledger-postcondition", "");
  return { budget, core, inventoryId: root.inventoryId, optionals };
}

function add(left: number, right: number): number | undefined { return left > maxSafe - right ? undefined : left + right; }
function frozenRecord<T extends Record<string, unknown>>(value: T): Readonly<T> { return Object.freeze(Object.assign(Object.create(null) as Record<string, unknown>, value)) as Readonly<T>; }
function initial(): Work { return { assertions: 0, bytes: 0, considered: 0, depth: 0, token: 0, visited: 0 }; }
function attempted(q: Candidate, current: Work, budget: Budget): Attempt {
  const failed = (axis: SettlementAxis, work: Work): Attempt => ({ axis, entry: Object.freeze({ candidateId: q.candidateId, reasonId: `budget:${axis}` as BudgetReasonId, role: q.role, terminalState: "failed" }), work });
  const depth = Math.max(current.depth, q.cost.depth); if (depth > budget.maxDepth) return failed("depth", current);
  const considered = add(current.considered, q.cost.consideredAssertions); if (considered === undefined || considered > budget.maxConsideredAssertions) return failed("considered", current);
  const cwork = { ...current, considered };
  const visited = add(current.visited, q.cost.visitedRefs); if (visited === undefined || visited > budget.maxVisitedRefs) return failed("visited", cwork);
  const vwork = { ...cwork, visited };
  const assertions = add(current.assertions, q.cost.assertions); if (assertions === undefined || assertions > budget.maxAssertions) return failed("assertions", vwork);
  const token = add(current.token, q.cost.estimatedTokens); if (token === undefined || token > budget.maxEstimatedTokens) return failed("token", vwork);
  const bytes = add(current.bytes, q.cost.outputBytes); if (bytes === undefined || bytes > budget.maxOutputBytes) return failed("bytes", vwork);
  return { entry: Object.freeze({ candidateId: q.candidateId, role: q.role, terminalState: "admitted" }), work: { assertions, bytes, considered, depth, token, visited } };
}
function entry(q: Candidate, terminalState: "rejected" | "skipped", reasonId: `semantic:${string}` | SkippedReasonId): SettlementEntry { return Object.freeze({ candidateId: q.candidateId, reasonId, role: q.role, terminalState } as SettlementEntry); }
function counters(entries: readonly SettlementEntry[], work: Work): SettlementCounters { const output = { admitted: 0, candidateCount: entries.length, failed: 0, maxDepth: work.depth, rejected: 0, selectedAssertions: work.assertions, selectedPayloadBytes: work.bytes, selectedPayloadEstimatedTokens: work.token, skipped: 0, consideredAssertions: work.considered, visitedRefs: work.visited }; for (const item of entries) output[item.terminalState] += 1; if (output.candidateCount !== output.admitted + output.rejected + output.failed + output.skipped || Object.values(output).some((value) => !Number.isSafeInteger(value) || value < 0)) fail("unsafe-counter-state", ""); return Object.freeze(output); }
function ordered(core: SettlementEntry, optionals: readonly SettlementEntry[]): SettlementEntry[] { return [core, ...[...optionals].sort((left, right) => left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0)]; }

function envelope(mode: "normal" | "core-only" | "abstain", inventoryId: string, entries: readonly SettlementEntry[], work: Work, axis?: SettlementAxis): { ledger: BoundedLedgerV1; canonicalJson: string; canonicalByteLength: number } {
  const body: Record<string, unknown> = { counters: { ...counters(entries, work) }, entries: entries.map((item) => ({ ...item })), inventoryId, mode, schemaVersion: 1 };
  if (axis !== undefined) body.firstViolatedAxis = axis;
  const result = canonicalizeImmutableEnvelope(body, "external-mutable", LEDGER_SPEC);
  const ledger = result.envelope as unknown as BoundedLedgerV1;
  if (!Object.isFrozen(ledger) || !Array.isArray(ledger.entries) || ledger.entries.length !== entries.length) fail("invalid-ledger-postcondition", "");
  return { canonicalByteLength: result.canonicalByteLength, canonicalJson: result.canonicalJson, ledger };
}
function fits(size: number, work: Work, budget: Budget): "token" | "bytes" | undefined { const token = add(Math.ceil(size / 4), work.token); if (token === undefined || token > budget.maxEstimatedTokens) return "token"; const bytes = add(size, work.bytes); return bytes === undefined || bytes > budget.maxOutputBytes ? "bytes" : undefined; }
function settled(value: ReturnType<typeof envelope>, budget: Budget): BoundedSettlementResult | undefined { const work = { assertions: value.ledger.counters.selectedAssertions, bytes: value.ledger.counters.selectedPayloadBytes, considered: value.ledger.counters.consideredAssertions, depth: value.ledger.counters.maxDepth, token: value.ledger.counters.selectedPayloadEstimatedTokens, visited: value.ledger.counters.visitedRefs }; if (fits(value.canonicalByteLength, work, budget) !== undefined) return undefined; const totalOutputBytes = add(value.canonicalByteLength, work.bytes); const estimatedTokens = add(Math.ceil(value.canonicalByteLength / 4), work.token); if (totalOutputBytes === undefined || estimatedTokens === undefined) fail("invalid-ledger-postcondition", ""); return frozenRecord({ canonicalByteLength: value.canonicalByteLength, canonicalJson: value.canonicalJson, estimatedTokens, ledger: value.ledger, status: "settled" as const, totalOutputBytes }) as BoundedSettlementResult; }
function abstain(inv: Inventory, core: SettlementEntry, optionalReason: SkippedReasonId, axis?: SettlementAxis, work: Work = initial()): ReturnType<typeof envelope> { const optional = inv.optionals.map((q) => q.preflight.status === "rejected" ? entry(q, "rejected", q.preflight.reasonId) : entry(q, "skipped", optionalReason)); return envelope("abstain", inv.inventoryId, ordered(core, optional), work, axis); }
function invalid(inv: Inventory, abstention: ReturnType<typeof envelope>): CapacitySettlementResult { const zeroWork = initial(); const axis = fits(abstention.canonicalByteLength, zeroWork, inv.budget); if (axis !== "token" && axis !== "bytes") fail("invalid-ledger-postcondition", ""); const body = { firstViolatedAxis: axis, inventoryId: inv.inventoryId, minimumRequired: { maxEstimatedTokens: Math.ceil(abstention.canonicalByteLength / 4), maxOutputBytes: abstention.canonicalByteLength }, mode: "invalid-input" as const, reasonId: "minimum-abstention-exceeds-budget" as const, schemaVersion: 1 }; const output = canonicalizeImmutableEnvelope(body, "external-mutable", ERROR_SPEC); return frozenRecord({ canonicalByteLength: output.canonicalByteLength, canonicalJson: output.canonicalJson, error: output.envelope as unknown as CapacityErrorEnvelopeV1, status: "invalid-input" as const }) as CapacitySettlementResult; }

function post(condition: boolean): void { if (!condition) fail("invalid-ledger-postcondition", ""); }
function postExact(value: unknown, fields: readonly string[]): Record<string, unknown> { post(isRecord(value)); const record = value as Record<string, unknown>; const keys = Object.keys(record); post(keys.length === fields.length && fields.every((field) => Object.hasOwn(record, field))); return record; }
function postNumber(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function postFrozen(value: unknown): void { if (value === null || typeof value !== "object") return; const array = Array.isArray(value); post(Object.getPrototypeOf(value) === (array ? Array.prototype : null) && Object.isFrozen(value)); const ownKeys = Reflect.ownKeys(value); if (array) post(ownKeys.length === value.length + 1 && ownKeys.includes("length")); for (const rawKey of ownKeys) { if (typeof rawKey !== "string") fail("invalid-ledger-postcondition", ""); const key = rawKey; if (array && key !== "length") post(/^(?:0|[1-9][0-9]*)$/u.test(key) && Number(key) < value.length); const descriptor = Object.getOwnPropertyDescriptor(value, key); if (descriptor === undefined || !("value" in descriptor) || descriptor.configurable !== false || descriptor.writable !== false) fail("invalid-ledger-postcondition", ""); if (key !== "length") postFrozen(descriptor.value); } }
function postEntry(value: unknown, candidates: ReadonlyMap<string, Candidate>, ids: Set<string>): SettlementEntry { post(isRecord(value)); const raw = value as Record<string, unknown>; const terminalState = raw.terminalState; post(terminalState === "admitted" || terminalState === "rejected" || terminalState === "failed" || terminalState === "skipped"); const entry = postExact(value, terminalState === "admitted" ? ["candidateId", "role", "terminalState"] : ["candidateId", "role", "terminalState", "reasonId"]); post(typeof entry.candidateId === "string" && ids.delete(entry.candidateId)); const candidateValue = candidates.get(entry.candidateId as string); if (candidateValue === undefined) fail("invalid-ledger-postcondition", ""); post(entry.role === candidateValue.role); if (terminalState === "admitted") { post(candidateValue.preflight.status === "eligible"); return entry as SettlementEntry; } post(typeof entry.reasonId === "string"); if (terminalState === "rejected") post(candidateValue.preflight.status === "rejected" && entry.reasonId === candidateValue.preflight.reasonId); if (terminalState === "failed") post(candidateValue.preflight.status === "eligible" && ([`budget:depth`, `budget:considered`, `budget:visited`, `budget:assertions`, `budget:token`, `budget:bytes`] as readonly string[]).includes(entry.reasonId as string)); if (terminalState === "skipped") post(candidateValue.preflight.status === "eligible" && (["skipped:core-not-admitted", "skipped:after-first-failure", "skipped:core-only-fallback", "skipped:abstain-fallback"] as readonly string[]).includes(entry.reasonId as string)); return entry as SettlementEntry; }
function postCounters(value: unknown, entries: readonly SettlementEntry[]): SettlementCounters { const counters = postExact(value, ["candidateCount", "admitted", "rejected", "failed", "skipped", "maxDepth", "consideredAssertions", "visitedRefs", "selectedAssertions", "selectedPayloadEstimatedTokens", "selectedPayloadBytes"]); for (const field of Object.keys(counters)) post(postNumber(counters[field])); const typed = counters as unknown as SettlementCounters; const totals = { admitted: 0, rejected: 0, failed: 0, skipped: 0 }; for (const item of entries) totals[item.terminalState] += 1; post(typed.candidateCount === entries.length && typed.admitted === totals.admitted && typed.rejected === totals.rejected && typed.failed === totals.failed && typed.skipped === totals.skipped); return typed; }
function postCanonical(envelopeValue: unknown, spec: typeof LEDGER_SPEC | typeof ERROR_SPEC, canonicalJson: string, canonicalByteLength: number, field: "ledgerId" | "errorId"): void { const verified = canonicalizeImmutableEnvelope(envelopeValue, "attunegraph-frozen", spec); post(verified.canonicalJson === canonicalJson && verified.canonicalByteLength === canonicalByteLength && (envelopeValue as Record<string, unknown>)[field] === verified.contentId); }
function postWork(entries: readonly SettlementEntry[], inv: Inventory, mode: BoundedLedgerV1["mode"]): Work {
  if (mode === "core-only") return attempted(inv.core, initial(), inv.budget).work;
  if (mode === "abstain") {
    const coreEntry = entries[0];
    if (coreEntry?.terminalState === "failed") return attempted(inv.core, initial(), inv.budget).work;
    return initial();
  }
  let work = initial();
  const byId = new Map(entries.map((item) => [item.candidateId, item]));
  for (const candidateValue of [inv.core, ...inv.optionals.filter((item) => item.preflight.status === "eligible").sort((left, right) => left.rank - right.rank || (left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0))]) {
    const ledgerEntry = byId.get(candidateValue.candidateId);
    if (ledgerEntry?.terminalState === "admitted" || ledgerEntry?.terminalState === "failed") work = attempted(candidateValue, work, inv.budget).work;
    if (ledgerEntry?.terminalState === "failed") break;
  }
  return work;
}
function postMode(entries: readonly SettlementEntry[], mode: BoundedLedgerV1["mode"], hasAxis: boolean, inv: Inventory): void {
  const coreEntry = entries[0]; if (coreEntry === undefined) fail("invalid-ledger-postcondition", ""); post(coreEntry.role === "core");
  const optionalEntries = entries.slice(1);
  post(optionalEntries.every((item, index) => index === 0 || optionalEntries[index - 1]!.candidateId < item.candidateId));
  if (mode === "normal") {
    post(!hasAxis && coreEntry.terminalState === "admitted");
    let failed = false;
    const byId = new Map(entries.map((item) => [item.candidateId, item]));
    for (const candidateValue of inv.optionals.filter((item) => item.preflight.status === "eligible").sort((left, right) => left.rank - right.rank || (left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0))) {
      const item = byId.get(candidateValue.candidateId); if (item === undefined) fail("invalid-ledger-postcondition", "");
      if (failed) post(item.terminalState === "skipped" && item.reasonId === "skipped:after-first-failure");
      else if (item.terminalState === "failed") failed = true;
      else post(item.terminalState === "admitted");
    }
    return;
  }
  if (mode === "core-only") {
    post(hasAxis && coreEntry.terminalState === "admitted");
    for (const item of optionalEntries) post(item.terminalState === "rejected" || (item.terminalState === "skipped" && item.reasonId === "skipped:core-only-fallback"));
    return;
  }
  if (coreEntry.terminalState === "rejected") {
    post(!hasAxis && inv.core.preflight.status === "rejected");
    for (const item of optionalEntries) post(item.terminalState === "rejected" || (item.terminalState === "skipped" && item.reasonId === "skipped:core-not-admitted"));
  } else if (coreEntry.terminalState === "failed") {
    post(hasAxis && inv.core.preflight.status === "eligible");
    for (const item of optionalEntries) post(item.terminalState === "rejected" || (item.terminalState === "skipped" && item.reasonId === "skipped:after-first-failure"));
  } else {
    post(hasAxis && coreEntry.terminalState === "skipped" && coreEntry.reasonId === "skipped:abstain-fallback");
    for (const item of optionalEntries) post(item.terminalState === "rejected" || (item.terminalState === "skipped" && item.reasonId === "skipped:abstain-fallback"));
  }
}
function postMinimumAbstention(inv: Inventory, axis: "token" | "bytes"): ReturnType<typeof envelope> {
  if (inv.core.preflight.status === "rejected") return abstain(inv, entry(inv.core, "rejected", inv.core.preflight.reasonId), "skipped:core-not-admitted");
  const coreAttempt = attempted(inv.core, initial(), inv.budget);
  if (coreAttempt.axis !== undefined) return abstain(inv, coreAttempt.entry, "skipped:after-first-failure", coreAttempt.axis, coreAttempt.work);
  return abstain(inv, entry(inv.core, "skipped", "skipped:abstain-fallback"), "skipped:abstain-fallback", axis);
}
function postResult(result: CandidateSettlementResult, inv: Inventory): CandidateSettlementResult {
  postFrozen(result);
  if (result.status === "settled") {
    const wrapper = postExact(result, ["status", "ledger", "canonicalJson", "canonicalByteLength", "totalOutputBytes", "estimatedTokens"]); post(typeof wrapper.canonicalJson === "string" && postNumber(wrapper.canonicalByteLength) && postNumber(wrapper.totalOutputBytes) && postNumber(wrapper.estimatedTokens));
    post(isRecord(wrapper.ledger)); const rawLedger = wrapper.ledger as Record<string, unknown>; const rawMode = rawLedger.mode; post(rawMode === "normal" || rawMode === "core-only" || rawMode === "abstain"); const mode = rawMode as BoundedLedgerV1["mode"]; const ledger = postExact(wrapper.ledger, mode === "normal" ? ["schemaVersion", "ledgerId", "inventoryId", "mode", "counters", "entries"] : mode === "core-only" ? ["schemaVersion", "ledgerId", "inventoryId", "mode", "counters", "entries", "firstViolatedAxis"] : Object.hasOwn(rawLedger, "firstViolatedAxis") ? ["schemaVersion", "ledgerId", "inventoryId", "mode", "counters", "entries", "firstViolatedAxis"] : ["schemaVersion", "ledgerId", "inventoryId", "mode", "counters", "entries"]); post(ledger.schemaVersion === 1 && ledger.inventoryId === inv.inventoryId && typeof ledger.ledgerId === "string" && Array.isArray(ledger.entries));
    const hasAxis = Object.hasOwn(ledger, "firstViolatedAxis"); if (mode === "core-only") post(hasAxis && (ledger.firstViolatedAxis === "token" || ledger.firstViolatedAxis === "bytes")); if (mode === "abstain" && hasAxis) post((["depth", "considered", "visited", "assertions", "token", "bytes"] as readonly unknown[]).includes(ledger.firstViolatedAxis));
    const candidateValues = [inv.core, ...inv.optionals]; const candidates = new Map(candidateValues.map((item) => [item.candidateId, item])); const ids = new Set<string>(candidates.keys()); const entries = (ledger.entries as unknown[]).map((item) => postEntry(item, candidates, ids)); post(ids.size === 0 && entries[0]?.candidateId === inv.core.candidateId); const typedCounters = postCounters(ledger.counters, entries); postMode(entries, mode, hasAxis, inv); const expectedWork = postWork(entries, inv, mode); post(typedCounters.maxDepth === expectedWork.depth && typedCounters.consideredAssertions === expectedWork.considered && typedCounters.visitedRefs === expectedWork.visited && typedCounters.selectedAssertions === expectedWork.assertions && typedCounters.selectedPayloadEstimatedTokens === expectedWork.token && typedCounters.selectedPayloadBytes === expectedWork.bytes); postCanonical(ledger, LEDGER_SPEC, wrapper.canonicalJson as string, wrapper.canonicalByteLength as number, "ledgerId"); const totalOutputBytes = add(wrapper.canonicalByteLength as number, typedCounters.selectedPayloadBytes); const estimatedTokens = add(Math.ceil((wrapper.canonicalByteLength as number) / 4), typedCounters.selectedPayloadEstimatedTokens); post(totalOutputBytes !== undefined && estimatedTokens !== undefined && wrapper.totalOutputBytes === totalOutputBytes && wrapper.estimatedTokens === estimatedTokens && fits(wrapper.canonicalByteLength as number, expectedWork, inv.budget) === undefined); return result;
  }
  const wrapper = postExact(result, ["status", "error", "canonicalJson", "canonicalByteLength"]); post(typeof wrapper.canonicalJson === "string" && postNumber(wrapper.canonicalByteLength)); const error = postExact(wrapper.error, ["schemaVersion", "errorId", "inventoryId", "mode", "reasonId", "firstViolatedAxis", "minimumRequired"]); post(error.schemaVersion === 1 && typeof error.errorId === "string" && error.inventoryId === inv.inventoryId && error.mode === "invalid-input" && error.reasonId === "minimum-abstention-exceeds-budget" && (error.firstViolatedAxis === "token" || error.firstViolatedAxis === "bytes")); const axis = error.firstViolatedAxis as "token" | "bytes"; const minimum = postExact(error.minimumRequired, ["maxEstimatedTokens", "maxOutputBytes"]); const abstention = postMinimumAbstention(inv, axis); post(postNumber(minimum.maxEstimatedTokens) && postNumber(minimum.maxOutputBytes) && minimum.maxOutputBytes === abstention.canonicalByteLength && minimum.maxEstimatedTokens === Math.ceil(abstention.canonicalByteLength / 4) && fits(abstention.canonicalByteLength, initial(), inv.budget) === axis); postCanonical(error, ERROR_SPEC, wrapper.canonicalJson as string, wrapper.canonicalByteLength as number, "errorId"); return result;
}

export function settleCandidateInventory(request: unknown): CandidateSettlementResult {
  const inv = inventory(request);
  if (inv.core.preflight.status === "rejected") { const selected = abstain(inv, entry(inv.core, "rejected", inv.core.preflight.reasonId), "skipped:core-not-admitted"); return postResult(settled(selected, inv.budget) ?? invalid(inv, selected), inv); }
  const coreAttempt = attempted(inv.core, initial(), inv.budget);
  if (coreAttempt.axis !== undefined) { const selected = abstain(inv, coreAttempt.entry, "skipped:after-first-failure", coreAttempt.axis, coreAttempt.work); return postResult(settled(selected, inv.budget) ?? invalid(inv, selected), inv); }
  const optionals: SettlementEntry[] = inv.optionals.filter((q) => q.preflight.status === "rejected").map((q) => entry(q, "rejected", (q.preflight as { reasonId: `semantic:${string}` }).reasonId));
  const eligible = inv.optionals.filter((q) => q.preflight.status === "eligible").sort((left, right) => left.rank - right.rank || (left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0));
  let work = coreAttempt.work; let stopped = false;
  for (const q of eligible) { if (stopped) { optionals.push(entry(q, "skipped", "skipped:after-first-failure")); continue; } const next = attempted(q, work, inv.budget); optionals.push(next.entry); work = next.work; if (next.axis !== undefined) stopped = true; }
  const normal = envelope("normal", inv.inventoryId, ordered(coreAttempt.entry, optionals), work);
  const normalResult = settled(normal, inv.budget); if (normalResult !== undefined) return postResult(normalResult, inv);
  const normalAxis = fits(normal.canonicalByteLength, work, inv.budget); if (normalAxis !== "token" && normalAxis !== "bytes") fail("invalid-ledger-postcondition", "");
  const coreOnlyOptionals = inv.optionals.map((q) => q.preflight.status === "rejected" ? entry(q, "rejected", q.preflight.reasonId) : entry(q, "skipped", "skipped:core-only-fallback"));
  const coreOnly = envelope("core-only", inv.inventoryId, ordered(coreAttempt.entry, coreOnlyOptionals), coreAttempt.work, normalAxis);
  const coreOnlyResult = settled(coreOnly, inv.budget); if (coreOnlyResult !== undefined) return postResult(coreOnlyResult, inv);
  const fallback = abstain(inv, entry(inv.core, "skipped", "skipped:abstain-fallback"), "skipped:abstain-fallback", normalAxis);
  return postResult(settled(fallback, inv.budget) ?? invalid(inv, fallback), inv);
}
