import { describe, expect, it } from "vitest";

import {
  buildMuseAgentCard,
  KNOW_HOW_MEDIA_TYPE,
  KNOW_HOW_ONLY_EXT_URI,
  MUSE_A2A_PROTOCOL_VERSION
} from "../src/agent-card.js";

describe("buildMuseAgentCard — the A2A discovery surface", () => {
  it("passes the url through and defaults the name to 'Muse' (overridable)", () => {
    expect(buildMuseAgentCard({ url: "https://me.test/a2a" }).url).toBe("https://me.test/a2a");
    expect(buildMuseAgentCard({ url: "u" }).name).toBe("Muse");
    expect(buildMuseAgentCard({ name: "Custom", url: "u" }).name).toBe("Custom");
    expect(buildMuseAgentCard({ url: "u" }).protocolVersion).toBe(MUSE_A2A_PROTOCOL_VERSION);
  });

  it("advertises NO streaming and NO push notifications (a webhook target is an SSRF/egress hole)", () => {
    const card = buildMuseAgentCard({ url: "u" });
    expect(card.capabilities.streaming).toBe(false);
    expect(card.capabilities.pushNotifications).toBe(false);
  });

  it("carries the REQUIRED know-how-only extension declaring acceptsExecution:false", () => {
    const card = buildMuseAgentCard({ url: "u" });
    const ext = card.capabilities.extensions.find((e) => e.uri === KNOW_HOW_ONLY_EXT_URI);
    expect(ext).toBeDefined();
    expect(ext!.required).toBe(true);
    expect(ext!.params).toMatchObject({
      acceptsExecution: false,
      inboundDisposition: ["quarantine", "reject"],
      piiRedacted: true,
      sharePolicy: "know-how-only"
    });
    expect(ext!.params!.payloadKinds).toEqual(["skill", "strategy", "council-utterance"]);
  });

  it("exposes exactly the three know-how skills, each tagged inert/no-exec and never-executed", () => {
    const card = buildMuseAgentCard({ url: "u" });
    expect(card.skills.map((s) => s.id)).toEqual(["know-how.skill", "know-how.strategy", "know-how.council-utterance"]);
    for (const skill of card.skills) {
      expect(skill.tags).toContain("no-exec");
      expect(skill.description).toContain("Never executed");
      expect(skill.inputModes).toEqual([KNOW_HOW_MEDIA_TYPE]);
    }
  });

  it("declares the HMAC security scheme and know-how media type as the default I/O mode", () => {
    const card = buildMuseAgentCard({ url: "u" });
    expect(card.defaultInputModes).toEqual([KNOW_HOW_MEDIA_TYPE]);
    expect(card.defaultOutputModes).toEqual([KNOW_HOW_MEDIA_TYPE]);
    expect((card.securitySchemes.museHmac as { scheme: string }).scheme).toBe("muse-a2a-hmac");
  });

  it("leaks no obvious PII / internal identity in the recon surface (name + description only)", () => {
    const serialized = JSON.stringify(buildMuseAgentCard({ url: "https://me.test" }));
    // the card must not embed a home path, an email, or an internal tool name
    expect(serialized).not.toMatch(/\/Users\/|\/home\/|@[\w.]+\.\w+/u);
  });
});
