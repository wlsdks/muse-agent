import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CandidateSettlementError, settleCandidateInventory } from "./candidate-settlement-ledger.js";

type Axis = "depth" | "considered" | "visited" | "assertions" | "token" | "bytes";
type Cost = { depth: number; consideredAssertions: number; visitedRefs: number; assertions: number; estimatedTokens: number; outputBytes: number };
type Candidate = { candidateId: string; role: "core" | "optional"; preflight: { status: "eligible" } | { status: "rejected"; reasonId: string }; rank: number; cost: Cost };
type Request = { schemaVersion: number; budget: { maxDepth: number; maxConsideredAssertions: number; maxVisitedRefs: number; maxAssertions: number; maxEstimatedTokens: number; maxOutputBytes: number }; core: Candidate; optionals: Candidate[] };

const zeroCost = (): Cost => ({ assertions: 0, consideredAssertions: 0, depth: 0, estimatedTokens: 0, outputBytes: 0, visitedRefs: 0 });
const eligible = (candidateId: string, role: "core" | "optional", rank = 0, cost: Partial<Cost> = {}): Candidate => ({ candidateId, cost: { ...zeroCost(), ...cost }, preflight: { status: "eligible" }, rank, role });
const rejected = (candidateId: string, role: "core" | "optional", reasonId = "semantic:blocked"): Candidate => ({ candidateId, cost: zeroCost(), preflight: { reasonId, status: "rejected" }, rank: 0, role });
const makeRequest = (optionals: Candidate[] = [], core = eligible("core", "core"), overrides: Partial<Request["budget"]> = {}): Request => ({
  budget: { maxAssertions: 100_000, maxConsideredAssertions: 100_000, maxDepth: 100_000, maxEstimatedTokens: 100_000, maxOutputBytes: 100_000, maxVisitedRefs: 100_000, ...overrides },
  core,
  optionals,
  schemaVersion: 1,
});

function settled(request: unknown) {
  const result = settleCandidateInventory(request);
  expect(result.status).toBe("settled");
  if (result.status !== "settled") throw new Error("expected settled result");
  return result;
}

function expectPrivateError(request: unknown, reason: CandidateSettlementError["details"]["reason"], path: string): void {
  try {
    settleCandidateInventory(request);
    throw new Error("expected CandidateSettlementError");
  } catch (error) {
    expect(error).toBeInstanceOf(CandidateSettlementError);
    const typed = error as CandidateSettlementError;
    expect(typed.name).toBe("CandidateSettlementError");
    expect(typed.code).toBe(reason === "invalid-ledger-postcondition" ? "INTERNAL_POSTCONDITION_FAILED" : "INVALID_REQUEST");
    expect(typed.details).toEqual({ path, reason });
    expect(Object.isFrozen(typed.details)).toBe(true);
  }
}

function expectDeepFrozen(value: unknown, seen = new Set<unknown>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) expectDeepFrozen((value as Record<PropertyKey, unknown>)[key], seen);
}

const oracleGates = [
  { axis: "depth", budget: "maxDepth", cost: "depth", work: "depth", combine: "max", retain: [] },
  { axis: "considered", budget: "maxConsideredAssertions", cost: "consideredAssertions", work: "considered", combine: "add", retain: [] },
  { axis: "visited", budget: "maxVisitedRefs", cost: "visitedRefs", work: "visited", combine: "add", retain: ["considered"] },
  { axis: "assertions", budget: "maxAssertions", cost: "assertions", work: "assertions", combine: "add", retain: ["considered", "visited"] },
  { axis: "token", budget: "maxEstimatedTokens", cost: "estimatedTokens", work: "token", combine: "add", retain: ["considered", "visited"] },
  { axis: "bytes", budget: "maxOutputBytes", cost: "outputBytes", work: "bytes", combine: "add", retain: ["considered", "visited"] },
] as const;
type OracleWork = { depth: bigint; considered: bigint; visited: bigint; assertions: bigint; token: bigint; bytes: bigint };
type OracleEntry = { candidateId: string; role: "core" | "optional"; terminalState: "admitted" } | { candidateId: string; role: "core" | "optional"; terminalState: "rejected" | "failed" | "skipped"; reasonId: string };
const oracleInitial = (): OracleWork => ({ assertions: 0n, bytes: 0n, considered: 0n, depth: 0n, token: 0n, visited: 0n });

function oracleAttempt(candidate: Candidate, current: OracleWork, budget: Request["budget"]): { entry: OracleEntry; work: OracleWork; axis?: Axis } {
  const prospective = { ...current };
  for (const gate of oracleGates) {
    const delta = BigInt(candidate.cost[gate.cost]);
    prospective[gate.work] = gate.combine === "max" ? (prospective[gate.work] > delta ? prospective[gate.work] : delta) : prospective[gate.work] + delta;
    if (prospective[gate.work] > BigInt(budget[gate.budget])) {
      const retained = { ...current };
      for (const field of gate.retain) retained[field] = prospective[field];
      return { axis: gate.axis, entry: { candidateId: candidate.candidateId, reasonId: `budget:${gate.axis}`, role: candidate.role, terminalState: "failed" }, work: retained };
    }
  }
  return { entry: { candidateId: candidate.candidateId, role: candidate.role, terminalState: "admitted" }, work: prospective };
}

