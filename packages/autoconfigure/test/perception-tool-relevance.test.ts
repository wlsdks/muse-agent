import { DefaultToolFilter } from "@muse/agent-core";
import { createEmailReadTool, createWeatherTool, type EmailProvider } from "@muse/domain-tools";
import { describe, expect, it } from "vitest";

// Natural-prompt exposure for weather + email, through the REAL filter.
// Word-boundary keyword matching meant plurals/inflections ("emails",
// "raining") dropped these tools; this guards the fix.
const filter = new DefaultToolFilter();
const stubEmail = { listRecent: async () => [] } as unknown as EmailProvider;
const tools = [createWeatherTool(), createEmailReadTool({ provider: stubEmail })];

function surfaced(userMessage: string): string[] {
  return filter.filter(tools, { userMessage }).map((t) => t.definition.name);
}

describe("weather + email tools surface for natural / inflected prompts", () => {
  it("'is it raining right now?' surfaces weather", () => {
    expect(surfaced("is it raining right now?")).toContain("weather");
  });

  it("'what's the weather today?' surfaces weather", () => {
    expect(surfaced("what's the weather today?")).toContain("weather");
  });

  it("'any new emails?' (plural) surfaces email_recent", () => {
    expect(surfaced("any new emails?")).toContain("email_recent");
  });

  it("'오늘 날씨 어때?' (Korean weather) surfaces weather", () => {
    expect(surfaced("오늘 날씨 어때?")).toContain("weather");
  });

  it("an unrelated prompt surfaces NEITHER (small exposed set)", () => {
    expect(surfaced("what is the capital of France?")).toEqual([]);
  });
});
