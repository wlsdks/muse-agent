import { describe, expect, it } from "vitest";

import {
  A2ASafetyError,
  classifyInbound,
  isA2AEnabled,
  prepareOutbound,
  type A2AEnvelope,
  type A2AOutbound
} from "../src/a2a-safety.js";

describe("isA2AEnabled — fail-closed opt-in (the swarm is OFF by default)", () => {
  it("is true only for an explicit affirmative value (case/whitespace tolerant)", () => {
    for (const v of ["true", "1", "yes", "on", " TRUE ", "On"]) {
      expect(isA2AEnabled({ MUSE_A2A_ENABLED: v }), v).toBe(true);
    }
  });

  it("is false for undefined, empty, or any non-affirmative value", () => {
    for (const v of [undefined, "", "false", "0", "no", "off", "enabled", "maybe"]) {
      expect(isA2AEnabled({ MUSE_A2A_ENABLED: v }), String(v)).toBe(false);
    }
  });
});

describe("prepareOutbound — only redacted know-how may cross", () => {
  const base: A2AOutbound = { content: "when rescheduling, prefer the next business day", kind: "strategy" };

  it("builds an envelope for each shareable know-how kind", () => {
    for (const kind of ["skill", "strategy", "council-utterance"] as const) {
      const env = prepareOutbound({ ...base, kind }, "me");
      expect(env).toMatchObject({ fromPeerId: "me", kind, redacted: false });
    }
  });

  it("REFUSES any non-shareable kind — a note/fact/credential can't even be expressed as outbound", () => {
    for (const kind of ["note", "fact", "credential", "tool-call"]) {
      expect(() => prepareOutbound({ ...base, kind: kind as A2AOutbound["kind"] }, "me")).toThrow(A2ASafetyError);
    }
  });

  it("refuses empty content and an empty sender id", () => {
    expect(() => prepareOutbound({ ...base, content: "   " }, "me")).toThrow(A2ASafetyError);
    expect(() => prepareOutbound(base, "  ")).toThrow(A2ASafetyError);
  });

  it("redacts PII/secrets before send and records redacted:true when the content changed", () => {
    const env = prepareOutbound({ content: "rotate sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa tonight", kind: "skill" }, "me");
    expect(env.content).not.toContain("sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(env.content).toContain("[redacted-anthropic-key]");
    expect(env.redacted).toBe(true);
  });

  it("redacts the optional label too, and omits it when absent", () => {
    const withLabel = prepareOutbound({ ...base, label: "key sk-ant-bbbbbbbbbbbbbbbbbbbbbbbb" }, "me");
    expect(withLabel.label).toContain("[redacted-anthropic-key]");
    expect(prepareOutbound(base, "me")).not.toHaveProperty("label");
  });
});

describe("classifyInbound — inert: quarantine | reject, NEVER execute", () => {
  const allowed = new Set(["peer-a"]);
  const goodEnvelope: A2AEnvelope = { content: "a skill", fromPeerId: "peer-a", kind: "skill", redacted: false };

  it("quarantines well-formed know-how from an allowlisted peer (execute-gated)", () => {
    const decision = classifyInbound(goodEnvelope, allowed);
    expect(decision.disposition).toBe("quarantine");
    expect(decision.envelope).toBe(goodEnvelope);
  });

  it("rejects a malformed envelope (not an object / missing required fields)", () => {
    expect(classifyInbound(null, allowed).disposition).toBe("reject");
    expect(classifyInbound({ content: "x" }, allowed).disposition).toBe("reject"); // missing kind/fromPeerId/redacted
  });

  it("rejects a peer that isn't in the allowlist", () => {
    expect(classifyInbound({ ...goodEnvelope, fromPeerId: "stranger" }, allowed)).toMatchObject({ disposition: "reject" });
  });

  it("rejects a non-shareable kind (a disguised note / tool-call), and never returns an execute disposition", () => {
    const decision = classifyInbound({ ...goodEnvelope, kind: "tool-call" as A2AEnvelope["kind"] }, allowed);
    expect(decision.disposition).toBe("reject");
    // exhaustive: the only two dispositions the type permits
    expect(["quarantine", "reject"]).toContain(classifyInbound(goodEnvelope, allowed).disposition);
  });
});
