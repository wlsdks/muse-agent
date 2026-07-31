import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createApiServerOptions } from "../src/api-server-options.js";
import {
  experienceLearningPromotionHandle,
  experienceLearningPromotionReceipt
} from "./helpers/experience-learning-promotion-receipt.js";

describe("API server loop health options", () => {
  it("passes the production assembly observer snapshot to the API surface", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "muse-loop-health-options-"));
    const options = createApiServerOptions({
      env: {
        MUSE_ACTIVE_CONTEXT_ENABLED: "false",
        MUSE_MODEL: "diagnostic/smoke",
        MUSE_MODEL_PROVIDER_ID: "diagnostic",
        MUSE_TRIGGER_ADMISSION_JOURNAL_FILE: join(root, "trigger-admission.json")
      }
    });

    try {
      expect(options.adaptationLoopHealthSnapshot()).toBeUndefined();
      expect(options.agentLoopHealthSnapshot()).toBeUndefined();
      await expect(options.eventLoopHealthSnapshot()).resolves.toMatchObject({
        journal: { entries: [], overflowCount: 0 },
        workStates: []
      });
      const promotion = experienceLearningPromotionReceipt(
        "2026-07-30T00:02:00.000Z",
        "api-options"
      );
      options.experienceLearningPromotionObserver(
        promotion,
        experienceLearningPromotionHandle(promotion)
      );
      const result = await options.agentRuntime!.run({
        messages: [{ content: "wire loop health", role: "user" }],
        model: "diagnostic/smoke"
      });

      expect(options.agentLoopHealthSnapshot()).toMatchObject({
        endedAt: result.loopControlReceipt?.endedAt,
        terminalStatus: result.loopControlReceipt?.terminal.status,
        verificationStatus: result.loopControlReceipt?.verification.status
      });
      expect(options.adaptationLoopHealthSnapshot()).toEqual({
        evidenceId: promotion.promotionId,
        evidenceVerified: true,
        status: "promoted"
      });
    } finally {
      await fs.rm(root, { force: true, recursive: true });
    }
  });
});