function oracleSettlement(request: Request): { mode: "normal" | "abstain"; entries: OracleEntry[]; counters: Record<string, number> } {
  const semantic = (candidate: Candidate): OracleEntry => ({ candidateId: candidate.candidateId, reasonId: (candidate.preflight as { reasonId: string }).reasonId, role: candidate.role, terminalState: "rejected" });
  const suffix = (candidate: Candidate): OracleEntry => candidate.preflight.status === "rejected" ? semantic(candidate) : { candidateId: candidate.candidateId, reasonId: "skipped:after-first-failure", role: candidate.role, terminalState: "skipped" };
  let work = oracleInitial();
  let coreEntry: OracleEntry;
  let optionalEntries: OracleEntry[];
  let mode: "normal" | "abstain";
  if (request.core.preflight.status === "rejected") {
    mode = "abstain";
    coreEntry = semantic(request.core);
    optionalEntries = request.optionals.map((candidate) => candidate.preflight.status === "rejected" ? semantic(candidate) : { candidateId: candidate.candidateId, reasonId: "skipped:core-not-admitted", role: candidate.role, terminalState: "skipped" });
  } else {
    const core = oracleAttempt(request.core, work, request.budget);
    coreEntry = core.entry;
    work = core.work;
    if (core.axis !== undefined) {
      mode = "abstain";
      optionalEntries = request.optionals.map(suffix);
    } else {
      mode = "normal";
      optionalEntries = request.optionals.filter((candidate) => candidate.preflight.status === "rejected").map(semantic);
      const ranked = request.optionals.filter((candidate) => candidate.preflight.status === "eligible").sort((left, right) => left.rank - right.rank || (left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0));
      let failed = false;
      for (const candidate of ranked) {
        if (failed) optionalEntries.push({ candidateId: candidate.candidateId, reasonId: "skipped:after-first-failure", role: candidate.role, terminalState: "skipped" });
        else {
          const attempt = oracleAttempt(candidate, work, request.budget);
          optionalEntries.push(attempt.entry);
          work = attempt.work;
          failed = attempt.axis !== undefined;
        }
      }
    }
  }
  const entries = [coreEntry, ...optionalEntries.sort((left, right) => left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0)];
  const counts = { admitted: 0, failed: 0, rejected: 0, skipped: 0 };
  for (const entry of entries) counts[entry.terminalState] += 1;
  return {
    counters: {
      ...counts,
      candidateCount: entries.length,
      consideredAssertions: Number(work.considered),
      maxDepth: Number(work.depth),
      selectedAssertions: Number(work.assertions),
      selectedPayloadBytes: Number(work.bytes),
      selectedPayloadEstimatedTokens: Number(work.token),
      visitedRefs: Number(work.visited),
    },
    entries,
    mode,
  };
}

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length === 0) return [[]];
  return values.flatMap((value, index) => permutations([...values.slice(0, index), ...values.slice(index + 1)]).map((tail) => [value, ...tail]));
}

function ownDeepKeys(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];
  return Reflect.ownKeys(value).flatMap((key) => [String(key), ...ownDeepKeys((value as Record<PropertyKey, unknown>)[key])]);
}

function expectLiteralEnvelope(canonicalJson: string, domain: string, idField: "inventoryId" | "ledgerId" | "errorId", prefix: string): Record<string, unknown> {
  expect(Buffer.byteLength(canonicalJson)).toBe(canonicalJson.length);
  const envelope = JSON.parse(canonicalJson) as Record<string, unknown>;
  const contentId = envelope[idField];
  expect(typeof contentId).toBe("string");
  delete envelope[idField];
  const digest = createHash("sha256").update(`${domain}\0${JSON.stringify(envelope)}`).digest("hex");
  expect(contentId).toBe(`${prefix}${digest}`);
  return JSON.parse(canonicalJson) as Record<string, unknown>;
}

