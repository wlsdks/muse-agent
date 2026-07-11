import { describe, expect, it } from "vitest";

import { MUSE_IDENTITY_CORE } from "../src/identity-core.js";
import {
  composeSurfacePromptSegments,
  MUSE_CACHE_BOUNDARY_MARKER,
  SURFACE_ROLES
} from "../src/index.js";

// Structured twin of composeSurfacePrompt for the S3 admin preview
// (docs/strategy/prompt-architecture.md, S3 §2) — the web console renders
// one colored block per segment instead of parsing the flat string.
describe("composeSurfacePromptSegments", () => {
  it("puts identity first, flagged read-only, verbatim MUSE_IDENTITY_CORE", () => {
    const segments = composeSurfacePromptSegments("chat");
    expect(segments[0]).toEqual({ layer: "identity", readOnly: true, section: "stable", text: MUSE_IDENTITY_CORE });
  });

  it("carries the surface role text as its own 'role' segment", () => {
    const segments = composeSurfacePromptSegments("ask");
    const role = segments.find((s) => s.layer === "role");
    expect(role?.text).toBe(SURFACE_ROLES.ask);
  });

  it("places a caller-supplied personality layer between identity and role", () => {
    const segments = composeSurfacePromptSegments("chat", {
      layers: [{ content: "PERSONALITY_TEXT_XYZ", id: "personality", section: "stable" }]
    });
    const identityIndex = segments.findIndex((s) => s.layer === "identity");
    const personalityIndex = segments.findIndex((s) => s.layer === "personality");
    const roleIndex = segments.findIndex((s) => s.layer === "role");
    expect(personalityIndex).toBeGreaterThan(identityIndex);
    expect(roleIndex).toBeGreaterThan(personalityIndex);
    expect(segments[personalityIndex]?.text).toBe("PERSONALITY_TEXT_XYZ");
    expect(segments[personalityIndex]?.readOnly).not.toBe(true);
  });

  it("ends with exactly one boundary segment followed by a dynamic placeholder", () => {
    const segments = composeSurfacePromptSegments("chat");
    const boundaryCount = segments.filter((s) => s.layer === "boundary").length;
    expect(boundaryCount).toBe(1);
    expect(segments.at(-1)?.layer).toBe("dynamic-placeholder");
    expect(segments.at(-2)?.text).toBe(MUSE_CACHE_BOUNDARY_MARKER);
  });

  it("categorizes an unknown caller layer id as 'rules' rather than dropping it", () => {
    const segments = composeSurfacePromptSegments("chat", {
      layers: [{ content: "RULE_TEXT_XYZ", id: "behavioral-rules", section: "stable" }]
    });
    const rule = segments.find((s) => s.text === "RULE_TEXT_XYZ");
    expect(rule?.layer).toBe("rules");
  });

  it("never throws for any surface with no caller layers", () => {
    for (const surface of Object.keys(SURFACE_ROLES) as (keyof typeof SURFACE_ROLES)[]) {
      expect(() => composeSurfacePromptSegments(surface)).not.toThrow();
    }
  });
});
