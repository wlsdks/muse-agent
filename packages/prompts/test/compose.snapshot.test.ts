import { describe, expect, it } from "vitest";

import { MUSE_IDENTITY_CORE } from "../src/identity-core.js";
import {
  composeSurfacePrompt,
  MUSE_CACHE_BOUNDARY_MARKER,
  SURFACE_ROLES
} from "../src/index.js";

// Guardrails from docs/strategy/prompt-architecture.md §5, pinned for the two
// surfaces Phase 1 actually wires through the seam (context-transforms.ts's
// "chat", apps/cli/src/ask-system-prompt.ts's "ask"). A silent reorder here
// silently re-opens the divergent-identity-strings bug the seam exists to
// close, so every invariant is asserted, not just eyeballed via snapshot.
describe("composeSurfacePrompt — chat", () => {
  it("renders the exact section assembly for a rich input", () => {
    expect(
      composeSurfacePrompt("chat", {
        retrievedContext: "[Knowledge]\n- doc1",
        toolResults: "[Tool Results]\n- time_now -> 3pm"
      })
    ).toMatchSnapshot();
  });

  it("anchors identity at position 0 of the stable prefix", () => {
    const prompt = composeSurfacePrompt("chat", {});
    expect(prompt.startsWith(MUSE_IDENTITY_CORE)).toBe(true);
  });

  it("carries the chat surface role text", () => {
    expect(composeSurfacePrompt("chat", {})).toContain(SURFACE_ROLES.chat);
  });

  it("emits exactly one cache-boundary marker", () => {
    const prompt = composeSurfacePrompt("chat", {
      retrievedContext: "[Knowledge]\n- doc1",
      userMemoryContext: "home_city: Seoul"
    });
    const occurrences = prompt.split(MUSE_CACHE_BOUNDARY_MARKER).length - 1;
    expect(occurrences).toBe(1);
  });

  it("places fed dynamic content (retrieved/tool results) after the boundary", () => {
    const prompt = composeSurfacePrompt("chat", {
      retrievedContext: "FAKE_RETRIEVED_MARKER_XYZ",
      toolResults: "FAKE_TOOL_RESULT_MARKER_XYZ"
    });
    const boundary = prompt.indexOf(MUSE_CACHE_BOUNDARY_MARKER);
    expect(boundary).toBeGreaterThan(-1);
    expect(prompt.indexOf("FAKE_RETRIEVED_MARKER_XYZ")).toBeGreaterThan(boundary);
    expect(prompt.indexOf("FAKE_TOOL_RESULT_MARKER_XYZ")).toBeGreaterThan(boundary);
  });

  it("merges caller-supplied registry layers, placed after identity and before the surface role", () => {
    const prompt = composeSurfacePrompt("chat", {}, {
      layers: [{ content: "CALLER_LAYER_TEXT", id: "persona", section: "stable" }]
    });
    const identityIndex = prompt.indexOf(MUSE_IDENTITY_CORE);
    const layerIndex = prompt.indexOf("CALLER_LAYER_TEXT");
    const roleIndex = prompt.indexOf(SURFACE_ROLES.chat);
    expect(identityIndex).toBe(0);
    expect(layerIndex).toBeGreaterThan(identityIndex);
    expect(roleIndex).toBeGreaterThan(layerIndex);
  });

  it("a DYNAMIC caller layer (e.g. personalization/register-brevity) lands after the cache boundary, identity stays at position 0, exactly one boundary marker", () => {
    const prompt = composeSurfacePrompt("chat", {}, {
      layers: [
        { content: "CALLER_STABLE_TEXT", id: "personality", section: "stable" },
        { content: "REGISTER_BREVITY_DYNAMIC_TEXT", id: "personalization/register-brevity", section: "dynamic" }
      ]
    });
    expect(prompt.startsWith(MUSE_IDENTITY_CORE)).toBe(true);
    const boundary = prompt.indexOf(MUSE_CACHE_BOUNDARY_MARKER);
    expect(boundary).toBeGreaterThan(-1);
    expect(prompt.split(MUSE_CACHE_BOUNDARY_MARKER).length - 1).toBe(1);
    expect(prompt.indexOf("CALLER_STABLE_TEXT")).toBeLessThan(boundary);
    expect(prompt.indexOf("REGISTER_BREVITY_DYNAMIC_TEXT")).toBeGreaterThan(boundary);
  });
});

