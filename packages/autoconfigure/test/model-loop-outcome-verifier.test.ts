import {
  createLoopControlReceipt,
  type LoopOutcomeToolEvidence,
  type LoopOutcomeVerificationInput
} from "@muse/agent-core";
import type { ModelRequest } from "@muse/model";
import { describe, expect, it, vi } from "vitest";

import {
  configuredModelLoopOutcomeVerifier,
  createModelLoopOutcomeVerifier
} from "../src/model-loop-outcome-verifier.js";

function input(toolEvidence: readonly LoopOutcomeToolEvidence[] = []): LoopOutcomeVerificationInput {
  return {
    loopControlReceipt: createLoopControlReceipt({
      budget: {
        retries: { limit: 1, used: 0 },
        steps: null,
        tools: { limit: 4, used: toolEvidence.length },
        wallclockLimitMs: 5_000
      },
      endedAt: "2026-07-30T12:00:01.000Z",
      loopKind: "react",
      runId: "judge-run",
      startedAt: "2026-07-30T12:00:00.000Z",
      terminal: { reason: "verification-pending", status: "held" },
      verification: { status: "pending" }
    }),
    model: "primary/model",
    output: "The requested brief is ready.",
    runId: "judge-run",
    signal: new AbortController().signal,
    toolEvidence,
    toolsUsed: toolEvidence.map((tool) => tool.toolName),
    userMessages: ["Create the brief."]
  };
}

function tool(overrides: Partial<LoopOutcomeToolEvidence> = {}): LoopOutcomeToolEvidence {
  return {
    risk: "read",
    status: "completed",
    toolCallId: "tool-1",
    toolName: "read_notes",
    ...overrides
  };
}

describe("model loop outcome verifier", () => {
  it("fails objective tool/effect violations before a judge model call", async () => {
    const generate = vi.fn(async () => ({
      id: "must-not-run",
      model: "judge/model",
      output: "{\"evidence\":[\"looks fine\"],\"verdict\":\"pass\"}"
    }));
    const verifier = createModelLoopOutcomeVerifier({
      model: "judge/model",
      modelProvider: { generate }
    });
    const unsafeEvidence = [
      tool({ status: "blocked" }),
      tool({ risk: "unknown" }),
      tool({ risk: "write", toolName: "write_note" }),
      tool({
        effectVerification: { reason: "post-condition missing", status: "unverified" },
        risk: "execute",
        toolName: "run_task"
      })
    ];

    for (const evidence of unsafeEvidence) {
      await expect(verifier(input([evidence]))).resolves.toMatchObject({ status: "failed" });
    }
    expect(generate).not.toHaveBeenCalled();
  });

  it("fails incomplete tool-use evidence before a judge model call", async () => {
    const generate = vi.fn(async () => ({
      id: "must-not-run",
      model: "judge/model",
      output: "{\"evidence\":[\"looks fine\"],\"verdict\":\"pass\"}"
    }));
    const verifier = createModelLoopOutcomeVerifier({
      model: "judge/model",
      modelProvider: { generate }
    });
    const missingEvidence = {
      ...input(),
      toolsUsed: ["write_note"]
    };

    await expect(verifier(missingEvidence)).resolves.toMatchObject({ status: "failed" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("uses a bounded strict no-tool judge request and returns a content-bound PASS", async () => {
    const requests: ModelRequest[] = [];
    const generate = vi.fn(async (request: ModelRequest) => {
      requests.push(request);
      return {
        id: "judge-pass",
        model: request.model,
        output: JSON.stringify({
          evidence: ["The response directly states that the requested brief is ready."],
          verdict: "pass"
        })
      };
    });
    const verifier = createModelLoopOutcomeVerifier({
      model: "judge/model",
      modelProvider: { generate }
    });
    const evidence = tool({
      effectVerification: { status: "verified" },
      risk: "write",
      toolName: "write_brief"
    });
    const judgeInput = input([evidence]);

    const first = await verifier(judgeInput);
    const second = await verifier(judgeInput);

    expect(first.status).toBe("passed");
    expect(first.evidenceId).toMatch(/^loop-outcome:[a-f0-9]{64}$/u);
    expect(second.evidenceId).toBe(first.evidenceId);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      maxOutputTokens: 320,
      model: "judge/model",
      reasoning: false,
      temperature: 0
    });
    expect(requests[0]!.signal).toBe(judgeInput.signal);
    expect(requests[0]!.responseFormat).toMatchObject({
      additionalProperties: false,
      required: ["evidence", "verdict"],
      type: "object"
    });
    expect("tools" in requests[0]!).toBe(false);
  });

  it("maps explicit judge failure to failed and rejects malformed verdicts", async () => {
    const failVerifier = createModelLoopOutcomeVerifier({
      model: "judge/model",
      modelProvider: {
        generate: async () => ({
          id: "judge-fail",
          model: "judge/model",
          output: "{\"evidence\":[\"The requested artifact is absent.\"],\"verdict\":\"fail\"}"
        })
      }
    });
    const malformedVerifier = createModelLoopOutcomeVerifier({
      model: "judge/model",
      modelProvider: {
        generate: async () => ({
          id: "judge-malformed",
          model: "judge/model",
          output: "{\"verdict\":\"pass\"}"
        })
      }
    });

    await expect(failVerifier(input())).resolves.toMatchObject({ status: "failed" });
    await expect(malformedVerifier(input())).rejects.toThrow(/invalid outcome judge verdict/u);
  });

  it("keeps production wiring explicit and allows a judge-model override", async () => {
    const generate = vi.fn(async (request: ModelRequest) => ({
      id: "configured-judge",
      model: request.model,
      output: "{\"evidence\":[\"The explicit request is answered.\"],\"verdict\":\"pass\"}"
    }));

    expect(configuredModelLoopOutcomeVerifier({}, { generate }, "primary/model")).toBeUndefined();
    const verifier = configuredModelLoopOutcomeVerifier({
      MUSE_LOOP_OUTCOME_VERIFIER_ENABLED: "true",
      MUSE_LOOP_OUTCOME_VERIFIER_MODEL: "judge/independent"
    }, { generate }, "primary/model");

    await expect(verifier!(input())).resolves.toMatchObject({ status: "passed" });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ model: "judge/independent" }));
  });
});
