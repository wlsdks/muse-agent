import { describe, expect, it } from "vitest";

import { createApiServerOptions } from "../src/api-server-options.js";

describe("API server loop health options", () => {
  it("passes the production assembly observer snapshot to the API surface", async () => {
    const options = createApiServerOptions({
      env: {
        MUSE_ACTIVE_CONTEXT_ENABLED: "false",
        MUSE_MODEL: "diagnostic/smoke",
        MUSE_MODEL_PROVIDER_ID: "diagnostic"
      }
    });

    expect(options.agentLoopHealthSnapshot()).toBeUndefined();
    const result = await options.agentRuntime!.run({
      messages: [{ content: "wire loop health", role: "user" }],
      model: "diagnostic/smoke"
    });

    expect(options.agentLoopHealthSnapshot()).toMatchObject({
      endedAt: result.loopControlReceipt?.endedAt,
      terminalStatus: result.loopControlReceipt?.terminal.status,
      verificationStatus: result.loopControlReceipt?.verification.status
    });
  });
});