const baseInventoryIds = {
  "9": "attunegraph-candidate-inventory:sha256:5f07c296d0eb9c22e98422dcbcc6a856729109fd3b2c4a4095ab64c3ad10aab6",
  "10": "attunegraph-candidate-inventory:sha256:d821e45bdd7c886a6be73eb2a087bbf88cc1600c7e187df5d46db91e4ec0444b",
  "99": "attunegraph-candidate-inventory:sha256:9b4c673ac5a1e64f8319b1f8c1d85367bd57336bf2fcc6e295682fe01316294e",
  "100": "attunegraph-candidate-inventory:sha256:72b5f74c65985873714819006c1236bb5a860378ce23c3309d451259befbc528"
} as const;
const baseLedgerGoldens = {
  "9": {
    "bytes": 563,
    "id": "attunegraph-candidate-ledger:sha256:19c03509df9fc34aae8f7b0f980e25416a3488a2fc7fef057d0e61c2fc6a7a87"
  },
  "10": {
    "bytes": 564,
    "id": "attunegraph-candidate-ledger:sha256:97576f97583da8a67af7c3b81b7b4dc506310016f479ce19afeb56f8a083dc88"
  },
  "99": {
    "bytes": 564,
    "id": "attunegraph-candidate-ledger:sha256:ecefd36645e1a29bd2b67008da1254b810c5570c6c715e7c69ecdcfbc655ab79"
  },
  "100": {
    "bytes": 565,
    "id": "attunegraph-candidate-ledger:sha256:45f9f038e706108bd07e15080e92bd8da6e3e5e8f2f7cfea6c450b84e481c483"
  }
} as const;
const baseInventoryCanonicalJson = {
  "9": "{\"budget\":{\"maxAssertions\":0,\"maxConsideredAssertions\":1000,\"maxDepth\":0,\"maxEstimatedTokens\":1000000,\"maxOutputBytes\":1000000,\"maxVisitedRefs\":0},\"core\":{\"candidateId\":\"core\",\"cost\":{\"assertions\":0,\"consideredAssertions\":9,\"depth\":0,\"estimatedTokens\":0,\"outputBytes\":0,\"visitedRefs\":0},\"preflight\":{\"status\":\"eligible\"},\"rank\":0,\"role\":\"core\"},\"inventoryId\":\"attunegraph-candidate-inventory:sha256:5f07c296d0eb9c22e98422dcbcc6a856729109fd3b2c4a4095ab64c3ad10aab6\",\"optionals\":[],\"schemaVersion\":1}",
  "10": "{\"budget\":{\"maxAssertions\":0,\"maxConsideredAssertions\":1000,\"maxDepth\":0,\"maxEstimatedTokens\":1000000,\"maxOutputBytes\":1000000,\"maxVisitedRefs\":0},\"core\":{\"candidateId\":\"core\",\"cost\":{\"assertions\":0,\"consideredAssertions\":10,\"depth\":0,\"estimatedTokens\":0,\"outputBytes\":0,\"visitedRefs\":0},\"preflight\":{\"status\":\"eligible\"},\"rank\":0,\"role\":\"core\"},\"inventoryId\":\"attunegraph-candidate-inventory:sha256:d821e45bdd7c886a6be73eb2a087bbf88cc1600c7e187df5d46db91e4ec0444b\",\"optionals\":[],\"schemaVersion\":1}",
  "99": "{\"budget\":{\"maxAssertions\":0,\"maxConsideredAssertions\":1000,\"maxDepth\":0,\"maxEstimatedTokens\":1000000,\"maxOutputBytes\":1000000,\"maxVisitedRefs\":0},\"core\":{\"candidateId\":\"core\",\"cost\":{\"assertions\":0,\"consideredAssertions\":99,\"depth\":0,\"estimatedTokens\":0,\"outputBytes\":0,\"visitedRefs\":0},\"preflight\":{\"status\":\"eligible\"},\"rank\":0,\"role\":\"core\"},\"inventoryId\":\"attunegraph-candidate-inventory:sha256:9b4c673ac5a1e64f8319b1f8c1d85367bd57336bf2fcc6e295682fe01316294e\",\"optionals\":[],\"schemaVersion\":1}",
  "100": "{\"budget\":{\"maxAssertions\":0,\"maxConsideredAssertions\":1000,\"maxDepth\":0,\"maxEstimatedTokens\":1000000,\"maxOutputBytes\":1000000,\"maxVisitedRefs\":0},\"core\":{\"candidateId\":\"core\",\"cost\":{\"assertions\":0,\"consideredAssertions\":100,\"depth\":0,\"estimatedTokens\":0,\"outputBytes\":0,\"visitedRefs\":0},\"preflight\":{\"status\":\"eligible\"},\"rank\":0,\"role\":\"core\"},\"inventoryId\":\"attunegraph-candidate-inventory:sha256:72b5f74c65985873714819006c1236bb5a860378ce23c3309d451259befbc528\",\"optionals\":[],\"schemaVersion\":1}"
} as const;
const baseLedgerCanonicalJson = {
  "9": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":9,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:5f07c296d0eb9c22e98422dcbcc6a856729109fd3b2c4a4095ab64c3ad10aab6\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:19c03509df9fc34aae8f7b0f980e25416a3488a2fc7fef057d0e61c2fc6a7a87\",\"mode\":\"normal\",\"schemaVersion\":1}",
  "10": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":10,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:d821e45bdd7c886a6be73eb2a087bbf88cc1600c7e187df5d46db91e4ec0444b\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:97576f97583da8a67af7c3b81b7b4dc506310016f479ce19afeb56f8a083dc88\",\"mode\":\"normal\",\"schemaVersion\":1}",
  "99": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":99,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:9b4c673ac5a1e64f8319b1f8c1d85367bd57336bf2fcc6e295682fe01316294e\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:ecefd36645e1a29bd2b67008da1254b810c5570c6c715e7c69ecdcfbc655ab79\",\"mode\":\"normal\",\"schemaVersion\":1}",
  "100": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":100,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:72b5f74c65985873714819006c1236bb5a860378ce23c3309d451259befbc528\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:45f9f038e706108bd07e15080e92bd8da6e3e5e8f2f7cfea6c450b84e481c483\",\"mode\":\"normal\",\"schemaVersion\":1}"
} as const;
const capacityGoldenIds = {
  "9": {
    "bytes-under": [
      "invalid-input",
      "attunegraph-candidate-capacity-error:sha256:d102084eca6e161ce2074bc8adea084e991ce733138f5c972b88418ccdc260c7",
      424
    ],
    "bytes-exact": [
      "normal",
      "attunegraph-candidate-ledger:sha256:f0b8f9e41ad9a0ae3fa5c6f58c2e9de14bf2f09341e2bb0e29e511d20baac009",
      563
    ],
    "bytes-over": [
      "normal",
      "attunegraph-candidate-ledger:sha256:d45c42aeca554c8a5657df8ae005a02ab5d6d2fbed933bf81b983788a1ad24b8",
      563
    ],
    "token-under": [
      "invalid-input",
      "attunegraph-candidate-capacity-error:sha256:185f6f3377bded4436807e22eb370371472fc69db663c2eadfc2142d87156e34",
      424
    ],
    "token-exact": [
      "normal",
      "attunegraph-candidate-ledger:sha256:f5dd0d744af0f37158c82b591880b794e7c1ea3cfefd0fe93596d8005e4db135",
      563
    ],
    "token-over": [
      "normal",
      "attunegraph-candidate-ledger:sha256:fbde9eb814e5adc306bcaff619751e052425bfe6b3d0f3e2cb159e4d8ebbd7b9",
      563
    ]
  },
  "10": {
    "bytes-under": [
      "invalid-input",
      "attunegraph-candidate-capacity-error:sha256:1f68ac551ffebc13d3a0d38ef8bfa50b1f0c3240a17c159345924fcb9e02e904",
      424
    ],
    "bytes-exact": [
      "normal",
      "attunegraph-candidate-ledger:sha256:4cdc220422ebe3eaca9fa223a18bb7f8295a4ee34ed79df7c70fa85aa3d2c914",
      564
    ],
    "bytes-over": [
      "normal",
      "attunegraph-candidate-ledger:sha256:3e2bff727663da2cf7a3262663b7bd6564979e340c2c28ce7eb21a1661b7adc8",
      564
    ],
    "token-under": [
      "invalid-input",
      "attunegraph-candidate-capacity-error:sha256:ec197adab86c520c1e813c82579514d955b38a4459f7931fde8075484c100be1",
      424
    ],
    "token-exact": [
      "normal",
      "attunegraph-candidate-ledger:sha256:6e953f5a56670561f7b9c4858ce6f25f3b2dbe97bab48caef8ee118733f9d24e",
      564
    ],
    "token-over": [
      "normal",
      "attunegraph-candidate-ledger:sha256:94b579f4ddfe834464aefaf10d07acbf89849d0a9deb7e40322698f3a809e5f1",
      564
    ]
  },
  "99": {
    "bytes-under": [
      "invalid-input",
      "attunegraph-candidate-capacity-error:sha256:9048f0ffe31e87c18617017df6895559aff128bda474a53e29a57fb60fd5b48e",
      424
    ],
    "bytes-exact": [
      "normal",
      "attunegraph-candidate-ledger:sha256:8ee9ee878cb27bad80025a559b359835c36c7938b4c05638eaff0fcaf60b9d92",
      564
    ],
    "bytes-over": [
      "normal",
      "attunegraph-candidate-ledger:sha256:30e54dd56840bd6edab0998f75d2a72efe828dd84fb31fb9b932d8e050ab147b",
      564
    ],
    "token-under": [
      "invalid-input",
      "attunegraph-candidate-capacity-error:sha256:5cef3bf783fb9b135999ee9b9345720eefb6c5584227828e963c6f7c6dc26a3a",
      424
    ],
    "token-exact": [
      "normal",
      "attunegraph-candidate-ledger:sha256:72d7ddcba5839978b5f76bb17d7bce1b594c6f8318c41be0775f91c92940d7b8",
      564
    ],
    "token-over": [
      "normal",
      "attunegraph-candidate-ledger:sha256:84c24359c1b4c580e169ab1e6ac0ed8e7113a58d82c8b4cce32c6e6fe834737c",
      564
    ]
  },
  "100": {
    "bytes-under": [
      "invalid-input",
      "attunegraph-candidate-capacity-error:sha256:110b7aa22948458e6b999c2ebb29c3f814135bdd69db1a552f9c31a013881d5c",
      424
    ],
    "bytes-exact": [
      "normal",
      "attunegraph-candidate-ledger:sha256:f202a4fff5580cbeb8c6c0c5881869761e9b0b1476e0c7698248cedcc8c52fb6",
      565
    ],
    "bytes-over": [
      "normal",
      "attunegraph-candidate-ledger:sha256:1844e19afa339c64d70b2a467d5324557536bfb9c26b432179203459927ee090",
      565
    ],
    "token-under": [
      "invalid-input",
      "attunegraph-candidate-capacity-error:sha256:a016d2e19b88081a11bd0cf2aa0ee7bdaad7f742b6d6f60d6c8e39bdb13d58fa",
      424
    ],
    "token-exact": [
      "normal",
      "attunegraph-candidate-ledger:sha256:9a071826ecb4efee6a518f9542d1c5dfedab26de10f6a6fe515f64399da0fbd4",
      565
    ],
    "token-over": [
      "normal",
      "attunegraph-candidate-ledger:sha256:38f995c6456646228d67b32aeecebb1ab1e75293419ea20b06ce4540948c5ce5",
      565
    ]
  }
} as const;
const capacityCanonicalJson = {
  "9": {
    "bytes-under": "{\"errorId\":\"attunegraph-candidate-capacity-error:sha256:d102084eca6e161ce2074bc8adea084e991ce733138f5c972b88418ccdc260c7\",\"firstViolatedAxis\":\"bytes\",\"inventoryId\":\"attunegraph-candidate-inventory:sha256:caad3bbc47872f66564b7b1a94179ce63f0de63d01a7fe67d7ae82dfb53e3d02\",\"minimumRequired\":{\"maxEstimatedTokens\":158,\"maxOutputBytes\":629},\"mode\":\"invalid-input\",\"reasonId\":\"minimum-abstention-exceeds-budget\",\"schemaVersion\":1}",
    "bytes-exact": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":9,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:99f5c4f242583d3f30a26031260684b22f5f3093ab24fcb3b18bd5cff6abf954\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:f0b8f9e41ad9a0ae3fa5c6f58c2e9de14bf2f09341e2bb0e29e511d20baac009\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "bytes-over": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":9,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:1c4be76c52cfd54a63298b9fcfc017f942a7c936a2f6388356dcee0c3375f282\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:d45c42aeca554c8a5657df8ae005a02ab5d6d2fbed933bf81b983788a1ad24b8\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "token-under": "{\"errorId\":\"attunegraph-candidate-capacity-error:sha256:185f6f3377bded4436807e22eb370371472fc69db663c2eadfc2142d87156e34\",\"firstViolatedAxis\":\"token\",\"inventoryId\":\"attunegraph-candidate-inventory:sha256:ac4300b24f8d81164a25d4211ab709022807295761685e933188cef8f672cb5c\",\"minimumRequired\":{\"maxEstimatedTokens\":158,\"maxOutputBytes\":629},\"mode\":\"invalid-input\",\"reasonId\":\"minimum-abstention-exceeds-budget\",\"schemaVersion\":1}",
    "token-exact": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":9,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:514288510162557529592c62f8e7f798634fff83236fb8e73be1c485c7995cc2\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:f5dd0d744af0f37158c82b591880b794e7c1ea3cfefd0fe93596d8005e4db135\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "token-over": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":9,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:53de3d950c82dbcf887788c58ccba1548fcac4a5e224fba193dbe3a1122ebb2c\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:fbde9eb814e5adc306bcaff619751e052425bfe6b3d0f3e2cb159e4d8ebbd7b9\",\"mode\":\"normal\",\"schemaVersion\":1}"
  },
  "10": {
    "bytes-under": "{\"errorId\":\"attunegraph-candidate-capacity-error:sha256:1f68ac551ffebc13d3a0d38ef8bfa50b1f0c3240a17c159345924fcb9e02e904\",\"firstViolatedAxis\":\"bytes\",\"inventoryId\":\"attunegraph-candidate-inventory:sha256:269bf2a2d2654a9f1bf2d7bffc227ba9d0793200e86150d9fdaad6eb6736f9e2\",\"minimumRequired\":{\"maxEstimatedTokens\":158,\"maxOutputBytes\":629},\"mode\":\"invalid-input\",\"reasonId\":\"minimum-abstention-exceeds-budget\",\"schemaVersion\":1}",
    "bytes-exact": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":10,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:9e1ed460ca8df680a308df4160318c76ab6b0a6d65b9b13d338859cce3475f6e\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:4cdc220422ebe3eaca9fa223a18bb7f8295a4ee34ed79df7c70fa85aa3d2c914\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "bytes-over": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":10,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:78dc794b77631992bf7ef0f399781b70ea79b2626ff207663ba9d1df998de683\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:3e2bff727663da2cf7a3262663b7bd6564979e340c2c28ce7eb21a1661b7adc8\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "token-under": "{\"errorId\":\"attunegraph-candidate-capacity-error:sha256:ec197adab86c520c1e813c82579514d955b38a4459f7931fde8075484c100be1\",\"firstViolatedAxis\":\"token\",\"inventoryId\":\"attunegraph-candidate-inventory:sha256:1804288233f2f677fba041e3e63e6804c9b9615db97da25ca7a0de92d8c4f39f\",\"minimumRequired\":{\"maxEstimatedTokens\":158,\"maxOutputBytes\":629},\"mode\":\"invalid-input\",\"reasonId\":\"minimum-abstention-exceeds-budget\",\"schemaVersion\":1}",
    "token-exact": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":10,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:2126c78bfd43853027a0d3f386ee174af20ee4e040375327164376a39938c73d\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:6e953f5a56670561f7b9c4858ce6f25f3b2dbe97bab48caef8ee118733f9d24e\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "token-over": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":10,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:db3156b0cb5fc5a1611e0c955930f914f7ab7eeb8fd86ac3ca4a9c42115f83be\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:94b579f4ddfe834464aefaf10d07acbf89849d0a9deb7e40322698f3a809e5f1\",\"mode\":\"normal\",\"schemaVersion\":1}"
  },
  "99": {
    "bytes-under": "{\"errorId\":\"attunegraph-candidate-capacity-error:sha256:9048f0ffe31e87c18617017df6895559aff128bda474a53e29a57fb60fd5b48e\",\"firstViolatedAxis\":\"bytes\",\"inventoryId\":\"attunegraph-candidate-inventory:sha256:6f4e257e2f97765d2be8e32e789f2c28577db2d84069356d20dc52c472ece5b3\",\"minimumRequired\":{\"maxEstimatedTokens\":158,\"maxOutputBytes\":629},\"mode\":\"invalid-input\",\"reasonId\":\"minimum-abstention-exceeds-budget\",\"schemaVersion\":1}",
    "bytes-exact": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":99,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:38065a779a34e0b1f5bca6ad2c410cd0f9056ecbdabf5ccd7005a025d049e513\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:8ee9ee878cb27bad80025a559b359835c36c7938b4c05638eaff0fcaf60b9d92\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "bytes-over": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":99,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:de8706c3e04284dc9abd8297aaaa41c10a600f37cba8b9711305997cd7209e23\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:30e54dd56840bd6edab0998f75d2a72efe828dd84fb31fb9b932d8e050ab147b\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "token-under": "{\"errorId\":\"attunegraph-candidate-capacity-error:sha256:5cef3bf783fb9b135999ee9b9345720eefb6c5584227828e963c6f7c6dc26a3a\",\"firstViolatedAxis\":\"token\",\"inventoryId\":\"attunegraph-candidate-inventory:sha256:b29a7e1534622ddd82d7c49718c99ba24482f12c763b76c5445c619a0cd9fb8d\",\"minimumRequired\":{\"maxEstimatedTokens\":158,\"maxOutputBytes\":629},\"mode\":\"invalid-input\",\"reasonId\":\"minimum-abstention-exceeds-budget\",\"schemaVersion\":1}",
    "token-exact": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":99,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:e26390de88cf681caa52f3bf9c1fa49572fb0f26c11ea60f5f64cba47b383c45\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:72d7ddcba5839978b5f76bb17d7bce1b594c6f8318c41be0775f91c92940d7b8\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "token-over": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":99,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:7c46dc989b7746bcb2cdd4d3d0e3865a3d5f5fa3d983526728a6dad3ce8feb89\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:84c24359c1b4c580e169ab1e6ac0ed8e7113a58d82c8b4cce32c6e6fe834737c\",\"mode\":\"normal\",\"schemaVersion\":1}"
  },
  "100": {
    "bytes-under": "{\"errorId\":\"attunegraph-candidate-capacity-error:sha256:110b7aa22948458e6b999c2ebb29c3f814135bdd69db1a552f9c31a013881d5c\",\"firstViolatedAxis\":\"bytes\",\"inventoryId\":\"attunegraph-candidate-inventory:sha256:00085dd1e9646a6a491c4bf3c1f324f0eb05f879ba75329393595c7489ce71d2\",\"minimumRequired\":{\"maxEstimatedTokens\":158,\"maxOutputBytes\":629},\"mode\":\"invalid-input\",\"reasonId\":\"minimum-abstention-exceeds-budget\",\"schemaVersion\":1}",
    "bytes-exact": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":100,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:4d4d93fcff6081aa23ed63cdd408e9b8549501ea3cf82f97d1a344f1899af45e\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:f202a4fff5580cbeb8c6c0c5881869761e9b0b1476e0c7698248cedcc8c52fb6\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "bytes-over": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":100,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:81def62d8a29e62addc330da4a1a222641ad0b516648e9b93584aaa5cfd10b65\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:1844e19afa339c64d70b2a467d5324557536bfb9c26b432179203459927ee090\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "token-under": "{\"errorId\":\"attunegraph-candidate-capacity-error:sha256:a016d2e19b88081a11bd0cf2aa0ee7bdaad7f742b6d6f60d6c8e39bdb13d58fa\",\"firstViolatedAxis\":\"token\",\"inventoryId\":\"attunegraph-candidate-inventory:sha256:b744702e4633bd4758dd9815358997940eccffd8cfaac13914b95c78c181ee7c\",\"minimumRequired\":{\"maxEstimatedTokens\":158,\"maxOutputBytes\":629},\"mode\":\"invalid-input\",\"reasonId\":\"minimum-abstention-exceeds-budget\",\"schemaVersion\":1}",
    "token-exact": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":100,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:40e7e1d41f09136df9866536083625094bf0672a53c0d6a40cf8b59282a46712\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:9a071826ecb4efee6a518f9542d1c5dfedab26de10f6a6fe515f64399da0fbd4\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "token-over": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":100,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:2d8409e594640b4da07c8f8517783790272b9f0b547c716ea5dccc1745d5b564\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:38f995c6456646228d67b32aeecebb1ab1e75293419ea20b06ce4540948c5ce5\",\"mode\":\"normal\",\"schemaVersion\":1}"
  }
} as const;
const capacityVariantDiscriminants = {
  "bytes-under": "invalid-input",
  "bytes-exact": "settled",
  "bytes-over": "settled",
  "token-under": "invalid-input",
  "token-exact": "settled",
  "token-over": "settled"
} as const;

