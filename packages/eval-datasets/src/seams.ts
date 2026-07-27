import { prepareContinuityReview, type AttunementState } from "@muse/attunement";
import { InMemoryUserMemoryStore, normalizeMemoryKey, trimConversationMessages, type ConversationMessage } from "@muse/memory";
import { evaluateProgressiveAutonomy, type ProgressiveAutonomyActionEnvelope } from "@muse/policy";
import { prepareGroundedRecall, reindexNotes } from "@muse/recall";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SYNTHETIC_PROVENANCE, type EvalRecord, type Family } from "./index.js";

export type FamilyExecutionCounters = {
  generated: number;
  serialized: number;
  parsedAndSchemaValidated: number;
  namedPublicMuseSeamExecuted: number;
  terminalInvariantPassed: number;
  llmCalls: 0;
  toolCalls: 0;
  networkCalls: 0;
};

export type SeamExecutionResult = {
  dataOrigin: "synthetic";
  organicEvidence: false;
  personalLearningEligible: false;
  humanOutcome: false;
  heldOut: false;
  evidenceClass: "controlled-synthetic-corpus-integrity";
  robustnessReplay: boolean;
  familyCounters: Record<Family, FamilyExecutionCounters>;
  executed: number;
  passed: number;
  llmCalls: 0;
  toolCalls: 0;
  networkCalls: 0;
  temporaryBytesPeak: number;
};

function emptyCounter(): FamilyExecutionCounters {
  return {
    generated: 0,
    serialized: 0,
    parsedAndSchemaValidated: 0,
    namedPublicMuseSeamExecuted: 0,
    terminalInvariantPassed: 0,
    llmCalls: 0,
    toolCalls: 0,
    networkCalls: 0,
  };
}

async function directoryBytes(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    total += entry.isDirectory() ? await directoryBytes(child) : (await stat(child)).size;
  }
  return total;
}

async function executeRecall(record: Extract<EvalRecord, { family: "recall-correction" | "absent-abstention" }>, runDir: string): Promise<number> {
  const recordDir = resolve(runDir, record.recordId);
  const notesDir = resolve(recordDir, "notes");
  const notesIndexFile = resolve(recordDir, "notes-index.json");
  const embedModel = "eval-deterministic-v1";
  const topK = 2;
  await mkdir(notesDir, { recursive: true, mode: 0o700 });
  try {
    if (record.family === "recall-correction") {
      await writeFile(resolve(notesDir, "a-current.md"), record.payload.current, { mode: 0o600 });
      await writeFile(resolve(notesDir, "b-stale.md"), record.payload.stale, { mode: 0o600 });
    } else {
      await writeFile(resolve(notesDir, "a-corpus.md"), record.payload.corpus, { mode: 0o600 });
    }
    const vector = (text: string): number[] => {
      if (text === record.payload.query) return [1, 0];
      if (record.family === "recall-correction" && (text.includes(record.payload.current) || text.includes(record.payload.stale))) return [1, 0];
      return [0, 1];
    };
    const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as { prompt?: string } : {};
      return new Response(JSON.stringify({ embedding: vector(body.prompt ?? "") }), { status: 200, headers: { "content-type": "application/json" } });
    };
    await reindexNotes({
      dir: notesDir,
      model: embedModel,
      force: true,
      indexPath: notesIndexFile,
      fetchImpl,
      baseUrlResolver: () => "http://eval.invalid",
    });
    const prepared = await prepareGroundedRecall({
      query: record.payload.query,
      sources: { notesDir, notesIndexFile },
      options: { embedModel, topK, scope: undefined, conflictAwareSelection: true },
      embedFn: async (text) => vector(text),
    });
    if (record.family === "absent-abstention") {
      if (prepared.verdict === "confident") throw new Error(`Recall abstention invariant failed: ${prepared.verdict}`);
    } else {
      const current = prepared.scored.findIndex((item) => item.chunk.text.includes(record.payload.current));
      const stale = prepared.scored.findIndex((item) => item.chunk.text.includes(record.payload.stale));
      if (current < 0 || stale < 0 || current >= stale) {
        throw new Error(`Recall correction invariant failed: ${JSON.stringify({ verdict: prepared.verdict, scored: prepared.scored.map((item) => ({ file: item.file, score: item.score })) })}`);
      }
    }
    return await directoryBytes(recordDir);
  } finally {
    await rm(recordDir, { recursive: true, force: true });
  }
}

async function executeContinuity(record: Extract<EvalRecord, { family: "continuity" }>): Promise<boolean> {
  const openedAt = "2040-01-02T09:00:00.000Z";
  const threadId = `thread-${record.contentHash.slice(0, 16)}`;
  const artifactId = `task-${record.contentHash.slice(16, 32)}`;
  const link = {
    artifactId,
    artifactType: "task" as const,
    providerId: "local",
    role: "next-step" as const,
    linkedAt: "2040-01-01T09:00:00.000Z",
    linkedBy: "user" as const,
    threadId,
  };
  const state: AttunementState = {
    schemaVersion: 3,
    nextPolicyVersion: 1,
    threads: [{
      id: threadId,
      kind: record.sequence % 2 === 0 ? "work" : "life",
      title: record.payload.threadTitle,
      createdAt: "2040-01-01T08:00:00.000Z",
      links: [link],
      policy: { version: 0, detail: "standard", nextStep: "direct", suppression: "none" },
    }],
    deliveries: [{
      id: `delivery-${record.contentHash.slice(32, 48)}`,
      evidenceClass: "controlled",
      evidenceRefs: [{ artifactId, artifactType: "task", providerId: "local", role: "next-step" }],
      openedAt,
      policyVersion: 0,
      threadId,
    }],
    interactionReceipts: [],
    resetReceipts: [],
    undoResetReceipts: [],
  };
  const review = await prepareContinuityReview(state, async () => ({
    artifactId,
    artifactType: "task",
    providerId: "local",
    role: "next-step",
    title: record.payload.artifactTitle,
    taskStatus: "open",
  }));
  return record.expected.terminal === "controlled-excluded-from-next"
    && review.progress.target === 20
    && review.progress.eligibleDeliveries === 0
    && review.next === undefined;
}

