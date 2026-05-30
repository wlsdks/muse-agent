import { A2ASafetyError, type A2AEnvelope } from "@muse/agent-core";
import { describe, expect, it } from "vitest";

import { createPeerRegistry } from "./peer-registry.js";
import { signEnvelope } from "./signing.js";
import { A2A_SIGNATURE_HEADER, receiveFromPeer, sendToPeer } from "./transport.js";

const SHARED = "shared-swarm-key";
const ON = { MUSE_A2A_ENABLED: "true" } as const;

const phonePeer = { id: "phone", secret: SHARED, url: "https://phone.test/a2a" };
// The receiver (phone) knows the sender (laptop) by the same shared secret.
const receiverRegistry = createPeerRegistry([{ id: "laptop", secret: SHARED, url: "https://laptop.test/a2a" }]);

function captureFetch() {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ init: init ?? {}, url: String(url) });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("sendToPeer — only know-how leaves, signed, over the wire", () => {
  it("POSTs a redacted, signed skill envelope to the peer URL", async () => {
    const { calls, fetchImpl } = captureFetch();
    const res = await sendToPeer({
      env: ON,
      fetchImpl,
      fromPeerId: "laptop",
      outbound: { content: "Fix VPN: MTU 1380. token=sk-abc123", kind: "skill" },
      peer: phonePeer,
      redact: (t) => t.replace(/sk-[a-z0-9]+/g, "[redacted]")
    });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://phone.test/a2a");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers[A2A_SIGNATURE_HEADER]).toMatch(/^[0-9a-f]{64}$/); // hex HMAC
    const body = JSON.parse(String(calls[0]!.init.body)) as A2AEnvelope;
    expect(body.kind).toBe("skill");
    expect(body.content).not.toContain("sk-abc123"); // PII scrubbed before the wire
    expect(body.fromPeerId).toBe("laptop");
  });

  it("sends NOTHING when A2A is disabled (opt-in)", async () => {
    const { calls, fetchImpl } = captureFetch();
    await expect(sendToPeer({
      env: {}, fetchImpl, fromPeerId: "laptop", outbound: { content: "x", kind: "skill" }, peer: phonePeer
    })).rejects.toThrow(A2ASafetyError);
    expect(calls).toHaveLength(0);
  });

  it("refuses to send a non-know-how kind (a note can't go over the wire)", async () => {
    const { calls, fetchImpl } = captureFetch();
    await expect(sendToPeer({
      env: ON, fetchImpl, fromPeerId: "laptop", outbound: { content: "my private note", kind: "note" as never }, peer: phonePeer
    })).rejects.toThrow(A2ASafetyError);
    expect(calls).toHaveLength(0);
  });
});

describe("receiveFromPeer — verify signature, then quarantine | reject (never execute)", () => {
  // Build the exact envelope a real send produces, then sign it as the sender would.
  const validEnvelope: A2AEnvelope = { content: "a debugging skill", fromPeerId: "laptop", kind: "skill", redacted: false };
  const validSig = signEnvelope(validEnvelope, SHARED);

  it("quarantines a valid, signed know-how payload from an allowlisted peer", () => {
    const d = receiveFromPeer({ env: ON, rawBody: JSON.stringify(validEnvelope), registry: receiverRegistry, signature: validSig });
    expect(d.disposition).toBe("quarantine");
    expect(d.envelope?.kind).toBe("skill");
  });

  it("rejects a tampered envelope (content changed after signing)", () => {
    const tampered = { ...validEnvelope, content: "rm -rf / disguised as a skill" };
    const d = receiveFromPeer({ env: ON, rawBody: JSON.stringify(tampered), registry: receiverRegistry, signature: validSig });
    expect(d).toMatchObject({ disposition: "reject" });
    expect(d.reason).toMatch(/signature/i);
  });

  it("rejects an unknown / non-allowlisted peer", () => {
    const stranger: A2AEnvelope = { ...validEnvelope, fromPeerId: "stranger" };
    const d = receiveFromPeer({ env: ON, rawBody: JSON.stringify(stranger), registry: receiverRegistry, signature: signEnvelope(stranger, SHARED) });
    expect(d).toMatchObject({ disposition: "reject" });
  });

  it("rejects a VALIDLY-SIGNED non-know-how payload — the safety core has the final say past the signature", () => {
    // A malicious allowlisted peer bypasses its own prepareOutbound and signs a
    // compute/tool payload. The receiver must still refuse it.
    const evil = { content: "{...}", fromPeerId: "laptop", kind: "tool-call", redacted: false } as unknown as A2AEnvelope;
    const d = receiveFromPeer({ env: ON, rawBody: JSON.stringify(evil), registry: receiverRegistry, signature: signEnvelope(evil, SHARED) });
    expect(d).toMatchObject({ disposition: "reject" });
    expect(d.reason).toMatch(/know-how|never to execute/i);
  });

  it("rejects everything when A2A is disabled on the receiver", () => {
    expect(receiveFromPeer({ env: {}, rawBody: JSON.stringify(validEnvelope), registry: receiverRegistry, signature: validSig }))
      .toMatchObject({ disposition: "reject" });
  });
});
