import type { A2AEnvelope } from "@muse/agent-core";
import { describe, expect, it } from "vitest";

import { envelopeToSendRequest } from "./a2a-message.js";
import { createPeerRegistry } from "./peer-registry.js";
import { receiveAndQuarantine, type QuarantineDepositInput } from "./receive-quarantine.js";
import { signEnvelope } from "./signing.js";

const SHARED = "k";
const ON = { MUSE_A2A_ENABLED: "true" } as const;
const registry = createPeerRegistry([{ id: "phone", secret: SHARED, url: "x" }]);
const envelope: A2AEnvelope = { content: "set MTU 1380", fromPeerId: "phone", kind: "skill", redacted: false };
const wire = JSON.stringify(envelopeToSendRequest(envelope, "m", "r"));

describe("receiveAndQuarantine — accepted know-how is deposited; rejected deposits nothing", () => {
  it("deposits a quarantined payload with the envelope's fields", async () => {
    const deposited: QuarantineDepositInput[] = [];
    const d = await receiveAndQuarantine({
      deposit: async (i) => { deposited.push(i); },
      env: ON,
      genId: () => "fixed-id",
      now: () => 5_000,
      rawBody: wire,
      registry,
      signature: signEnvelope(envelope, SHARED)
    });
    expect(d.disposition).toBe("quarantine");
    expect(deposited).toHaveLength(1);
    expect(deposited[0]).toMatchObject({ content: "set MTU 1380", fromPeerId: "phone", id: "fixed-id", kind: "skill", receivedAtMs: 5_000 });
  });

  it("deposits NOTHING when the message is rejected (bad signature / unknown peer / disabled)", async () => {
    const deposited: QuarantineDepositInput[] = [];
    const deposit = async (i: QuarantineDepositInput) => { deposited.push(i); };
    // bad signature
    await receiveAndQuarantine({ deposit, env: ON, rawBody: wire, registry, signature: "deadbeef" });
    // disabled
    await receiveAndQuarantine({ deposit, env: {}, rawBody: wire, registry, signature: signEnvelope(envelope, SHARED) });
    expect(deposited).toHaveLength(0);
  });
});
