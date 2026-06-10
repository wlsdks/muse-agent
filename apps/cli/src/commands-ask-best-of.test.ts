import { describe, expect, it } from "vitest";

import { selectBestGroundedDraft } from "@muse/agent-core";
import type { KnowledgeMatch } from "@muse/agent-core";

import { drawBestGroundedRedraft } from "./commands-ask.js";

const matches: readonly KnowledgeMatch[] = [
  { cosine: 1, score: 1, source: "notes/wifi.md", text: "office vpn mtu is 1380 set on june second" }
];

const passthrough = (draft: string): string => draft;

describe("drawBestGroundedRedraft (--best-of resample orchestration)", () => {
  it("adopts the grounded survivor through the real selector and the confirm gate", async () => {
    const drafts = [
      "the mtu is 9999 configured through the cisco fabric controller",
      "office vpn mtu is 1380 [from notes/wifi.md]"
    ];
    let confirmed: string | undefined;
    const survivor = await drawBestGroundedRedraft({
      attempts: 2,
      clean: passthrough,
      confirm: (verdictText) => {
        confirmed = verdictText;
        return Promise.resolve(undefined);
      },
      draw: () => Promise.resolve(drafts.shift() ?? ""),
      expand: passthrough,
      isRefusal: () => false,
      select: (candidates) => selectBestGroundedDraft(candidates, matches, "office vpn mtu")
    });
    expect(survivor).toBe("office vpn mtu is 1380 [from notes/wifi.md]");
    expect(confirmed).toBe(survivor);
  });

  it("returns undefined when every redraw is a refusal or empty — nothing to select", async () => {
    const drafts = ["", "잘 모르겠어요"];
    const survivor = await drawBestGroundedRedraft({
      attempts: 2,
      clean: passthrough,
      confirm: () => Promise.resolve(undefined),
      draw: () => Promise.resolve(drafts.shift() ?? ""),
      expand: passthrough,
      isRefusal: (draft) => draft.includes("모르겠"),
      select: (candidates) => selectBestGroundedDraft(candidates, matches, "office vpn mtu")
    });
    expect(survivor).toBeUndefined();
  });

  it("fail-close: the survivor is dropped when the full confirm gate still fires", async () => {
    const survivor = await drawBestGroundedRedraft({
      attempts: 1,
      clean: passthrough,
      confirm: () => Promise.resolve("⚠ still not grounded"),
      draw: () => Promise.resolve("office vpn mtu is 1380 [from notes/wifi.md]"),
      expand: passthrough,
      isRefusal: () => false,
      select: (candidates) => selectBestGroundedDraft(candidates, matches, "office vpn mtu")
    });
    expect(survivor).toBeUndefined();
  });

  it("draws exactly `attempts` times", async () => {
    let draws = 0;
    await drawBestGroundedRedraft({
      attempts: 3,
      clean: passthrough,
      confirm: () => Promise.resolve(undefined),
      draw: () => {
        draws += 1;
        return Promise.resolve("");
      },
      expand: passthrough,
      isRefusal: () => false,
      select: () => undefined
    });
    expect(draws).toBe(3);
  });
});