describe("settleCandidateInventory named contracts", () => {
  it("covers core admission, semantic abstention, all terminal states, and deterministic raw-ID ordering", () => {
    const normal = settled(makeRequest([eligible("z", "optional", 1), rejected("m", "optional", "semantic:policy"), eligible("a", "optional", 1)], eligible("core", "core"), { maxConsideredAssertions: 0 }));
    expect(normal.ledger.mode).toBe("normal");
    expect(normal.ledger.entries).toEqual([
      { candidateId: "core", role: "core", terminalState: "admitted" },
      { candidateId: "a", role: "optional", terminalState: "admitted" },
      { candidateId: "m", reasonId: "semantic:policy", role: "optional", terminalState: "rejected" },
      { candidateId: "z", role: "optional", terminalState: "admitted" },
    ]);
    const failed = settled(makeRequest([eligible("b", "optional", 1, { consideredAssertions: 1 }), eligible("c", "optional", 2)], eligible("core", "core"), { maxConsideredAssertions: 0 }));
    expect(failed.ledger.entries).toEqual([
      { candidateId: "core", role: "core", terminalState: "admitted" },
      { candidateId: "b", reasonId: "budget:considered", role: "optional", terminalState: "failed" },
      { candidateId: "c", reasonId: "skipped:after-first-failure", role: "optional", terminalState: "skipped" },
    ]);
    const abstain = settled(makeRequest([eligible("b", "optional"), rejected("a", "optional")], rejected("core", "core", "semantic:core-blocked")));
    expect(abstain.ledger.mode).toBe("abstain");
    expect(abstain.ledger.firstViolatedAxis).toBeUndefined();
    expect(abstain.ledger.entries).toEqual([
      { candidateId: "core", reasonId: "semantic:core-blocked", role: "core", terminalState: "rejected" },
      { candidateId: "a", reasonId: "semantic:blocked", role: "optional", terminalState: "rejected" },
      { candidateId: "b", reasonId: "skipped:core-not-admitted", role: "optional", terminalState: "skipped" },
    ]);
  });

  it("pins all six gate rollback rows and below/exact/above limits", () => {
    for (const gate of oracleGates) {
      const expectedFailure = {
        assertions: { consideredAssertions: 1, selectedAssertions: 0, visitedRefs: 1 },
        bytes: { consideredAssertions: 1, selectedAssertions: 0, selectedPayloadBytes: 0, selectedPayloadEstimatedTokens: 0, visitedRefs: 1 },
        considered: { consideredAssertions: 0, visitedRefs: 0 },
        depth: { consideredAssertions: 0, maxDepth: 0, visitedRefs: 0 },
        token: { consideredAssertions: 1, selectedAssertions: 0, selectedPayloadBytes: 0, selectedPayloadEstimatedTokens: 0, visitedRefs: 1 },
        visited: { consideredAssertions: 1, visitedRefs: 0 },
      }[gate.axis];
      const relations = gate.axis === "token" || gate.axis === "bytes" ? ["below"] as const : ["below", "exact", "above"] as const;
      for (const relation of relations) {
        const cost = { consideredAssertions: gate.axis === "considered" ? 1 : gate.axis === "visited" || gate.axis === "assertions" || gate.axis === "token" || gate.axis === "bytes" ? 1 : 0, visitedRefs: gate.axis === "visited" || gate.axis === "assertions" || gate.axis === "token" || gate.axis === "bytes" ? 1 : 0, [gate.cost]: 1 };
        if (gate.axis === "token" || gate.axis === "bytes") cost[gate.cost] = 1_000;
        const cap = relation === "below" ? (gate.axis === "token" || gate.axis === "bytes" ? 999 : 0) : relation === "exact" ? 1 : 2;
        const value = makeRequest([eligible("a", "optional", 0, cost)], eligible("core", "core"), { [gate.budget]: cap });
        const result = settled(value);
        const item = result.ledger.entries[1]!;
        expect(item.terminalState).toBe(relation === "below" ? "failed" : "admitted");
        if (relation === "below") {
          expect(item).toEqual({ candidateId: "a", reasonId: `budget:${gate.axis}`, role: "optional", terminalState: "failed" });
          expect(result.ledger.counters).toMatchObject(expectedFailure);
        }
      }
      if (gate.axis === "token" || gate.axis === "bytes") {
        const fitting = settled(makeRequest([eligible("a", "optional", 0, { [gate.cost]: 1 })]));
        expect(fitting.ledger.entries[1]?.terminalState).toBe("admitted");
      }
    }
  });

  it("uses rank then raw UTF-16 ID, never input order, and stops after one eligible failure", () => {
    const values = [eligible("z", "optional", 1), eligible("a", "optional", 1), eligible("first", "optional", 0, { depth: 2 }), eligible("later", "optional", 2, { consideredAssertions: Number.MAX_SAFE_INTEGER })];
    for (const permutation of permutations(values)) {
      const result = settled(makeRequest(permutation, eligible("core", "core"), { maxDepth: 1 }));
      expect(result.ledger.entries.map((item) => item.candidateId)).toEqual(["core", "a", "first", "later", "z"]);
      expect(result.ledger.entries.find((item) => item.candidateId === "first")).toMatchObject({ reasonId: "budget:depth", terminalState: "failed" });
      expect(result.ledger.entries.filter((item) => item.candidateId !== "core" && item.candidateId !== "first")).toEqual(expect.arrayContaining([
        expect.objectContaining({ candidateId: "a", reasonId: "skipped:after-first-failure" }),
        expect.objectContaining({ candidateId: "later", reasonId: "skipped:after-first-failure" }),
        expect.objectContaining({ candidateId: "z", reasonId: "skipped:after-first-failure" }),
      ]));
    }
  });

  it("keeps safe-integer exact sums and turns prospective overflow into the current gate failure", () => {
    const exact = settled(makeRequest([eligible("a", "optional", 0, { consideredAssertions: 1 })], eligible("core", "core", 0, { consideredAssertions: Number.MAX_SAFE_INTEGER - 1 }), { maxConsideredAssertions: Number.MAX_SAFE_INTEGER }));
    expect(exact.ledger.counters.consideredAssertions).toBe(Number.MAX_SAFE_INTEGER);
    expect(exact.ledger.entries[1]?.terminalState).toBe("admitted");
    const overflow = settled(makeRequest([eligible("a", "optional", 0, { consideredAssertions: 2 })], eligible("core", "core", 0, { consideredAssertions: Number.MAX_SAFE_INTEGER - 1 }), { maxConsideredAssertions: Number.MAX_SAFE_INTEGER }));
    expect(overflow.ledger.counters.consideredAssertions).toBe(Number.MAX_SAFE_INTEGER - 1);
    expect(overflow.ledger.entries[1]).toMatchObject({ reasonId: "budget:considered", terminalState: "failed" });
  });

  it("enforces exact validation ownership, path precedence, roles, IDs, reasons, numbers, and shapes", () => {
    expectPrivateError({ ...makeRequest(), extra: true, schemaVersion: 2 }, "invalid-field-set", "");
    expectPrivateError({ ...makeRequest(), schemaVersion: 2 }, "invalid-schema-version", "/schemaVersion");
    expectPrivateError({ ...makeRequest(), budget: null }, "invalid-container", "/budget");
    expectPrivateError({ ...makeRequest(), budget: { ...makeRequest().budget, extra: true, maxDepth: -1 } }, "invalid-field-set", "/budget");
    expectPrivateError({ ...makeRequest(), core: { ...eligible("BAD", "core"), role: "optional" } }, "invalid-role", "/core/role");
    expectPrivateError({ ...makeRequest(), core: { ...eligible("BAD", "core") } }, "invalid-candidate-id", "/core/candidateId");
    expectPrivateError({ ...makeRequest(), core: { ...eligible("core", "core"), preflight: { extra: true, status: "bogus" } } }, "invalid-field-set", "/core/preflight");
    expectPrivateError({ ...makeRequest(), core: { ...eligible("core", "core"), preflight: { status: "bogus" } } }, "invalid-preflight-status", "/core/preflight/status");
    expectPrivateError(makeRequest([], rejected("core", "core", "nope")), "invalid-reason-id", "/core/preflight/reasonId");
    expectPrivateError({ ...makeRequest(), core: { ...eligible("core", "core"), rank: 1 } }, "invalid-rank", "/core/rank");
    expectPrivateError({ ...makeRequest(), core: { ...eligible("core", "core"), cost: { ...zeroCost(), depth: -1 } } }, "invalid-number", "/core/cost/depth");
    expectPrivateError(makeRequest([{ ...rejected("a", "optional"), cost: { ...zeroCost(), outputBytes: 1 } }]), "invalid-rejected-shape", "/optionals/0/cost");
    expectPrivateError(makeRequest([eligible("core", "optional")]), "duplicate-candidate-id", "/optionals/0/candidateId");
    expectPrivateError({ ...makeRequest(), optionals: {} }, "invalid-container", "/optionals");
    expect(() => settleCandidateInventory({ ...makeRequest(), inventoryId: "caller-owned-bad-id" })).toThrow();
    try { settleCandidateInventory({ ...makeRequest(), core: { ...eligible("core", "core"), cost: { ...zeroCost(), depth: Number.MAX_SAFE_INTEGER + 1 } } }); } catch (error) { expect(error).not.toBeInstanceOf(CandidateSettlementError); }
  });

  it("pins 0/255/256 optional cardinality", () => {
    expect(settled(makeRequest()).ledger.counters.candidateCount).toBe(1);
    expect(settled(makeRequest(Array.from({ length: 255 }, (_, index) => eligible(`optional-${index}`, "optional")))).ledger.counters.candidateCount).toBe(256);
    expectPrivateError(makeRequest(Array.from({ length: 256 }, (_, index) => eligible(`optional-${index}`, "optional"))), "too-many-optionals", "/optionals");
  });

  it("rejects hostile snapshots without executing accessors or proxy traps", () => {
    let getterCalls = 0;
    const accessor = makeRequest();
    Object.defineProperty(accessor.core, "candidateId", { enumerable: true, get() { getterCalls += 1; return "core"; } });
    let proxyTraps = 0;
    const proxy = new Proxy(makeRequest(), { getOwnPropertyDescriptor() { proxyTraps += 1; throw new Error("must not execute"); }, ownKeys() { proxyTraps += 1; throw new Error("must not execute"); } });
    const alias = makeRequest(); alias.optionals = [alias.core];
    const cycle = makeRequest(); (cycle.core as unknown as Record<string, unknown>).self = cycle.core;
    const sparse = makeRequest(); sparse.optionals = new Array(1);
    const symbolic = makeRequest(); Object.defineProperty(symbolic, Symbol("hidden"), { enumerable: true, value: true });
    const prototype = makeRequest(); Object.setPrototypeOf(prototype.core, { hostile: true });
    for (const hostile of [accessor, proxy, alias, cycle, sparse, symbolic, prototype]) {
      try { settleCandidateInventory(hostile); throw new Error("expected hostile-input rejection"); } catch (error) { expect(error).not.toBeInstanceOf(CandidateSettlementError); }
    }
    expect(getterCalls).toBe(0);
    expect(proxyTraps).toBe(0);
  });

  it("returns detached deeply frozen closed shapes and survives caller mutation", () => {
    const source = makeRequest([eligible("a", "optional", 0, { consideredAssertions: 1 })]);
    const result = settled(source);
    const before = JSON.stringify(result);
    source.core.candidateId = "mutated";
    source.optionals[0]!.cost.consideredAssertions = 99_999;
    source.optionals.push(eligible("b", "optional"));
    expect(JSON.stringify(result)).toBe(before);
    expectDeepFrozen(result);
    const keys = ownDeepKeys(result);
    for (const forbidden of ["trial", "attempt", "discarded", "priorMode", "axes", "message", "budget"]) expect(keys).not.toContain(forbidden);
    expect(Object.keys(result)).toEqual(["canonicalByteLength", "canonicalJson", "estimatedTokens", "ledger", "status", "totalOutputBytes"]);
    expect(Object.keys(result.ledger)).toEqual(["counters", "entries", "inventoryId", "mode", "schemaVersion", "ledgerId"]);
  });

  it("selects normal, core-only, abstain, and capacity-only fallbacks with exact axis provenance", () => {
    const candidates = [eligible("a", "optional", 1, { estimatedTokens: 100, outputBytes: 200 }), eligible("b", "optional", 1, { estimatedTokens: 100, outputBytes: 200 })];
    expect(settled(makeRequest(candidates, eligible("core", "core", 0, { estimatedTokens: 50, outputBytes: 200 }), { maxOutputBytes: 1_500 })).ledger.mode).toBe("normal");
    const coreOnly = settled(makeRequest(candidates, eligible("core", "core"), { maxOutputBytes: 802 }));
    expect(coreOnly.ledger.mode).toBe("core-only");
    expect(coreOnly.ledger.firstViolatedAxis).toBe("bytes");
    expect(coreOnly.ledger.entries.slice(1).every((item) => item.terminalState === "skipped" && item.reasonId === "skipped:core-only-fallback")).toBe(true);
    const abstain = settled(makeRequest(candidates, eligible("core", "core", 0, { estimatedTokens: 50, outputBytes: 200 }), { maxOutputBytes: 850 }));
    expect(abstain.ledger.mode).toBe("abstain");
    expect(abstain.ledger.firstViolatedAxis).toBe("bytes");
    expect(abstain.ledger.counters.selectedPayloadBytes).toBe(0);
    const invalid = settleCandidateInventory(makeRequest(candidates, eligible("core", "core", 0, { estimatedTokens: 50, outputBytes: 200 }), { maxEstimatedTokens: 0, maxOutputBytes: 0 }));
    expect(invalid.status).toBe("invalid-input");
    if (invalid.status !== "invalid-input") return;
    expect(invalid.error.firstViolatedAxis).toBe("token");
    expect(invalid.error.minimumRequired.maxEstimatedTokens).toBe(Math.ceil(invalid.error.minimumRequired.maxOutputBytes / 4));
    expect(Object.keys(invalid.error)).toEqual(["firstViolatedAxis", "inventoryId", "minimumRequired", "mode", "reasonId", "schemaVersion", "errorId"]);
    expectDeepFrozen(invalid);
  });
});

