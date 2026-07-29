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
  9: "muse-candidate-inventory:sha256:ccfabaa861bce1ac18cd540f6e39ecc639a3447d6cd480d5e519a3ae4ea18fd7",
  10: "muse-candidate-inventory:sha256:e0c3989c3b3342ea2e7e93bd56826faea635df4feaaccd74144a30ad12cd85bc",
  99: "muse-candidate-inventory:sha256:59999f9b21c5438483d1535cce93dcbb6d09d9e81b64d9bd08836f0cd77e8095",
  100: "muse-candidate-inventory:sha256:3836d4080dccd61d3df7623992a4328dd4f14fc27ae8d68d9425e31de1f27d21",
} as const;
const baseLedgerGoldens = {
  9: { bytes: 549, id: "muse-candidate-ledger:sha256:906e670c57d9dd5ce87d226e0345b1ddfd183cf172d25a351b0618eb7088c07c" },
  10: { bytes: 550, id: "muse-candidate-ledger:sha256:ba191fce935dc2ebafff1c61b48354d149a1016a52de667424da64246c0157c8" },
  99: { bytes: 550, id: "muse-candidate-ledger:sha256:6a31fc757254ac4c107729dca474cf5612cd1ca482dc6d2d9e21ce79f0bd5e33" },
  100: { bytes: 551, id: "muse-candidate-ledger:sha256:df29dbaee42c16bee4d2f7c836210df5ecf8f8e69aadd49a9d8d1f0386da57d0" },
} as const;
const baseInventoryCanonicalJson = {
  9: "{\"budget\":{\"maxAssertions\":0,\"maxConsideredAssertions\":1000,\"maxDepth\":0,\"maxEstimatedTokens\":1000000,\"maxOutputBytes\":1000000,\"maxVisitedRefs\":0},\"core\":{\"candidateId\":\"core\",\"cost\":{\"assertions\":0,\"consideredAssertions\":9,\"depth\":0,\"estimatedTokens\":0,\"outputBytes\":0,\"visitedRefs\":0},\"preflight\":{\"status\":\"eligible\"},\"rank\":0,\"role\":\"core\"},\"inventoryId\":\"muse-candidate-inventory:sha256:ccfabaa861bce1ac18cd540f6e39ecc639a3447d6cd480d5e519a3ae4ea18fd7\",\"optionals\":[],\"schemaVersion\":1}",
  10: "{\"budget\":{\"maxAssertions\":0,\"maxConsideredAssertions\":1000,\"maxDepth\":0,\"maxEstimatedTokens\":1000000,\"maxOutputBytes\":1000000,\"maxVisitedRefs\":0},\"core\":{\"candidateId\":\"core\",\"cost\":{\"assertions\":0,\"consideredAssertions\":10,\"depth\":0,\"estimatedTokens\":0,\"outputBytes\":0,\"visitedRefs\":0},\"preflight\":{\"status\":\"eligible\"},\"rank\":0,\"role\":\"core\"},\"inventoryId\":\"muse-candidate-inventory:sha256:e0c3989c3b3342ea2e7e93bd56826faea635df4feaaccd74144a30ad12cd85bc\",\"optionals\":[],\"schemaVersion\":1}",
  99: "{\"budget\":{\"maxAssertions\":0,\"maxConsideredAssertions\":1000,\"maxDepth\":0,\"maxEstimatedTokens\":1000000,\"maxOutputBytes\":1000000,\"maxVisitedRefs\":0},\"core\":{\"candidateId\":\"core\",\"cost\":{\"assertions\":0,\"consideredAssertions\":99,\"depth\":0,\"estimatedTokens\":0,\"outputBytes\":0,\"visitedRefs\":0},\"preflight\":{\"status\":\"eligible\"},\"rank\":0,\"role\":\"core\"},\"inventoryId\":\"muse-candidate-inventory:sha256:59999f9b21c5438483d1535cce93dcbb6d09d9e81b64d9bd08836f0cd77e8095\",\"optionals\":[],\"schemaVersion\":1}",
  100: "{\"budget\":{\"maxAssertions\":0,\"maxConsideredAssertions\":1000,\"maxDepth\":0,\"maxEstimatedTokens\":1000000,\"maxOutputBytes\":1000000,\"maxVisitedRefs\":0},\"core\":{\"candidateId\":\"core\",\"cost\":{\"assertions\":0,\"consideredAssertions\":100,\"depth\":0,\"estimatedTokens\":0,\"outputBytes\":0,\"visitedRefs\":0},\"preflight\":{\"status\":\"eligible\"},\"rank\":0,\"role\":\"core\"},\"inventoryId\":\"muse-candidate-inventory:sha256:3836d4080dccd61d3df7623992a4328dd4f14fc27ae8d68d9425e31de1f27d21\",\"optionals\":[],\"schemaVersion\":1}",
} as const;
const baseLedgerCanonicalJson = {
  9: "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":9,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:ccfabaa861bce1ac18cd540f6e39ecc639a3447d6cd480d5e519a3ae4ea18fd7\",\"ledgerId\":\"muse-candidate-ledger:sha256:906e670c57d9dd5ce87d226e0345b1ddfd183cf172d25a351b0618eb7088c07c\",\"mode\":\"normal\",\"schemaVersion\":1}",
  10: "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":10,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:e0c3989c3b3342ea2e7e93bd56826faea635df4feaaccd74144a30ad12cd85bc\",\"ledgerId\":\"muse-candidate-ledger:sha256:ba191fce935dc2ebafff1c61b48354d149a1016a52de667424da64246c0157c8\",\"mode\":\"normal\",\"schemaVersion\":1}",
  99: "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":99,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:59999f9b21c5438483d1535cce93dcbb6d09d9e81b64d9bd08836f0cd77e8095\",\"ledgerId\":\"muse-candidate-ledger:sha256:6a31fc757254ac4c107729dca474cf5612cd1ca482dc6d2d9e21ce79f0bd5e33\",\"mode\":\"normal\",\"schemaVersion\":1}",
  100: "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":100,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:3836d4080dccd61d3df7623992a4328dd4f14fc27ae8d68d9425e31de1f27d21\",\"ledgerId\":\"muse-candidate-ledger:sha256:df29dbaee42c16bee4d2f7c836210df5ecf8f8e69aadd49a9d8d1f0386da57d0\",\"mode\":\"normal\",\"schemaVersion\":1}",
} as const;
const capacityGoldenIds = {
  9: {
    "bytes-under": ["invalid-input", "muse-candidate-capacity-error:sha256:eae8062316f57cc8b391258dfdab752aa6d9a17149ef30455792c780730969a3", 410],
    "bytes-exact": ["normal", "muse-candidate-ledger:sha256:2db0f938a76f71740ec511848b289917462565136e31a0d7c8c41d1293fd5d8e", 549],
    "bytes-over": ["normal", "muse-candidate-ledger:sha256:dd98e632d212e5426ec850cadcd82b6bd4e87fd54b545d3f64d215146d0376c4", 549],
    "token-under": ["invalid-input", "muse-candidate-capacity-error:sha256:a05b3e143dcb0048b49618034ae78675b11671525620e69ff4a8940ae1d943a2", 410],
    "token-exact": ["normal", "muse-candidate-ledger:sha256:5567e9e68981d376cc67ab8a7ad653620e7b719109697ce704b0e76d3bcf1272", 549],
    "token-over": ["normal", "muse-candidate-ledger:sha256:027464be440a78f60156c25131f61e4d0f0e38ae134614a64c26b9c9ae35773c", 549],
  },
  10: {
    "bytes-under": ["invalid-input", "muse-candidate-capacity-error:sha256:a8b267d5dcc60fd33fe56b9a14fd848d37a63c91cd065205b160a92f68e936e8", 410],
    "bytes-exact": ["normal", "muse-candidate-ledger:sha256:8e7d376c131f0a7e2c549d4359b202c3f4dc33a127a1068bc6db0598d3a6e81d", 550],
    "bytes-over": ["normal", "muse-candidate-ledger:sha256:509d22237dd4e4bd16bacfe739bf38689045651ecf9de5b24a4525d40baa319a", 550],
    "token-under": ["invalid-input", "muse-candidate-capacity-error:sha256:a93ca6c6c741a9fba130a5feab3398f5f806db9fd8c3d50d75e12888f2e8aea8", 410],
    "token-exact": ["normal", "muse-candidate-ledger:sha256:c90964c38c5910803bc279edcf141ced307a45d90470afda587c343e8bdfd19c", 550],
    "token-over": ["normal", "muse-candidate-ledger:sha256:2dca61ef2303cfc21cbf2dc5ea50e68f901572954964ccdcd71daad1ea97125a", 550],
  },
  99: {
    "bytes-under": ["invalid-input", "muse-candidate-capacity-error:sha256:55867259e115418047f26b54ea67a31560c8e54c67490c83db93a54caeff7fcc", 410],
    "bytes-exact": ["normal", "muse-candidate-ledger:sha256:a27d43c48fc8479a8e1ef2c6bc02672ecc415453a3f61fbf786bd26d9783b638", 550],
    "bytes-over": ["normal", "muse-candidate-ledger:sha256:acd7008cfd78d48a5bf4f85ef747e44abc94b367b829c186f9dc7d46848e85e3", 550],
    "token-under": ["invalid-input", "muse-candidate-capacity-error:sha256:114828d27ee1566f59ad09db44f512803558d033d402ef43038ba42d6468b099", 410],
    "token-exact": ["normal", "muse-candidate-ledger:sha256:f6f39e143cad99b45f88806457b1cce8a0c938ba4c5746d2bfd4bad82a137f07", 550],
    "token-over": ["normal", "muse-candidate-ledger:sha256:0fe7b39194b283f150846cdd54f23557b9b4c61ea26d843438b1af10a04ac38f", 550],
  },
  100: {
    "bytes-under": ["invalid-input", "muse-candidate-capacity-error:sha256:91391b01d5292bdd0f0cd2bef56fda13ea730a0250c1dd77019894cd0a92b9fe", 410],
    "bytes-exact": ["normal", "muse-candidate-ledger:sha256:ce2e7eeeda90904c297c5573a2f9bfe55f2ee65f76c476bd409fd3a51bf847b2", 551],
    "bytes-over": ["normal", "muse-candidate-ledger:sha256:05eb2540a91246c010af6ce1af5034589939ba2ff5e478c2cbb4537fa72637a0", 551],
    "token-under": ["invalid-input", "muse-candidate-capacity-error:sha256:7dffb77b0fcd7bcec16037b7d2d440046f5eb44f1136a4c8a49fefb3033c7c97", 410],
    "token-exact": ["normal", "muse-candidate-ledger:sha256:e9874818a8787f8119b6a95f7b3aba253ce06873733b46b254b83823e82d3d74", 551],
    "token-over": ["normal", "muse-candidate-ledger:sha256:47adf5549d6b29ffd3d5f082f9bcf84f25230ba390b3347621e4e77a065ddb5f", 551],
  },
} as const;
const capacityCanonicalJson = {
  9: {
    "bytes-under": "{\"errorId\":\"muse-candidate-capacity-error:sha256:eae8062316f57cc8b391258dfdab752aa6d9a17149ef30455792c780730969a3\",\"firstViolatedAxis\":\"bytes\",\"inventoryId\":\"muse-candidate-inventory:sha256:3d17b2a90fe7d5e3f18b12d5552b4b79fe1fb7fb5436d6e127769de86f0868ae\",\"minimumRequired\":{\"maxEstimatedTokens\":154,\"maxOutputBytes\":615},\"mode\":\"invalid-input\",\"reasonId\":\"minimum-abstention-exceeds-budget\",\"schemaVersion\":1}",
    "bytes-exact": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":9,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:3f77f6bd57ee68dd0b7cf3b0d58ead3341f343288acc7a52adde04167b6a1ef3\",\"ledgerId\":\"muse-candidate-ledger:sha256:2db0f938a76f71740ec511848b289917462565136e31a0d7c8c41d1293fd5d8e\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "bytes-over": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":9,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:de9b669d4be5db75c5884198c76d6588373eaf21e5ed9da4122d954ee624b1df\",\"ledgerId\":\"muse-candidate-ledger:sha256:dd98e632d212e5426ec850cadcd82b6bd4e87fd54b545d3f64d215146d0376c4\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "token-under": "{\"errorId\":\"muse-candidate-capacity-error:sha256:a05b3e143dcb0048b49618034ae78675b11671525620e69ff4a8940ae1d943a2\",\"firstViolatedAxis\":\"token\",\"inventoryId\":\"muse-candidate-inventory:sha256:383f7e5f0e3a867ef88bcb288efe4cbe459bf49b92889ec6709bdd9305dd08ae\",\"minimumRequired\":{\"maxEstimatedTokens\":154,\"maxOutputBytes\":615},\"mode\":\"invalid-input\",\"reasonId\":\"minimum-abstention-exceeds-budget\",\"schemaVersion\":1}",
    "token-exact": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":9,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:3f3f663eaa4c510705d5a879df2acfe5464aab69681b4b415eb9b861143c6855\",\"ledgerId\":\"muse-candidate-ledger:sha256:5567e9e68981d376cc67ab8a7ad653620e7b719109697ce704b0e76d3bcf1272\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "token-over": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":9,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:f9e76694eff5421483e6c2778571df1b26d9571dee5391d128763fe543f71297\",\"ledgerId\":\"muse-candidate-ledger:sha256:027464be440a78f60156c25131f61e4d0f0e38ae134614a64c26b9c9ae35773c\",\"mode\":\"normal\",\"schemaVersion\":1}",
  },
  10: {
    "bytes-under": "{\"errorId\":\"muse-candidate-capacity-error:sha256:a8b267d5dcc60fd33fe56b9a14fd848d37a63c91cd065205b160a92f68e936e8\",\"firstViolatedAxis\":\"bytes\",\"inventoryId\":\"muse-candidate-inventory:sha256:817f60c73a157065dc9a7e6d6ae3a2d6fef07ab536074984650327f39c76e920\",\"minimumRequired\":{\"maxEstimatedTokens\":154,\"maxOutputBytes\":615},\"mode\":\"invalid-input\",\"reasonId\":\"minimum-abstention-exceeds-budget\",\"schemaVersion\":1}",
    "bytes-exact": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":10,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:8a2b1926ffb6323080fea5eb4fcfdad260b284765c23677e11d49da47b5b3238\",\"ledgerId\":\"muse-candidate-ledger:sha256:8e7d376c131f0a7e2c549d4359b202c3f4dc33a127a1068bc6db0598d3a6e81d\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "bytes-over": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":10,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:97e59aa5c0046d00beffc3b1052f2d764cf13bd43a6004de6509f4bc6dd82b70\",\"ledgerId\":\"muse-candidate-ledger:sha256:509d22237dd4e4bd16bacfe739bf38689045651ecf9de5b24a4525d40baa319a\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "token-under": "{\"errorId\":\"muse-candidate-capacity-error:sha256:a93ca6c6c741a9fba130a5feab3398f5f806db9fd8c3d50d75e12888f2e8aea8\",\"firstViolatedAxis\":\"token\",\"inventoryId\":\"muse-candidate-inventory:sha256:ccf4067cff3d3ceecae6fa068bcaa518e8e476fbeb30f4ee25fe87a29df44dc2\",\"minimumRequired\":{\"maxEstimatedTokens\":154,\"maxOutputBytes\":615},\"mode\":\"invalid-input\",\"reasonId\":\"minimum-abstention-exceeds-budget\",\"schemaVersion\":1}",
    "token-exact": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":10,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:87f4b17119b615afb61c563851086794c3dacba7528fee3368aa5e6cb2d0171a\",\"ledgerId\":\"muse-candidate-ledger:sha256:c90964c38c5910803bc279edcf141ced307a45d90470afda587c343e8bdfd19c\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "token-over": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":10,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:672603ec7ca83bde07612e908aa7754df97ab9632fb999f869770d90d0a784e4\",\"ledgerId\":\"muse-candidate-ledger:sha256:2dca61ef2303cfc21cbf2dc5ea50e68f901572954964ccdcd71daad1ea97125a\",\"mode\":\"normal\",\"schemaVersion\":1}",
  },
  99: {
    "bytes-under": "{\"errorId\":\"muse-candidate-capacity-error:sha256:55867259e115418047f26b54ea67a31560c8e54c67490c83db93a54caeff7fcc\",\"firstViolatedAxis\":\"bytes\",\"inventoryId\":\"muse-candidate-inventory:sha256:5183058fd804f712fb707df4c6d8a05936969996a08637b8e819d1a26b3f9b1a\",\"minimumRequired\":{\"maxEstimatedTokens\":154,\"maxOutputBytes\":615},\"mode\":\"invalid-input\",\"reasonId\":\"minimum-abstention-exceeds-budget\",\"schemaVersion\":1}",
    "bytes-exact": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":99,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:091a11cf5929ff8efbe6d18cfb399618f8c1c05b26b2d3c6906e63a0f35226a7\",\"ledgerId\":\"muse-candidate-ledger:sha256:a27d43c48fc8479a8e1ef2c6bc02672ecc415453a3f61fbf786bd26d9783b638\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "bytes-over": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":99,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:d022dd7b078a19d64a2196c7cb3506bb4cd549996b3a6626b7f98ec6df0b4763\",\"ledgerId\":\"muse-candidate-ledger:sha256:acd7008cfd78d48a5bf4f85ef747e44abc94b367b829c186f9dc7d46848e85e3\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "token-under": "{\"errorId\":\"muse-candidate-capacity-error:sha256:114828d27ee1566f59ad09db44f512803558d033d402ef43038ba42d6468b099\",\"firstViolatedAxis\":\"token\",\"inventoryId\":\"muse-candidate-inventory:sha256:5c642b2716c9ce0d7d25e6739d59a6d224c2ddc560912a53523639ff539e2edb\",\"minimumRequired\":{\"maxEstimatedTokens\":154,\"maxOutputBytes\":615},\"mode\":\"invalid-input\",\"reasonId\":\"minimum-abstention-exceeds-budget\",\"schemaVersion\":1}",
    "token-exact": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":99,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:ce08b69856b722c45e30b7c73c7919aac69e5952d8d28c411efd4dbe98991829\",\"ledgerId\":\"muse-candidate-ledger:sha256:f6f39e143cad99b45f88806457b1cce8a0c938ba4c5746d2bfd4bad82a137f07\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "token-over": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":99,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:8691bcb74cf2f221567a1a4bfc156a54157e9eb1d70fcae5e991c923c2ca1d5f\",\"ledgerId\":\"muse-candidate-ledger:sha256:0fe7b39194b283f150846cdd54f23557b9b4c61ea26d843438b1af10a04ac38f\",\"mode\":\"normal\",\"schemaVersion\":1}",
  },
  100: {
    "bytes-under": "{\"errorId\":\"muse-candidate-capacity-error:sha256:91391b01d5292bdd0f0cd2bef56fda13ea730a0250c1dd77019894cd0a92b9fe\",\"firstViolatedAxis\":\"bytes\",\"inventoryId\":\"muse-candidate-inventory:sha256:a42e8456b52fba30ceb4ef220abca945649cc9ee088b67df6efa2ec948eace00\",\"minimumRequired\":{\"maxEstimatedTokens\":154,\"maxOutputBytes\":615},\"mode\":\"invalid-input\",\"reasonId\":\"minimum-abstention-exceeds-budget\",\"schemaVersion\":1}",
    "bytes-exact": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":100,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:4c2e5572c4abd3270cc08de8560f98b71a95e7dcf0035ca6d3a18778be9ee39d\",\"ledgerId\":\"muse-candidate-ledger:sha256:ce2e7eeeda90904c297c5573a2f9bfe55f2ee65f76c476bd409fd3a51bf847b2\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "bytes-over": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":100,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:e052620fcadcfdb053f11bd21f2d878c358fb6227d192821c0a60f614663d7d3\",\"ledgerId\":\"muse-candidate-ledger:sha256:05eb2540a91246c010af6ce1af5034589939ba2ff5e478c2cbb4537fa72637a0\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "token-under": "{\"errorId\":\"muse-candidate-capacity-error:sha256:7dffb77b0fcd7bcec16037b7d2d440046f5eb44f1136a4c8a49fefb3033c7c97\",\"firstViolatedAxis\":\"token\",\"inventoryId\":\"muse-candidate-inventory:sha256:bb316510602ecae5f0b7f68e35bba982b4d2ece710e9b3e2d6cb20fc5f13f01a\",\"minimumRequired\":{\"maxEstimatedTokens\":154,\"maxOutputBytes\":615},\"mode\":\"invalid-input\",\"reasonId\":\"minimum-abstention-exceeds-budget\",\"schemaVersion\":1}",
    "token-exact": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":100,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:0e535e9b063ae6719af3305e6f433d6772e4aac5466e27276147781c0865daae\",\"ledgerId\":\"muse-candidate-ledger:sha256:e9874818a8787f8119b6a95f7b3aba253ce06873733b46b254b83823e82d3d74\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "token-over": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":100,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:48dd7d1864b3716799a6d53f8d85b0d897821eff5ee49e7a0137f79d126e874b\",\"ledgerId\":\"muse-candidate-ledger:sha256:47adf5549d6b29ffd3d5f082f9bcf84f25230ba390b3347621e4e77a065ddb5f\",\"mode\":\"normal\",\"schemaVersion\":1}",
  },
} as const;
const capacityVariantDiscriminants = {
  "bytes-under": "invalid-input",
  "bytes-exact": "settled",
  "bytes-over": "settled",
  "token-under": "invalid-input",
  "token-exact": "settled",
  "token-over": "settled",
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
      try { settleCandidateInventory(hostile); throw new Error("expected AWG-045a rejection"); } catch (error) { expect(error).not.toBeInstanceOf(CandidateSettlementError); }
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
    const coreOnly = settled(makeRequest(candidates, eligible("core", "core"), { maxOutputBytes: 800 }));
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
      expect(expectLiteralEnvelope(baseInventoryCanonicalJson[considered], "muse.attunement-graph.candidate-inventory.v1", "inventoryId", "muse-candidate-inventory:sha256:").inventoryId).toBe(baseInventoryIds[considered]);
      expect(base.ledger.inventoryId).toBe(baseInventoryIds[considered]);
      expect(base.canonicalByteLength).toBe(literal.bytes);
      expect(base.ledger.ledgerId).toBe(literal.id);
      expect(base.canonicalJson).toBe(baseLedgerCanonicalJson[considered]);
      expect(Buffer.byteLength(base.canonicalJson)).toBe(literal.bytes);
      expect(expectLiteralEnvelope(baseLedgerCanonicalJson[considered], "muse.attunement-graph.candidate-settlement-ledger.v1", "ledgerId", "muse-candidate-ledger:sha256:")).toEqual(base.ledger);
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
          expect(expectLiteralEnvelope(canonicalJson, "muse.attunement-graph.candidate-settlement-ledger.v1", "ledgerId", "muse-candidate-ledger:sha256:")).toEqual(actual.ledger);
          expect(actual.totalOutputBytes).toBe(actual.canonicalByteLength);
          expect(actual.estimatedTokens).toBe(Math.ceil(actual.canonicalByteLength / 4));
          expect(actual.ledger.entries).toEqual([{ candidateId: "core", role: "core", terminalState: "admitted" }]);
          expect(actual.ledger.counters).toMatchObject({ admitted: 1, candidateCount: 1, consideredAssertions: considered });
        } else {
          expect(expectLiteralEnvelope(canonicalJson, "muse.attunement-graph.candidate-settlement-capacity-error.v1", "errorId", "muse-candidate-capacity-error:sha256:")).toEqual(actual.error);
          expect(actual.error.firstViolatedAxis).toBe(name.startsWith("bytes") ? "bytes" : "token");
          expect(actual.error.minimumRequired).toEqual({ maxEstimatedTokens: 154, maxOutputBytes: 615 });
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
  });
});