describe("composeSurfacePrompt — ask", () => {
  it("renders the exact section assembly for a rich input", () => {
    expect(
      composeSurfacePrompt("ask", {
        retrievedContext: "[Knowledge]\n- doc1",
        toolResults: "[Tool Results]\n- time_now -> 3pm"
      })
    ).toMatchSnapshot();
  });

  it("anchors identity at position 0 of the stable prefix", () => {
    expect(composeSurfacePrompt("ask", {}).startsWith(MUSE_IDENTITY_CORE)).toBe(true);
  });

  it("carries the ask surface role text", () => {
    expect(composeSurfacePrompt("ask", {})).toContain(SURFACE_ROLES.ask);
  });

  it("emits exactly one cache-boundary marker", () => {
    const prompt = composeSurfacePrompt("ask", { retrievedContext: "[Knowledge]\n- doc1" });
    const occurrences = prompt.split(MUSE_CACHE_BOUNDARY_MARKER).length - 1;
    expect(occurrences).toBe(1);
  });

  it("places fed dynamic content (retrieved/tool results) after the boundary", () => {
    const prompt = composeSurfacePrompt("ask", {
      retrievedContext: "FAKE_RETRIEVED_MARKER_XYZ",
      toolResults: "FAKE_TOOL_RESULT_MARKER_XYZ"
    });
    const boundary = prompt.indexOf(MUSE_CACHE_BOUNDARY_MARKER);
    expect(boundary).toBeGreaterThan(-1);
    expect(prompt.indexOf("FAKE_RETRIEVED_MARKER_XYZ")).toBeGreaterThan(boundary);
    expect(prompt.indexOf("FAKE_TOOL_RESULT_MARKER_XYZ")).toBeGreaterThan(boundary);
  });
});

// Phase 2+3 (docs/strategy/prompt-architecture.md §Migration): every remaining
// surface (brief/recall/council/reflect/pattern-suggestion/proactive/companion/
// tagline/planning, plus the council-synthesizer and the live in-chat
// reflection role added this slice) now composes through the same seam.
const MIGRATED_SURFACES = [
  "brief", "recall", "council", "councilSynthesis", "reflect", "chatReflect",
  "patternSuggestion", "proactive", "planning", "companion", "tagline", "documentRead"
] as const;

describe("composeSurfacePrompt — Phase 2+3 migrated surfaces", () => {
  it.each(MIGRATED_SURFACES)("%s: anchors identity at position 0 and carries its own role text", (surface) => {
    const prompt = composeSurfacePrompt(surface, {});
    expect(prompt.startsWith(MUSE_IDENTITY_CORE)).toBe(true);
    expect(prompt).toContain(SURFACE_ROLES[surface]);
  });

  it.each(MIGRATED_SURFACES)("%s: emits exactly one cache-boundary marker", (surface) => {
    const prompt = composeSurfacePrompt(surface, { retrievedContext: "[Knowledge]\n- doc1" });
    const occurrences = prompt.split(MUSE_CACHE_BOUNDARY_MARKER).length - 1;
    expect(occurrences).toBe(1);
  });

  it.each(MIGRATED_SURFACES)("%s: places fed dynamic content after the boundary", (surface) => {
    const prompt = composeSurfacePrompt(surface, {
      providerDynamicSuffix: "FAKE_DYNAMIC_SUFFIX_XYZ",
      retrievedContext: "FAKE_RETRIEVED_MARKER_XYZ"
    });
    const boundary = prompt.indexOf(MUSE_CACHE_BOUNDARY_MARKER);
    expect(boundary).toBeGreaterThan(-1);
    expect(prompt.indexOf("FAKE_RETRIEVED_MARKER_XYZ")).toBeGreaterThan(boundary);
    expect(prompt.indexOf("FAKE_DYNAMIC_SUFFIX_XYZ")).toBeGreaterThan(boundary);
  });

  it("golden snapshot per migrated surface", () => {
    const rendered = Object.fromEntries(
      MIGRATED_SURFACES.map((surface) => [surface, composeSurfacePrompt(surface, {})])
    );
    expect(rendered).toMatchSnapshot();
  });
});

describe("composeSurfacePrompt — per-layer token ceiling", () => {
  it("throws when a caller-supplied stable layer is over its token ceiling", () => {
    const overLong = "x".repeat(3000);
    expect(() =>
      composeSurfacePrompt("chat", {}, { layers: [{ content: overLong, id: "personality", section: "stable" }] })
    ).toThrow(/over its \d+ tok ceiling/u);
  });

  it("does not throw for real identity-core / surface-role content on any surface", () => {
    for (const surface of Object.keys(SURFACE_ROLES) as (keyof typeof SURFACE_ROLES)[]) {
      expect(() => composeSurfacePrompt(surface, {})).not.toThrow();
    }
  });
});
