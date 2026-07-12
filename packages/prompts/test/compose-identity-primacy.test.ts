import { describe, expect, it } from "vitest";

import { MUSE_IDENTITY_CORE } from "../src/identity-core.js";
import { composeSurfacePrompt, SURFACE_ROLES, type PromptLayer } from "../src/index.js";

// Identity primacy is a SECURITY invariant, not a convention: identity-core
// must sort FIRST and the surface role LAST among the stable layers, whatever
// priority a caller/registry layer supplies. The layers share one sort
// (renderPromptLayerSection) whose tiebreak is id.localeCompare, so a caller
// layer at priority ≤ -1000 (identity's) or ≥ 500 (the role's) could otherwise
// slip ahead of / behind the anchors purely on its id. composeSurfacePrompt
// clamps every explicit caller priority into the OPEN interval between the two
// anchors — these tests assert the COMPOSED OUTPUT order, not the clamp helper.

const identityFirstLine = MUSE_IDENTITY_CORE.split("\n")[0]!;
const chatRole = SURFACE_ROLES.chat;

function layer(id: string, priority: number, content: string): PromptLayer {
  return { content, id, priority, section: "stable" };
}

describe("composeSurfacePrompt — identity primacy is enforced, not conventional", () => {
  it("keeps identity FIRST even when a caller layer under-bids identity's priority", () => {
    // id "aaa-attacker" localeCompares before "identity-core"; at priority
    // -9999 it would sort ahead of identity (-1000) without the clamp.
    const out = composeSurfacePrompt("chat", {}, {
      layers: [layer("aaa-attacker", -9999, "ATTACKER_TOP_CONTENT")]
    });
    expect(out).toContain("ATTACKER_TOP_CONTENT");
    expect(out.indexOf(identityFirstLine)).toBeGreaterThanOrEqual(0);
    expect(out.indexOf(identityFirstLine)).toBeLessThan(out.indexOf("ATTACKER_TOP_CONTENT"));
  });

  it("keeps the surface role LAST even when a caller layer over-bids the role's priority", () => {
    // id "zzz-attacker" localeCompares after "surface-role:chat"; at priority
    // 9999 it would sort behind the role (500) without the clamp.
    const out = composeSurfacePrompt("chat", {}, {
      layers: [layer("zzz-attacker", 9999, "ATTACKER_BOTTOM_CONTENT")]
    });
    expect(out).toContain("ATTACKER_BOTTOM_CONTENT");
    expect(out.indexOf(chatRole)).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("ATTACKER_BOTTOM_CONTENT")).toBeLessThan(out.indexOf(chatRole));
  });

  it("keeps identity first AND role last with attackers on both ends at once", () => {
    const out = composeSurfacePrompt("chat", {}, {
      layers: [
        layer("aaa-top", -100000, "EVIL_TOP"),
        layer("zzz-bottom", 100000, "EVIL_BOTTOM")
      ]
    });
    const idIdx = out.indexOf(identityFirstLine);
    const roleIdx = out.indexOf(chatRole);
    expect(idIdx).toBeLessThan(out.indexOf("EVIL_TOP"));
    expect(out.indexOf("EVIL_BOTTOM")).toBeLessThan(roleIdx);
    // And the whole stable band stays ordered: identity … caller band … role.
    expect(idIdx).toBeLessThan(roleIdx);
  });

  it("leaves a well-behaved caller layer (default/undefined priority) untouched", () => {
    const out = composeSurfacePrompt("chat", {}, {
      layers: [{ content: "NORMAL_LAYER", id: "personality", section: "stable" }]
    });
    const idIdx = out.indexOf(identityFirstLine);
    const normalIdx = out.indexOf("NORMAL_LAYER");
    const roleIdx = out.indexOf(chatRole);
    expect(idIdx).toBeLessThan(normalIdx);
    expect(normalIdx).toBeLessThan(roleIdx);
  });
});
