import { describe, expect, it } from "vitest";

import {
  REVERIFY_NUDGE,
  ReverifyNudgeTracker,
  hasRunVerifyIntent,
  toolsIncludeExecute
} from "../src/reverify-nudge.js";

const exec = { hasExecuteTool: true, runIntent: true };

describe("ReverifyNudgeTracker", () => {
  it("nudges once when an edit was never verified by a re-run", () => {
    const t = new ReverifyNudgeTracker();
    t.recordTool("write");
    expect(t.consumeNudge(exec)).toBe(true);
    // one-shot: never fires a second time
    expect(t.consumeNudge(exec)).toBe(false);
  });

  it("does NOT nudge after an execute-risk run clears the pending edit", () => {
    const t = new ReverifyNudgeTracker();
    t.recordTool("write");
    t.recordTool("execute");
    expect(t.consumeNudge(exec)).toBe(false);
  });

  it("does NOT nudge without a pending edit", () => {
    const t = new ReverifyNudgeTracker();
    expect(t.consumeNudge(exec)).toBe(false);
    t.recordTool("read");
    expect(t.consumeNudge(exec)).toBe(false);
  });

  it("does NOT nudge when no execute tool is available (re-run impossible)", () => {
    const t = new ReverifyNudgeTracker();
    t.recordTool("write");
    expect(t.consumeNudge({ hasExecuteTool: false, runIntent: true })).toBe(false);
  });

  it("does NOT nudge when the task has no run/verify intent", () => {
    const t = new ReverifyNudgeTracker();
    t.recordTool("write");
    expect(t.consumeNudge({ hasExecuteTool: true, runIntent: false })).toBe(false);
  });

  it("a later edit after a verified run re-arms the nudge (still one-shot overall)", () => {
    const t = new ReverifyNudgeTracker();
    t.recordTool("write");
    t.recordTool("execute"); // verified
    t.recordTool("write"); // new unverified edit
    expect(t.consumeNudge(exec)).toBe(true);
    expect(t.consumeNudge(exec)).toBe(false);
  });
});

describe("hasRunVerifyIntent", () => {
  it("detects run/test/verify intent in the user message (EN + KO)", () => {
    expect(hasRunVerifyIntent([{ content: "fix the bug and run the test", role: "user" }])).toBe(true);
    expect(hasRunVerifyIntent([{ content: "테스트를 실행해서 확인해줘", role: "user" }])).toBe(true);
  });

  it("is false for a pure edit/read task with no verify intent", () => {
    expect(hasRunVerifyIntent([{ content: "rename this variable everywhere", role: "user" }])).toBe(false);
  });

  it("ignores non-user messages", () => {
    expect(hasRunVerifyIntent([{ content: "run the test", role: "system" }])).toBe(false);
  });
});

describe("toolsIncludeExecute", () => {
  it("is true when an execute-risk tool is offered", () => {
    expect(toolsIncludeExecute([{ description: "", inputSchema: {}, name: "run_command", risk: "execute" }])).toBe(true);
  });

  it("is false for read/write-only toolsets and undefined", () => {
    expect(toolsIncludeExecute([{ description: "", inputSchema: {}, name: "file_edit", risk: "write" }])).toBe(false);
    expect(toolsIncludeExecute(undefined)).toBe(false);
  });
});

describe("REVERIFY_NUDGE", () => {
  it("instructs re-running the verifying command", () => {
    expect(REVERIFY_NUDGE).toMatch(/re-run/i);
  });
});