function executeMemory(record: Extract<EvalRecord, { family: "memory-preference-veto-correction" }>): boolean {
  const store = new InMemoryUserMemoryStore();
  const userId = `fictional-user-${record.contentHash.slice(0, 12)}`;
  const { key, existing, incoming, operation } = record.payload;
  const storedKey = normalizeMemoryKey(key);
  if (operation !== "add") store.upsertPreference(userId, key, existing);
  switch (operation) {
    case "add":
    case "update":
      store.upsertPreference(userId, key, incoming);
      return store.findByUserId(userId)?.preferences[storedKey] === incoming;
    case "noop":
      store.upsertPreference(userId, key, existing);
      return store.findByUserId(userId)?.preferences[storedKey] === existing;
    case "delete":
      return store.forgetByCanonicalKey(userId, key, "preference") && store.findByUserId(userId)?.preferences[storedKey] === undefined;
  }
}

function executePolicy(record: Extract<EvalRecord, { family: "tool-policy-approval" }>): boolean {
  const stamp = "2040-01-01T00:00:00.000Z";
  const envelope: ProgressiveAutonomyActionEnvelope = {
    action: record.payload.action,
    idempotencyKey: `idempotency-${record.contentHash.slice(0, 16)}`,
    link: {
      artifactType: "task",
      linkedAt: stamp,
      providerId: "local",
      role: "next-step",
      taskId: `task-${record.contentHash.slice(16, 32)}`,
    },
    schemaVersion: 1,
    threadId: `thread-${record.contentHash.slice(32, 48)}`,
    traceId: `trace-${record.contentHash.slice(48, 64)}`,
    transition: { from: "open", to: "done" },
    userId: `fictional-user-${record.contentHash.slice(0, 12)}`,
  };
  const status = record.payload.authorityStatus === "valid" ? "exact" : record.payload.authorityStatus === "missing" ? "missing" : record.payload.authorityStatus === "revoked" ? "corrupt" : "mismatch";
  const decision = evaluateProgressiveAutonomy({
    authorityStatus: status,
    envelope,
    executorVersion: 1,
    hardDeny: record.payload.hardDeny,
    mode: "live",
    now: new Date(stamp),
    policyVersion: 1,
    remainingUses: 0,
  });
  return decision.enforcementDecision === "deny";
}

function executeContext(record: Extract<EvalRecord, { family: "context-stress" }>): boolean {
  const messages: ConversationMessage[] = record.payload.messages.map((content, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content,
  }));
  const result = trimConversationMessages(messages, {
    maxContextWindowTokens: record.payload.maxContextWindowTokens,
    outputReserveTokens: record.payload.outputReserveTokens,
    insertSummary: false,
  });
  const withinBudget = result.estimatedTokens <= result.budgetTokens;
  const actuallyTrimmed = result.removedCount > 0 && result.messages.length < messages.length;
  return withinBudget && (record.expected.trimmingRequired ? actuallyTrimmed : true);
}

async function executeRecord(record: EvalRecord, runDir: string): Promise<number> {
  switch (record.family) {
    case "recall-correction":
    case "absent-abstention": return executeRecall(record, runDir);
    case "continuity": if (await executeContinuity(record)) return 0; break;
    case "memory-preference-veto-correction": if (executeMemory(record)) return 0; break;
    case "tool-policy-approval": if (executePolicy(record)) return 0; break;
    case "context-stress": if (executeContext(record)) return 0; break;
  }
  throw new Error(`Public seam terminal invariant failed for ${record.recordId}`);
}

export async function executeStratifiedPublicSeams(sample: readonly EvalRecord[], familyTotals: Readonly<Record<Family, number>>, cwd = process.cwd(), runtimeRoot?: string): Promise<SeamExecutionResult> {
  if (sample.length > 192) throw new Error(`Runtime sample exceeds 192: ${sample.length}`);
  const robustnessReplay = sample[0]?.robustnessReplay ?? false;
  if (sample.some((record) => record.robustnessReplay !== robustnessReplay)) throw new Error("Public-seam sample mixes main and robustness-replay provenance");
  const familyCounters = Object.fromEntries(Object.keys(familyTotals).map((family) => [family, emptyCounter()])) as Record<Family, FamilyExecutionCounters>;
  for (const family of Object.keys(familyTotals) as Family[]) {
    familyCounters[family].generated = familyTotals[family];
    familyCounters[family].serialized = familyTotals[family];
    familyCounters[family].parsedAndSchemaValidated = familyTotals[family];
  }
  let passed = 0;
  let temporaryBytesPeak = 0;
  const runDir = resolve(runtimeRoot ?? resolve(cwd, ".muse-dev", "eval-data", "v1", String(sample[0]?.tier ?? "empty")), `.public-seams-${process.pid}-${Date.now()}`);
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  try {
    for (const record of sample) {
      temporaryBytesPeak = Math.max(temporaryBytesPeak, await executeRecord(record, runDir));
      familyCounters[record.family].namedPublicMuseSeamExecuted += 1;
      familyCounters[record.family].terminalInvariantPassed += 1;
      passed += 1;
    }
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
  return {
    ...SYNTHETIC_PROVENANCE,
    robustnessReplay,
    familyCounters,
    executed: sample.length,
    passed,
    llmCalls: 0,
    toolCalls: 0,
    networkCalls: 0,
    temporaryBytesPeak,
  };
}
