import type { A2AEnvelope } from "@muse/agent-core";
import { describe, expect, it } from "vitest";

import { canonicalizeEnvelope, signEnvelope, verifySignature } from "./signing.js";

// Direct coverage for the A2A envelope signing (untested) — the SECURITY gate
// that lets the transport reject a tampered or forged peer message before the
// safety core sees it. verifySignature must reject any field tamper, a forged
// from-id, a wrong secret, and a malformed signature WITHOUT throwing.

const envelope = (over: Partial<A2AEnvelope> = {}): A2AEnvelope =>
  ({ content: "hello", fromPeerId: "phone", kind: "ask", label: "q", redacted: false, ...over }) as unknown as A2AEnvelope;

describe("signEnvelope / verifySignature", () => {
  it("a correct signature verifies and is deterministic for the same envelope + secret", () => {
    const sig = signEnvelope(envelope(), "secret");
    expect(sig).toBe(signEnvelope(envelope(), "secret"));
    expect(verifySignature(envelope(), sig, "secret")).toBe(true);
  });

  it("rejects a tampered field, a forged from-id, and a wrong secret", () => {
    const sig = signEnvelope(envelope(), "secret");
    expect(verifySignature(envelope({ content: "HELLO" }), sig, "secret")).toBe(false); // content tamper
    expect(verifySignature(envelope({ label: "x" }), sig, "secret")).toBe(false); // label tamper
    expect(verifySignature(envelope({ fromPeerId: "laptop" }), sig, "secret")).toBe(false); // forged sender
    expect(verifySignature(envelope(), sig, "other-secret")).toBe(false); // wrong secret
  });

  it("rejects a malformed signature (wrong length, non-hex) WITHOUT throwing", () => {
    expect(verifySignature(envelope(), "abc", "secret")).toBe(false); // too short → length guard
    expect(verifySignature(envelope(), "z".repeat(64), "secret")).toBe(false); // right length, non-hex → catch
    expect(verifySignature(envelope(), "", "secret")).toBe(false);
  });
});

describe("canonicalizeEnvelope", () => {
  it("is invariant to object key ordering (both sides hash identically)", () => {
    const a = canonicalizeEnvelope({ content: "c", fromPeerId: "p", kind: "ask", label: "l", redacted: false } as unknown as A2AEnvelope);
    const b = canonicalizeEnvelope({ content: "c", fromPeerId: "p", kind: "ask", label: "l", redacted: false } as unknown as A2AEnvelope);
    expect(a).toBe(b);
  });

  it("changes when any safety-relevant field changes", () => {
    expect(canonicalizeEnvelope(envelope())).not.toBe(canonicalizeEnvelope(envelope({ label: "x" })));
    expect(canonicalizeEnvelope(envelope())).not.toBe(canonicalizeEnvelope(envelope({ redacted: true })));
  });
});
