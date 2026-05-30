import type { A2AEnvelope } from "@muse/agent-core";
import { describe, expect, it } from "vitest";

import {
  envelopeToA2AMessage,
  envelopeToSendRequest,
  extractEnvelopeFromA2ABody
} from "./a2a-message.js";
import {
  buildMuseAgentCard,
  KNOW_HOW_ONLY_EXT_URI,
  MUSE_A2A_PROTOCOL_VERSION
} from "./agent-card.js";

describe("buildMuseAgentCard — A2A discovery surface advertising know-how-only", () => {
  const card = buildMuseAgentCard({ url: "http://192.168.1.10:4111/a2a" });

  it("pins the protocol version and advertises only the three know-how skills", () => {
    expect(card.protocolVersion).toBe(MUSE_A2A_PROTOCOL_VERSION);
    expect(card.skills.map((s) => s.id)).toEqual(["know-how.skill", "know-how.strategy", "know-how.council-utterance"]);
    expect(card.skills.every((s) => s.tags.includes("no-exec"))).toBe(true);
  });

  it("declares the REQUIRED know-how-only extension with acceptsExecution:false", () => {
    const ext = card.capabilities.extensions.find((e) => e.uri === KNOW_HOW_ONLY_EXT_URI);
    expect(ext?.required).toBe(true);
    expect(ext?.params).toMatchObject({ acceptsExecution: false, sharePolicy: "know-how-only", piiRedacted: true });
  });

  it("never opens an egress/SSRF surface: streaming + pushNotifications are false", () => {
    expect(card.capabilities.streaming).toBe(false);
    expect(card.capabilities.pushNotifications).toBe(false);
  });
});

describe("envelope ↔ A2A Message mapping", () => {
  const envelope: A2AEnvelope = { content: "set MTU 1380", fromPeerId: "phone", kind: "skill", redacted: false };

  it("frames the envelope as a DataPart inside an A2A message/send request", () => {
    const req = envelopeToSendRequest(envelope, "m1", "r1");
    expect(req).toMatchObject({ jsonrpc: "2.0", method: "message/send" });
    const part = req.params.message.parts[0]!;
    expect(part.kind).toBe("data");
    expect(part.data).toEqual(envelope);
    expect(part.metadata).toMatchObject({ "muse:payloadKind": "skill", "muse:ext": KNOW_HOW_ONLY_EXT_URI });
  });

  it("round-trips: extract pulls the flat envelope back from the A2A body", () => {
    const req = envelopeToSendRequest(envelope, "m1", "r1");
    expect(extractEnvelopeFromA2ABody(req)).toEqual(envelope);
    // also accepts a bare Message (not wrapped in JSON-RPC)
    expect(extractEnvelopeFromA2ABody(envelopeToA2AMessage(envelope, "m2"))).toEqual(envelope);
  });

  it("returns null when there is no DataPart (a text-only A2A message)", () => {
    expect(extractEnvelopeFromA2ABody({ parts: [{ kind: "text", text: "hi" }] })).toBeNull();
    expect(extractEnvelopeFromA2ABody(null)).toBeNull();
    expect(extractEnvelopeFromA2ABody({ params: {} })).toBeNull();
  });
});
