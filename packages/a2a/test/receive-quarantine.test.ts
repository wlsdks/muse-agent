import { describe, expect, it } from "vitest";

import { envelopeToSendRequest } from "../src/a2a-message.js";
import { createPeerRegistry } from "../src/peer-registry.js";
import { receiveAndQuarantine, type QuarantineDepositInput } from "../src/receive-quarantine.js";
import { signEnvelope } from "../src/signing.js";

const ENV = { MUSE_A2A_ENABLED: "true" };
const SECRET = "peer-secret";
const registry = createPeerRegistry([{ id: "peer-a", secret: SECRET, url: "https://peer-a.test" }]);
const envelope = { content: "a useful skill", fromPeerId: "peer-a", kind: "skill" as const, label: "lbl", redacted: false };
const bodyFor = (env: typeof envelope) => JSON.stringify(envelopeToSendRequest(env, "msg-id", "rpc-id"));

describe("receiveAndQuarantine — deposit ONLY when the safety gate accepts", () => {
  it("deposits an accepted message with injected id + timestamp and returns the quarantine decision", async () => {
    const deposited: QuarantineDepositInput[] = [];
    const decision = await receiveAndQuarantine({
      deposit: async (input) => { deposited.push(input); },
      env: ENV,
      genId: () => "fixed-id",
      now: () => 1_700_000_000_000,
      rawBody: bodyFor(envelope),
      registry,
      signature: signEnvelope(envelope, SECRET)
    });
    expect(decision.disposition).toBe("quarantine");
    expect(deposited).toEqual([{
      content: "a useful skill",
      fromPeerId: "peer-a",
      id: "fixed-id",
      kind: "skill",
      label: "lbl",
      receivedAtMs: 1_700_000_000_000
    }]);
  });

  it("omits the label from the deposit when the envelope has none", async () => {
    const noLabel = { content: "c", fromPeerId: "peer-a", kind: "strategy" as const, redacted: false };
    const deposited: QuarantineDepositInput[] = [];
    await receiveAndQuarantine({
      deposit: async (input) => { deposited.push(input); },
      env: ENV,
      genId: () => "id",
      now: () => 1,
      rawBody: bodyFor(noLabel as typeof envelope),
      registry,
      signature: signEnvelope(noLabel, SECRET)
    });
    expect(deposited[0]).not.toHaveProperty("label");
  });

  it("deposits NOTHING when the gate rejects (a forged/invalid message is never quarantined)", async () => {
    let depositCalled = false;
    const decision = await receiveAndQuarantine({
      deposit: async () => { depositCalled = true; },
      env: ENV,
      rawBody: bodyFor(envelope),
      registry,
      signature: "deadbeef" // bad signature → reject
    });
    expect(decision.disposition).toBe("reject");
    expect(depositCalled).toBe(false);
  });
});
