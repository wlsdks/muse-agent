import type { AgentRunInput, AgentRunResult, AgentRuntime } from "@muse/agent-core";
import {
  createToolExposureAuthority,
  PERSONAL_WORK_CAPABILITY_PROFILE_ID,
  resolveToolExposureAuthority
} from "@muse/policy";
import { describe, expect, it } from "vitest";

import {
  createCascadeRuntimeAgentWorker,
  createDelegationHandoffLease,
  createRuntimeAgentWorker,
  InMemoryBackgroundOrchestrationStore,
  MultiAgentOrchestrator,
  OrchestrationCancelledError,
  SupervisorAgent
} from "../src/index.js";

function captureRuntime(confidence: Readonly<Record<string, number>> = {}) {
  const inputs: AgentRunInput[] = [];
  const runtime = {
    run: async (input: AgentRunInput): Promise<AgentRunResult> => {
      inputs.push(input);
      return {
        response: {
          id: `response-${inputs.length.toString()}`,
          logprobs: [{ logprob: confidence[input.model] ?? -0.1, token: "x" }],
          model: input.model,
          output: `ran on ${input.model}`,
          raw: {}
        },
        runId: input.runId ?? "run"
      };
    }
  } as unknown as AgentRuntime;
  return { inputs, runtime };
}

const input: AgentRunInput = {
  messages: [{ content: "Original system", role: "system" }, { content: "Do the work", role: "user" }],
  metadata: { parent: "root" },
  model: "ollama/default",
  runId: "run-1"
};

