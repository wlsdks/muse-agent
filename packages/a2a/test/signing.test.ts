import type { A2AEnvelope } from "@muse/agent-core";
import { describe, expect, it } from "vitest";

import { canonicalizeEnvelope, signEnvelope, verifySignature } from "../src/signing.js";

const envelope: A2AEnvelope = {
  content: "hello peer",
  fromPeerId: "peer-a",
  kind: "share",
  label: "note",
  redacted: false
};
const SECRET = "shared-peer-secret";

describe("signEnvelope / verifySignature — HMAC envelope authentication", () => {
  it("round-trips: a signature verifies with the SAME secret", () => {
    const sig = signEnvelope(envelope, SECRET);
    expect(sig).toMatch(/^[0-9a-f]{64}$/u); // SHA-256 hex
    expect(verifySignature(envelope, sig, SECRET)).toBe(true);
  });

  it("rejects a signature checked under a DIFFERENT secret (a forged 'from' has no secret)", () => {
    const sig = signEnvelope(envelope, SECRET);
    expect(verifySignature(envelope, sig, "wrong-secret")).toBe(false);
  });

  it("rejects when ANY safety-relevant field was tampered after signing", () => {
    const sig = signEnvelope(envelope, SECRET);
    expect(verifySignature({ ...envelope, content: "HELLO PEER" }, sig, SECRET)).toBe(false);
    expect(verifySignature({ ...envelope, fromPeerId: "peer-b" }, sig, SECRET)).toBe(false);
    expect(verifySignature({ ...envelope, kind: "ask" as A2AEnvelope["kind"] }, sig, SECRET)).toBe(false);
    expect(verifySignature({ ...envelope, label: "different" }, sig, SECRET)).toBe(false);
    expect(verifySignature({ ...envelope, redacted: true }, sig, SECRET)).toBe(false);
  });

  it("rejects a wrong-length, non-string, or non-hex signature without throwing (fail-closed)", () => {
    const sig = signEnvelope(envelope, SECRET);
    expect(verifySignature(envelope, "deadbeef", SECRET)).toBe(false); // too short
    expect(verifySignature(envelope, 12345 as unknown as string, SECRET)).toBe(false); // non-string
    expect(verifySignature(envelope, "z".repeat(sig.length), SECRET)).toBe(false); // right length, not hex
  });
});

describe("canonicalizeEnvelope — deterministic, field-ordered serialisation", () => {
  it("is stable for equal envelopes and lays out the fields in the documented order", () => {
    const canon = canonicalizeEnvelope(envelope);
    expect(canon).toBe(canonicalizeEnvelope({ ...envelope })); // deterministic
    // every field appears, in order: kind → fromPeerId → redacted → label → content
    const order = ["share", "peer-a", "false", "note", "hello peer"];
    let last = -1;
    for (const field of order) {
      const at = canon.indexOf(field);
      expect(at, `field "${field}" present + ordered`).toBeGreaterThan(last);
      last = at;
    }
  });

  it("coerces an absent optional field to the same canonical form as an explicit empty string", () => {
    const noLabel: A2AEnvelope = { content: "c", fromPeerId: "p", kind: "share", redacted: true };
    const emptyLabel: A2AEnvelope = { ...noLabel, label: "" };
    // undefined label and "" label must canonicalise + sign identically — both sides agree.
    expect(canonicalizeEnvelope(noLabel)).toBe(canonicalizeEnvelope(emptyLabel));
    expect(signEnvelope(noLabel, SECRET)).toBe(signEnvelope(emptyLabel, SECRET));
  });

  it("changing only the redacted flag changes the signature (the scrub flag is authenticated)", () => {
    expect(signEnvelope({ ...envelope, redacted: true }, SECRET)).not.toBe(signEnvelope({ ...envelope, redacted: false }, SECRET));
  });
});
