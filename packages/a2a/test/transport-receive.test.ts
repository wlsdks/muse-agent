import { describe, expect, it } from "vitest";

import { envelopeToSendRequest } from "../src/a2a-message.js";
import { createPeerRegistry } from "../src/peer-registry.js";
import { signEnvelope } from "../src/signing.js";
import { receiveFromPeer } from "../src/transport.js";

const ENV = { MUSE_A2A_ENABLED: "true" };
const SECRET = "peer-secret";
const registry = createPeerRegistry([{ id: "peer-a", secret: SECRET, url: "https://peer-a.test" }]);

const envelope = { content: "a useful skill", fromPeerId: "peer-a", kind: "skill" as const, label: "lbl", redacted: false };
const bodyFor = (env: typeof envelope) => JSON.stringify(envelopeToSendRequest(env, "msg-id", "rpc-id"));

describe("receiveFromPeer — inbound peer-message safety gate (quarantine | reject, never execute)", () => {
  it("quarantines a valid, correctly-signed know-how message from a known peer", () => {
    const decision = receiveFromPeer({ env: ENV, rawBody: bodyFor(envelope), registry, signature: signEnvelope(envelope, SECRET) });
    expect(decision.disposition).toBe("quarantine");
    expect(decision.envelope).toMatchObject({ content: "a useful skill", fromPeerId: "peer-a", kind: "skill" });
  });

  it("rejects everything when A2A is disabled on this Muse (opt-in only)", () => {
    const decision = receiveFromPeer({ env: {}, rawBody: bodyFor(envelope), registry, signature: signEnvelope(envelope, SECRET) });
    expect(decision.disposition).toBe("reject");
    expect(decision.reason).toContain("disabled");
  });

  it("rejects an unparseable body", () => {
    const decision = receiveFromPeer({ env: ENV, rawBody: "{ not json", registry, signature: "x" });
    expect(decision).toMatchObject({ disposition: "reject", reason: "unparseable A2A body" });
  });

  it("rejects a parseable body that carries no know-how envelope", () => {
    const decision = receiveFromPeer({ env: ENV, rawBody: JSON.stringify({ jsonrpc: "2.0" }), registry, signature: "x" });
    expect(decision.disposition).toBe("reject");
    expect(decision.reason).toContain("no know-how");
  });

  it("rejects a peer that isn't in the allowlist (never trusts an unknown 'from')", () => {
    const stranger = { ...envelope, fromPeerId: "peer-x" };
    const decision = receiveFromPeer({ env: ENV, rawBody: bodyFor(stranger), registry, signature: signEnvelope(stranger, SECRET) });
    expect(decision.disposition).toBe("reject");
    expect(decision.reason).toContain("unknown peer");
  });

  it("rejects a missing or invalid HMAC signature (tampered envelope / wrong secret)", () => {
    expect(receiveFromPeer({ env: ENV, rawBody: bodyFor(envelope), registry, signature: undefined }).disposition).toBe("reject");
    const bad = receiveFromPeer({ env: ENV, rawBody: bodyFor(envelope), registry, signature: signEnvelope(envelope, "wrong-secret") });
    expect(bad).toMatchObject({ disposition: "reject", reason: "invalid signature — envelope tampered or wrong secret" });
  });

  it("rejects a correctly-signed message whose kind is NOT shareable know-how (safety core has the final say)", () => {
    const ask = { ...envelope, kind: "ask" as const };
    const decision = receiveFromPeer({ env: ENV, rawBody: bodyFor(ask), registry, signature: signEnvelope(ask, SECRET) });
    expect(decision.disposition).toBe("reject"); // a valid signature can't make a non-know-how kind executable
  });
});
