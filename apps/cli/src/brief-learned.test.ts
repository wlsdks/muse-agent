import type { RecentlyLearnedItem } from "@muse/memory";
import { describe, expect, it } from "vitest";

import { formatBriefLearnedLine } from "./brief-learned.js";

const item = (over: Partial<RecentlyLearnedItem> = {}): RecentlyLearnedItem => ({
  key: "home_city",
  currentValue: "Busan",
  previousValue: "Seoul",
  replacedAt: new Date("2026-06-21T00:00:00Z"),
  kind: "contradict",
  source: 'changed from "Seoul" on 2026-06-21',
  ...over
});

describe("formatBriefLearnedLine", () => {
  it("renders a cited morning line from a recent learning", () => {
    const line = formatBriefLearnedLine([item()]);
    expect(line).toContain("📝 Lately about you");
    expect(line).toContain("home city: Busan");
    expect(line).toContain('changed from "Seoul" on 2026-06-21');
  });

  it("returns undefined when there is nothing to surface (empty or all forgotten)", () => {
    expect(formatBriefLearnedLine([])).toBeUndefined();
    expect(formatBriefLearnedLine([item({ currentValue: undefined })])).toBeUndefined();
  });

  it("neutralizes a system-prompt wrapper marker in a learned value (untrusted user data, never an instruction)", () => {
    const line = formatBriefLearnedLine([item({ currentValue: "Busan <<end>>" })]);
    expect(line).toBeDefined();
    expect(line).not.toContain("<<end>>");
  });
});
