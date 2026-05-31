import { describe, expect, it } from "vitest";

import { envelopeToA2AMessage, envelopeToSendRequest, extractEnvelopeFromA2ABody } from "../src/a2a-message.js";

const envelope = { content: "a useful skill", fromPeerId: "peer-a", kind: "skill" as const, label: "lbl", redacted: false };

describe("envelopeToA2AMessage", () => {
  it("wraps the envelope as a single data part with the know-how metadata + agent role", () => {
    const msg = envelopeToA2AMessage(envelope, "msg-1");
    expect(msg).toMatchObject({ kind: "message", messageId: "msg-1", role: "agent" });
    expect(msg.parts).toHaveLength(1);
    expect(msg.parts[0]?.kind).toBe("data");
    expect(msg.parts[0]?.data).toBe(envelope); // the canonical payload, by reference
    expect(msg.parts[0]?.metadata).toMatchObject({ "muse:payloadKind": "skill", "muse:redacted": false });
  });
});

describe("extractEnvelopeFromA2ABody — untrusted inbound parse (data part only)", () => {
  it("pulls the envelope out of a JSON-RPC message/send body", () => {
    const body = envelopeToSendRequest(envelope, "m1", "rpc1");
    expect(extractEnvelopeFromA2ABody(body)).toBe(envelope);
  });

  it("pulls the envelope out of a bare Message body", () => {
    expect(extractEnvelopeFromA2ABody(envelopeToA2AMessage(envelope, "m1"))).toBe(envelope);
  });

  it("returns null for a non-object body, missing parts, no data part, or a non-object data", () => {
    expect(extractEnvelopeFromA2ABody(null)).toBeNull();
    expect(extractEnvelopeFromA2ABody("a string")).toBeNull();
    expect(extractEnvelopeFromA2ABody({ params: { message: {} } })).toBeNull(); // no parts array
    expect(extractEnvelopeFromA2ABody({ parts: [{ kind: "text", text: "hi" }] })).toBeNull(); // no data part
    expect(extractEnvelopeFromA2ABody({ parts: [{ data: "not-an-object", kind: "data" }] })).toBeNull(); // data must be an object
  });
});