describe("shared runtime delegation workers", () => {
  it("binds a handoff subtask scope into the opaque child authority", async () => {
    const capture = captureRuntime();
    const parentAuthority = createToolExposureAuthority({
      allowedToolNames: ["file_read", "file_write"],
      localMode: true,
      writablePaths: ["/workspace/muse/reports"]
    });
    const handoff = {
      contextIndependent: true,
      decomposition: "fanout" as const,
      mergeable: true,
      objective: "Compare reports",
      schemaVersion: 1 as const,
      sharedState: false,
      subtasks: ["s1", "s2"].map((id) => ({
        allowedToolNames: ["file_read", "file_write", "external_send"],
        dependsOn: [],
        effectScopes: [],
        expiresAt: "2099-07-30T00:00:00.000Z",
        id,
        input: id,
        outputSchema: "text",
        role: "worker",
        writablePaths: [`reports/${id}`]
      }))
    };
    const lease = createDelegationHandoffLease(
      handoff,
      "s1",
      "/workspace/muse",
      "2026-07-29T00:00:00.000Z"
    );
    const worker = createRuntimeAgentWorker({
      delegationLease: lease,
      runtime: capture.runtime,
      spec: { description: "scoped", id: "scoped", toolNames: ["file_write", "external_send"] }
    });

    expect(() => worker.run({
      ...input,
      runId: "run-direct-first",
      toolExposureAuthority: parentAuthority
    })).toThrow(/central dispatch gate/u);
    expect(capture.inputs).toHaveLength(0);

    await new MultiAgentOrchestrator({ workers: [worker] }).run({
      ...input,
      toolExposureAuthority: parentAuthority
    });

    expect(resolveToolExposureAuthority(capture.inputs[0]?.toolExposureAuthority)).toMatchObject({
      allowedToolNames: ["file_write"],
      expiresAt: "2099-07-30T00:00:00.000Z",
      writablePaths: ["/workspace/muse/reports/s1"]
    });
    await expect(new SupervisorAgent({ maxHandoffs: 0, workers: [worker] }).run({
      ...input,
      runId: "run-replayed-lease",
      toolExposureAuthority: parentAuthority
    })).rejects.toThrow(/already consumed/u);
    expect(capture.inputs).toHaveLength(1);
    expect(() => worker.run({ ...input, runId: "run-direct-replay" })).toThrow(/already consumed/u);

    const liveLease = createDelegationHandoffLease(
      handoff,
      "s2",
      "/workspace/muse",
      "2026-07-29T00:00:00.000Z"
    );
    expect(() => createRuntimeAgentWorker({
      delegationLease: { ...liveLease },
      runtime: capture.runtime,
      spec: { description: "forged", id: "forged" }
    })).toThrow(/invalid or forged/u);
    expect(capture.inputs).toHaveLength(1);
  });

  it("does not burn a delegated lease when cancellation wins before worker start", async () => {
    const capture = captureRuntime();
    const handoff = {
      contextIndependent: true,
      decomposition: "fanout" as const,
      mergeable: true,
      objective: "Cancellation lease fixture",
      schemaVersion: 1 as const,
      sharedState: false,
      subtasks: ["s1", "s2"].map((id) => ({
        allowedToolNames: ["file_read"],
        dependsOn: [],
        effectScopes: [],
        expiresAt: "2099-07-30T00:00:00.000Z",
        id,
        input: id,
        outputSchema: "text",
        role: "worker",
        writablePaths: [`reports/${id}`]
      }))
    };
    const worker = createRuntimeAgentWorker({
      delegationLease: createDelegationHandoffLease(
        handoff,
        "s1",
        "/workspace/muse",
        "2026-07-29T00:00:00.000Z"
      ),
      runtime: capture.runtime,
      spec: { description: "cancel-safe", id: "cancel-safe" }
    });
    const controller = new AbortController();
    controller.abort();

    await expect(new SupervisorAgent({ maxHandoffs: 0, workers: [worker] }).run({
      ...input,
      runId: "run-cancelled-before-lease",
      signal: controller.signal
    })).rejects.toBeInstanceOf(OrchestrationCancelledError);
    expect(capture.inputs).toHaveLength(0);

    await new SupervisorAgent({ maxHandoffs: 0, workers: [worker] }).run({
      ...input,
      runId: "run-after-cancelled-lease"
    });
    expect(capture.inputs).toHaveLength(1);
  });

  it("fails closed when a custom worker supplies only half of a delegated write scope", async () => {
    const parentAuthority = createToolExposureAuthority({
      allowedToolNames: ["file_write"],
      localMode: true
    });
    for (const partial of [
      { writablePaths: ["/workspace/reports"] },
      { scopeExpiresAt: "2099-07-30T00:00:00.000Z" }
    ]) {
      const capture = captureRuntime();
      const worker = {
        canHandle: () => 1,
        description: "incomplete",
        id: "incomplete",
        run: (workerInput: AgentRunInput) => capture.runtime.run(workerInput),
        toolNames: ["file_write"],
        ...partial
      };
      await new MultiAgentOrchestrator({ workers: [worker] }).run({
        ...input,
        toolExposureAuthority: parentAuthority
      });
      expect(resolveToolExposureAuthority(capture.inputs[0]?.toolExposureAuthority)?.allowedToolNames).toEqual([]);
    }
  });

  it("preserves undefined versus empty AgentSpec tool limits and attenuates parent authority at dispatch", async () => {
    const parentAuthority = createToolExposureAuthority({
      allowedToolNames: ["safe.read", "parent.only"],
      localMode: true,
      profileId: PERSONAL_WORK_CAPABILITY_PROFILE_ID
    });
    const cases = [
      { expected: ["safe.read", "parent.only"], id: "unrestricted", toolNames: undefined },
      { expected: ["safe.read"], id: "restricted", toolNames: ["safe.read", "child.only"] },
      { expected: [], id: "zero", toolNames: [] }
    ] as const;

    for (const entry of cases) {
      const capture = captureRuntime();
      const worker = createRuntimeAgentWorker({
        runtime: capture.runtime,
        spec: {
          description: entry.id,
          id: entry.id,
          ...(entry.toolNames !== undefined ? { toolNames: entry.toolNames } : {})
        }
      });
      expect(worker.toolNames).toEqual(entry.toolNames);
      await new MultiAgentOrchestrator({ workers: [worker] }).run({ ...input, toolExposureAuthority: parentAuthority });
      expect(resolveToolExposureAuthority(capture.inputs[0]?.toolExposureAuthority)?.allowedToolNames).toEqual(entry.expected);
      expect(resolveToolExposureAuthority(capture.inputs[0]?.toolExposureAuthority)).toMatchObject({
        localMode: true,
        profileId: PERSONAL_WORK_CAPABILITY_PROFILE_ID
      });
    }

    const capture = captureRuntime();
    const safeDefaultWorker = createRuntimeAgentWorker({
      runtime: capture.runtime,
      spec: { description: "safe default", id: "safe-default" }
    });
    await new MultiAgentOrchestrator({ workers: [safeDefaultWorker] }).run(input);
    expect(capture.inputs[0]?.toolExposureAuthority).toBeUndefined();
  });

  it("uses the same attenuation gate for every orchestrator mode and background dispatch", async () => {
    const parentAuthority = createToolExposureAuthority({
      allowedToolNames: ["safe.read", "parent.only"],
      localMode: true,
      profileId: PERSONAL_WORK_CAPABILITY_PROFILE_ID
    });

    for (const mode of ["sequential", "parallel", "race"] as const) {
      const capture = captureRuntime();
      const worker = createRuntimeAgentWorker({
        runtime: capture.runtime,
        spec: { description: mode, id: mode, toolNames: ["safe.read", "child.only"] }
      });
      await new MultiAgentOrchestrator({ workers: [worker] }).run(
        { ...input, runId: `run-${mode}`, toolExposureAuthority: parentAuthority },
        { mode }
      );
      expect(resolveToolExposureAuthority(capture.inputs[0]?.toolExposureAuthority)?.allowedToolNames).toEqual(["safe.read"]);
    }

    const capture = captureRuntime();
    const worker = createRuntimeAgentWorker({
      runtime: capture.runtime,
      spec: { description: "background", id: "background", toolNames: ["safe.read", "child.only"] }
    });
    const store = new InMemoryBackgroundOrchestrationStore();
    new MultiAgentOrchestrator({ workers: [worker] }).runBackground(
      { ...input, runId: "run-background-authority", toolExposureAuthority: parentAuthority },
      {},
      store
    );
    await expect.poll(() => store.get("run-background-authority")?.status).toBe("completed");
    expect(resolveToolExposureAuthority(capture.inputs[0]?.toolExposureAuthority)?.allowedToolNames).toEqual(["safe.read"]);
  });

  it("attenuates both the initial and fallback SupervisorAgent dispatch", async () => {
    const observed: AgentRunInput[] = [];
    const first = createRuntimeAgentWorker({
      runtime: {
        run: async (workerInput: AgentRunInput): Promise<AgentRunResult> => {
          observed.push(workerInput);
          throw new Error("force fallback");
        }
      } as unknown as AgentRuntime,
      spec: { description: "first", id: "a-first", toolNames: ["safe.read", "first.only"] }
    });
    const fallbackCapture = captureRuntime();
    const fallback = createRuntimeAgentWorker({
      runtime: fallbackCapture.runtime,
      spec: { description: "fallback", id: "z-fallback", toolNames: ["safe.read", "fallback.only"] }
    });
    const parentAuthority = createToolExposureAuthority({
      allowedToolNames: ["safe.read", "parent.only"],
      localMode: true,
      profileId: PERSONAL_WORK_CAPABILITY_PROFILE_ID
    });

    await new SupervisorAgent({ maxHandoffs: 1, workers: [first, fallback] }).run({
      ...input,
      toolExposureAuthority: parentAuthority
    });

    for (const workerInput of [observed[0], fallbackCapture.inputs[0]]) {
      expect(resolveToolExposureAuthority(workerInput?.toolExposureAuthority)).toMatchObject({
        allowedToolNames: ["safe.read"],
        localMode: true,
        profileId: PERSONAL_WORK_CAPABILITY_PROFILE_ID
      });
    }
  });

  it("routes a spec worker through AgentRuntime with the orchestrator model, prompt, and metadata", async () => {
    const capture = captureRuntime();
    const worker = createRuntimeAgentWorker({
      model: "ollama/worker",
      runtime: capture.runtime,
      spec: { description: "Research", id: "researcher", specId: "spec-1", systemPrompt: "Worker system" }
    });
    await new MultiAgentOrchestrator({ workers: [worker] }).run(input);

    expect(capture.inputs).toHaveLength(1);
    expect(capture.inputs[0]?.model).toBe("ollama/worker");
    expect(capture.inputs[0]?.messages[0]).toEqual({ content: "Worker system\n\nOriginal system", role: "system" });
    expect(capture.inputs[0]?.metadata).toEqual({ agentSpecId: "spec-1", parent: "root", selectedAgentId: "researcher" });
  });

  it("keeps cascade routing bounded to fast then heavy on low confidence", async () => {
    const capture = captureRuntime({ "ollama/fast": -2, "ollama/heavy": -0.1 });
    const worker = createCascadeRuntimeAgentWorker({
      confidenceOf: (result) => result.response.logprobs?.[0]?.logprob,
      fastModel: "ollama/fast",
      heavyModel: "ollama/heavy",
      runtime: capture.runtime,
      spec: { description: "Lookup", id: "lookup", specId: "spec-2" }
    });
    const result = await worker.run(input);

    expect(capture.inputs.map((entry) => entry.model)).toEqual(["ollama/fast", "ollama/heavy"]);
    expect(capture.inputs.every((entry) => entry.logprobs === true)).toBe(true);
    expect(result.response.model).toBe("ollama/heavy");
  });

  it("does not call the heavy route when the fast response is confident", async () => {
    const capture = captureRuntime({ "ollama/fast": -0.2 });
    const worker = createCascadeRuntimeAgentWorker({
      confidenceOf: (result) => result.response.logprobs?.[0]?.logprob,
      fastModel: "ollama/fast",
      heavyModel: "ollama/heavy",
      runtime: capture.runtime,
      spec: { description: "Lookup", id: "lookup" }
    });
    await worker.run(input);

    expect(capture.inputs.map((entry) => entry.model)).toEqual(["ollama/fast"]);
  });
});
