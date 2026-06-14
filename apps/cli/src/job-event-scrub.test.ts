import { describe, expect, it } from "vitest";

import { scrubJobEvent } from "./job-event-scrub.js";

describe("scrubJobEvent", () => {
  it("redacts credential shapes from the `prompt` field on a started event", () => {
    const scrubbed = scrubJobEvent({
      type: "started",
      prompt: "rotate sk-proj-abcdefghijklmnopqrstuvwxyz tomorrow",
      model: "ollama/qwen3.5:9b-q4_K_M",
      userKey: "stark@work"
    });
    expect(scrubbed.prompt).toBe("rotate [redacted-openai-key] tomorrow");
    expect(scrubbed.type).toBe("started");
    expect(scrubbed.model).toBe("ollama/qwen3.5:9b-q4_K_M");
    expect(scrubbed.userKey).toBe("stark@work");
  });

  it("redacts credential shapes from the `text` field on progress / result / error events", () => {
    expect(scrubJobEvent({ type: "progress", text: "noted ghp_abcdefghijklmnopqrstuvwxyzABCDEF" }).text)
      .toBe("noted [redacted-github-pat]");
    expect(scrubJobEvent({ type: "result", text: "Done. AKIAIOSFODNN7EXAMPLE retired." }).text)
      .toContain("[redacted-aws-access-key]");
    expect(scrubJobEvent({ type: "error", text: "401 from sk-ant-api03-abcdefghijklmnop" }).text)
      .toContain("[redacted-anthropic-key]");
  });

  it("leaves clean text untouched (no double-flagging on already-scrubbed content)", () => {
    const event = { type: "result", text: "All keys rotated. No further action." };
    expect(scrubJobEvent(event).text).toBe("All keys rotated. No further action.");
  });

  it("only redacts the `prompt` + `text` fields — structural fields pass through", () => {
    // A `model` or `userKey` that *happens* to look credential-shaped
    // shouldn't be mangled. (Field-allowlist is narrow by design.)
    const scrubbed = scrubJobEvent({
      type: "started",
      model: "sk-some-internal-model-id-name",  // not really a key, but matches openai-key regex
      userKey: "ghp_team_alias"                 // ditto for github-pat regex
    });
    // These fields aren't in REDACT_FIELDS so they pass through.
    expect(scrubbed.model).toBe("sk-some-internal-model-id-name");
    expect(scrubbed.userKey).toBe("ghp_team_alias");
  });

  it("returns a shallow clone — input isn't mutated", () => {
    const input = { type: "progress", text: "secret sk-proj-abcdefghijklmnopqrstuvwxyz" };
    const before = input.text;
    scrubJobEvent(input);
    expect(input.text).toBe(before);
  });
});
