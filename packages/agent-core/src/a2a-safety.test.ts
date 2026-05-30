import { describe, expect, it } from "vitest";

import {
  A2ASafetyError,
  classifyInbound,
  isA2AEnabled,
  prepareOutbound,
  type A2AEnvelope
} from "./a2a-safety.js";

describe("isA2AEnabled — fail-closed opt-in", () => {
  it("is OFF by default and only on for explicit truthy values", () => {
    expect(isA2AEnabled({})).toBe(false);
    expect(isA2AEnabled({ MUSE_A2A_ENABLED: "false" })).toBe(false);
    expect(isA2AEnabled({ MUSE_A2A_ENABLED: "" })).toBe(false);
    expect(isA2AEnabled({ MUSE_A2A_ENABLED: "true" })).toBe(true);
    expect(isA2AEnabled({ MUSE_A2A_ENABLED: "1" })).toBe(true);
    expect(isA2AEnabled({ MUSE_A2A_ENABLED: "on" })).toBe(true);
  });
});

describe("prepareOutbound — only know-how crosses, PII redacted", () => {
  it("sends a skill, redacting secrets before it can leave", () => {
    const env = prepareOutbound(
      { content: "To fix the VPN, set MTU 1380. token=sk-secret-12345", kind: "skill" },
      "my-laptop",
      (t) => t.replace(/sk-secret-\d+/g, "[redacted]")
    );
    expect(env.kind).toBe("skill");
    expect(env.content).toContain("MTU 1380");
    expect(env.content).not.toContain("sk-secret-12345");
    expect(env.redacted).toBe(true);
    expect(env.fromPeerId).toBe("my-laptop");
  });

  it("REFUSES any payload kind that isn't shareable know-how (a note/fact/credential can't be sent)", () => {
    for (const kind of ["note", "fact", "credential", "tool-call", "memory", "episode"]) {
      expect(() => prepareOutbound({ content: "private stuff", kind: kind as never }, "p")).toThrow(A2ASafetyError);
    }
  });

  it("refuses empty content / missing sender", () => {
    expect(() => prepareOutbound({ content: "   ", kind: "skill" }, "p")).toThrow(A2ASafetyError);
    expect(() => prepareOutbound({ content: "x", kind: "skill" }, "  ")).toThrow(A2ASafetyError);
  });
});

describe("classifyInbound — inert: quarantine or reject, NEVER execute", () => {
  const peers = new Set(["friend-a", "my-phone"]);
  const env = (over: Partial<A2AEnvelope> = {}): A2AEnvelope => ({
    content: "share a debugging skill",
    fromPeerId: "friend-a",
    kind: "skill",
    redacted: false,
    ...over
  });

  it("quarantines a valid know-how payload from an allowlisted peer (never executes it)", () => {
    const d = classifyInbound(env(), peers);
    expect(d.disposition).toBe("quarantine");
    expect(d.envelope).toMatchObject({ kind: "skill", fromPeerId: "friend-a" });
    // The type itself has no "execute" — assert at runtime too for the audit trail.
    expect(["quarantine", "reject"]).toContain(d.disposition);
  });

  it("rejects an unknown / non-allowlisted peer", () => {
    expect(classifyInbound(env({ fromPeerId: "stranger" }), peers)).toMatchObject({ disposition: "reject" });
  });

  it("rejects a non-shareable kind (a disguised note / tool-call / compute request)", () => {
    expect(classifyInbound(env({ kind: "tool-call" as never }), peers)).toMatchObject({ disposition: "reject" });
    expect(classifyInbound(env({ kind: "note" as never }), peers)).toMatchObject({ disposition: "reject" });
  });

  it("rejects a malformed envelope", () => {
    expect(classifyInbound(null, peers)).toMatchObject({ disposition: "reject" });
    expect(classifyInbound({ kind: "skill" }, peers)).toMatchObject({ disposition: "reject" });
    expect(classifyInbound("not an object", peers)).toMatchObject({ disposition: "reject" });
  });
});