describe("settleCandidateInventory independent literal digit-growth goldens", () => {
  const baseRequest = (consideredAssertions: number, budget: Partial<Request["budget"]> = {}) => makeRequest([], eligible("core", "core", 0, { consideredAssertions }), {
    maxAssertions: 0,
    maxConsideredAssertions: 1_000,
    maxDepth: 0,
    maxEstimatedTokens: 1_000_000,
    maxOutputBytes: 1_000_000,
    maxVisitedRefs: 0,
    ...budget,
  });

  it("pins four inventory/normal ledger growth boundaries and all 24 capacity variants", () => {
    for (const considered of [9, 10, 99, 100] as const) {
      const base = settled(baseRequest(considered));
      const literal = baseLedgerGoldens[considered];
      expect(expectLiteralEnvelope(baseInventoryCanonicalJson[considered], "attunegraph.candidate-inventory.v1", "inventoryId", "attunegraph-candidate-inventory:sha256:").inventoryId).toBe(baseInventoryIds[considered]);
      expect(base.ledger.inventoryId).toBe(baseInventoryIds[considered]);
      expect(base.canonicalByteLength).toBe(literal.bytes);
      expect(base.ledger.ledgerId).toBe(literal.id);
      expect(base.canonicalJson).toBe(baseLedgerCanonicalJson[considered]);
      expect(Buffer.byteLength(base.canonicalJson)).toBe(literal.bytes);
      expect(expectLiteralEnvelope(baseLedgerCanonicalJson[considered], "attunegraph.candidate-settlement-ledger.v1", "ledgerId", "attunegraph-candidate-ledger:sha256:")).toEqual(base.ledger);
      const q = Math.ceil(literal.bytes / 4);
      const variants = {
        "bytes-under": { maxEstimatedTokens: 1_000_000, maxOutputBytes: literal.bytes - 1 },
        "bytes-exact": { maxEstimatedTokens: 1_000_000, maxOutputBytes: literal.bytes },
        "bytes-over": { maxEstimatedTokens: 1_000_000, maxOutputBytes: literal.bytes + 1 },
        "token-under": { maxEstimatedTokens: q - 1, maxOutputBytes: 1_000_000 },
        "token-exact": { maxEstimatedTokens: q, maxOutputBytes: 1_000_000 },
        "token-over": { maxEstimatedTokens: q + 1, maxOutputBytes: 1_000_000 },
      } as const;
      for (const [name, budget] of Object.entries(variants) as [keyof typeof variants, (typeof variants)[keyof typeof variants]][]) {
        const actual = settleCandidateInventory(baseRequest(considered, budget));
        const [mode, id, bytes] = capacityGoldenIds[considered][name];
        const canonicalJson = capacityCanonicalJson[considered][name];
        expect(actual.status).toBe(capacityVariantDiscriminants[name]);
        expect(actual.canonicalByteLength).toBe(bytes);
        expect(actual.canonicalJson).toBe(canonicalJson);
        expect(Buffer.byteLength(actual.canonicalJson)).toBe(bytes);
        expect(actual.status === "settled" ? actual.ledger.mode : actual.error.mode).toBe(mode);
        expect(actual.status === "settled" ? actual.ledger.ledgerId : actual.error.errorId).toBe(id);
        if (actual.status === "settled") {
          expect(expectLiteralEnvelope(canonicalJson, "attunegraph.candidate-settlement-ledger.v1", "ledgerId", "attunegraph-candidate-ledger:sha256:")).toEqual(actual.ledger);
          expect(actual.totalOutputBytes).toBe(actual.canonicalByteLength);
          expect(actual.estimatedTokens).toBe(Math.ceil(actual.canonicalByteLength / 4));
          expect(actual.ledger.entries).toEqual([{ candidateId: "core", role: "core", terminalState: "admitted" }]);
          expect(actual.ledger.counters).toMatchObject({ admitted: 1, candidateCount: 1, consideredAssertions: considered });
        } else {
          expect(expectLiteralEnvelope(canonicalJson, "attunegraph.candidate-settlement-capacity-error.v1", "errorId", "attunegraph-candidate-capacity-error:sha256:")).toEqual(actual.error);
          expect(actual.error.firstViolatedAxis).toBe(name.startsWith("bytes") ? "bytes" : "token");
          expect(actual.error.minimumRequired).toEqual({ maxEstimatedTokens: 158, maxOutputBytes: 629 });
        }
      }
    }
  });
});

