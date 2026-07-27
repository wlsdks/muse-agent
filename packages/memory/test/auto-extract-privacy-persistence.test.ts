import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelProvider, ModelResponse } from "@muse/model";
import { describe, expect, it } from "vitest";

import {
  createUserMemoryAutoExtractHook,
  FileUserMemoryAutoExtractOutcomeStore,
  FileUserMemoryStore,
  readUserMemoryAutoExtractOutcomes
} from "../src/index.js";

const ALLOWED_DIAGNOSTIC_ENTRY_KEYS = [
  "reason",
  "recordedAt",
  "runIdHash",
  "schemaVersion"
] as const;

async function readableBytes(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const chunks: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      chunks.push(await readableBytes(path));
    } else if (entry.isFile()) {
      chunks.push(await readFile(path, "utf8"));
    } else {
      throw new Error(`unexpected diagnostic filesystem entry: ${path}`);
    }
  }
  return chunks.join("\n");
}

async function readJsonIfPresent(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function response(output: string): ModelResponse {
  return { id: "assistant-response", model: "privacy-test", output };
}

async function runFixture(options: {
  readonly assistantText: string;
  readonly extractedPayload: string;
  readonly privateSkip?: boolean;
  readonly runId: string;
  readonly userText: string;
}) {
  const directory = await mkdtemp(join(tmpdir(), "muse-auto-extract-privacy-"));
  const memoryFile = join(directory, "user-memory.json");
  const outcomesFile = join(directory, "memory-auto-extract-outcomes.json");
  let modelCalls = 0;
  const modelProvider: ModelProvider = {
    id: "privacy-test",
    async generate() {
      modelCalls += 1;
      return response(options.extractedPayload);
    },
    async listModels() {
      return [];
    },
    async *stream() {
      // Auto extraction uses generate only.
    }
  };
  const memoryStore = new FileUserMemoryStore({ file: memoryFile });
  const outcomeStore = new FileUserMemoryAutoExtractOutcomeStore({ file: outcomesFile });
  const hook = createUserMemoryAutoExtractHook({
    extractionCooldownMs: 0,
    model: "privacy-test",
    modelProvider,
    onOutcome: (outcome) => outcomeStore.record(outcome),
    store: memoryStore
  });

  await expect(hook.afterComplete?.(
    {
      input: {
        messages: [{ content: options.userText, role: "user" }],
        metadata: {
          skipUserMemoryAutoExtract: options.privateSkip === true,
          userId: "owner"
        }
      },
      runId: options.runId
    },
    response(options.assistantText)
  )).resolves.toBeUndefined();

  return {
    bytes: await readableBytes(directory),
    diagnostic: await readJsonIfPresent(outcomesFile),
    memory: await memoryStore.findByUserId("owner"),
    modelCalls,
    outcomes: await readUserMemoryAutoExtractOutcomes(outcomesFile)
  };
}

describe("automatic memory extraction privacy persistence", () => {
  it("writes nothing for a private/opted-out turn", async () => {
    const promptMarker = "PRIVATE_PROMPT_MARKER_056";
    const answerMarker = "PRIVATE_ANSWER_MARKER_056";
    const valueMarker = "PRIVATE_VALUE_MARKER_056";
    const runMarker = "PRIVATE_RUN_MARKER_056";
    const prompt = `Private prompt ${promptMarker}`;
    const answer = `Private answer ${answerMarker}`;
    const rawRunId = `run-${runMarker}`;
    const result = await runFixture({
      assistantText: answer,
      extractedPayload: JSON.stringify({
        facts: { private_value: valueMarker },
        goals: [],
        preferences: {},
        vetoes: []
      }),
      privateSkip: true,
      runId: rawRunId,
      userText: prompt
    });

    expect(result.modelCalls).toBe(0);
    expect(result.memory).toBeUndefined();
    expect(result.diagnostic).toBeUndefined();
    expect(result.outcomes).toEqual([]);
    for (const forbidden of [prompt, answer, valueMarker, rawRunId, promptMarker, answerMarker, runMarker]) {
      expect(result.bytes).not.toContain(forbidden);
    }
    expect(result.bytes).toBe("");
  });

  it("drops an ephemeral fact and persists only the allowed policy-rejection metadata", async () => {
    const promptMarker = "EPHEMERAL_PROMPT_MARKER_056";
    const answerMarker = "EPHEMERAL_ANSWER_MARKER_056";
    const valueMarker = "EPHEMERAL_VALUE_MARKER_056";
    const runMarker = "EPHEMERAL_RUN_MARKER_056";
    const ephemeralValue = `오늘 저녁 7시 ${valueMarker}`;
    const prompt = `Remember ${promptMarker}: ${ephemeralValue}`;
    const answer = `I will not retain ${answerMarker}`;
    const rawRunId = `run-${runMarker}`;
    const result = await runFixture({
      assistantText: answer,
      extractedPayload: JSON.stringify({
        facts: { meeting_time: ephemeralValue },
        goals: [],
        preferences: {},
        vetoes: []
      }),
      runId: rawRunId,
      userText: prompt
    });

    expect(result.modelCalls).toBe(1);
    expect(result.memory).toBeUndefined();
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.reason).toBe("policy_rejected");
    expect(Object.keys(result.outcomes[0] ?? {}).sort()).toEqual(ALLOWED_DIAGNOSTIC_ENTRY_KEYS);
    expect(Object.keys(result.diagnostic as object)).toEqual(["outcomes"]);
    const rawOutcomes = (result.diagnostic as { outcomes: object[] }).outcomes;
    expect(rawOutcomes).toHaveLength(1);
    expect(Object.keys(rawOutcomes[0] ?? {}).sort())
      .toEqual(ALLOWED_DIAGNOSTIC_ENTRY_KEYS);
    for (const forbidden of [prompt, answer, ephemeralValue, rawRunId, promptMarker, answerMarker, valueMarker, runMarker]) {
      expect(result.bytes).not.toContain(forbidden);
    }
  });

  it("drops model-only material and persists no prompt, answer, value, or raw run id", async () => {
    const promptMarker = "REQUEST_INPUT_SIGMA";
    const answerMarker = "ANSWER_BETA_ZETA";
    const valueMarker = "UNSUPPORTED_VALUE_OMEGA";
    const runMarker = "EXECUTION_ID_DELTA";
    const prompt = `Please answer without remembering this ${promptMarker}`;
    const answer = `The unsupported value is ${valueMarker}; ${answerMarker}`;
    const rawRunId = `run-${runMarker}`;
    const result = await runFixture({
      assistantText: answer,
      extractedPayload: JSON.stringify({
        facts: { unsupported_private_value: valueMarker },
        goals: [],
        preferences: {},
        vetoes: []
      }),
      runId: rawRunId,
      userText: prompt
    });

    expect(result.modelCalls).toBe(1);
    expect(result.memory).toBeUndefined();
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.reason).toBe("policy_rejected");
    expect(Object.keys(result.outcomes[0] ?? {}).sort()).toEqual(ALLOWED_DIAGNOSTIC_ENTRY_KEYS);
    expect(Object.keys(result.diagnostic as object)).toEqual(["outcomes"]);
    const rawOutcomes = (result.diagnostic as { outcomes: object[] }).outcomes;
    expect(rawOutcomes).toHaveLength(1);
    expect(Object.keys(rawOutcomes[0] ?? {}).sort())
      .toEqual(ALLOWED_DIAGNOSTIC_ENTRY_KEYS);
    for (const forbidden of [prompt, answer, valueMarker, rawRunId, promptMarker, answerMarker, runMarker]) {
      expect(result.bytes).not.toContain(forbidden);
    }
  });
});