describe("settleCandidateInventory 3312-case declarative BigInt oracle", () => {
  it("matches 0-3 optionals, ternary eligibility/rank profiles, every permutation, axis, and below/exact/above relation", () => {
    let cases = 0;
    for (let optionalCount = 0; optionalCount <= 3; optionalCount += 1) {
      const profileCount = 3 ** optionalCount;
      for (let profile = 0; profile < profileCount; profile += 1) {
        let encoded = profile;
        const optionals = Array.from({ length: optionalCount }, (_, index) => {
          const state = encoded % 3;
          encoded = Math.floor(encoded / 3);
          return state === 0 ? rejected(`optional-${index}`, "optional", `semantic:reject-${index}`) : eligible(`optional-${index}`, "optional", state - 1);
        });
        for (const permutation of permutations(optionals)) {
          for (const gate of oracleGates) {
            for (const relation of ["below", "exact", "above"] as const) {
              const capacityAxis = gate.axis === "token" || gate.axis === "bytes";
              const eligibleCount = 1 + permutation.filter((candidate) => candidate.preflight.status === "eligible").length;
              const cap = capacityAxis ? 10_000 : gate.combine === "max" ? 1_000 : eligibleCount * 1_000;
              const cost = capacityAxis
                ? relation === "below" ? 1_000 : relation === "exact" ? cap : cap + 1
                : relation === "below" ? 999 : relation === "exact" ? 1_000 : 1_001;
              const axisCost = (): Partial<Cost> => {
                const output: Partial<Cost> = { [gate.cost]: cost };
                if (gate.axis === "visited" || gate.axis === "assertions" || gate.axis === "token" || gate.axis === "bytes") output.consideredAssertions = 1;
                if (gate.axis === "assertions" || gate.axis === "token" || gate.axis === "bytes") output.visitedRefs = 1;
                return output;
              };
              const withCost = (candidate: Candidate): Candidate => candidate.preflight.status === "rejected" ? candidate : { ...candidate, cost: { ...candidate.cost, ...axisCost() } };
              const core = withCost(eligible("core", "core"));
              const candidates = capacityAxis ? permutation : permutation.map(withCost);
              const value = makeRequest(candidates, core, { [gate.budget]: cap });
              let expected = oracleSettlement(value);
              if ((gate.axis === "token" || gate.axis === "bytes") && relation === "exact") {
                const entries: OracleEntry[] = [
                  { candidateId: "core", reasonId: "skipped:abstain-fallback", role: "core", terminalState: "skipped" },
                  ...candidates.map((candidate) => candidate.preflight.status === "rejected"
                    ? { candidateId: candidate.candidateId, reasonId: candidate.preflight.reasonId, role: candidate.role, terminalState: "rejected" as const }
                    : { candidateId: candidate.candidateId, reasonId: "skipped:abstain-fallback", role: candidate.role, terminalState: "skipped" as const }).sort((left, right) => left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0),
                ];
                const counts = { admitted: 0, failed: 0, rejected: entries.filter((item) => item.terminalState === "rejected").length, skipped: entries.filter((item) => item.terminalState === "skipped").length };
                expected = { counters: { ...counts, candidateCount: entries.length, consideredAssertions: 0, maxDepth: 0, selectedAssertions: 0, selectedPayloadBytes: 0, selectedPayloadEstimatedTokens: 0, visitedRefs: 0 }, entries, mode: "abstain" };
              }
              const actual = settled(value);
              expect(actual.ledger.mode).toBe(expected.mode);
              expect(actual.ledger.entries, `${optionalCount}/${profile}/${gate.axis}/${relation}`).toEqual(expected.entries);
              expect(actual.ledger.counters, `${optionalCount}/${profile}/${gate.axis}/${relation}`).toEqual(expected.counters);
              expect(actual.ledger.firstViolatedAxis).toBe(expected.mode === "abstain" ? gate.axis : undefined);
              cases += 1;
            }
          }
        }
      }
    }
    expect(cases).toBe(3_312);
  }, 60_000);
});
