import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";

import { MuseChatApp } from "./chat-ink.js";

// Drive the real Ink component (useInput → reduceInput → submit → render)
// through ink-testing-library's stdin so the interactive surface is actually
// verified, not just compiled. Closes the long-standing "PTY-absent, can't
// auto-verify the frame" risk for the slash-echo + command-output behaviour.

async function* empty(): AsyncGenerator<{ type: string }> { /* no events */ }

function makeProps(overrides: Record<string, unknown> = {}): Parameters<typeof MuseChatApp>[0] {
  return {
    banner: "MUSE",
    history: [],
    agents: [],
    model: "ollama/qwen3:8b",
    models: ["ollama/qwen3:8b"],
    proactiveOn: false,
    skills: [],
    skillsDir: "/tmp/skills",
    skillsPrompt: "",
    personaPrompt: () => undefined,
    stream: () => empty(),
    streamWithTools: () => empty(),
    readFile: async () => undefined,
    saveText: async () => undefined,
    copyToClipboard: async () => false,
    onCommit: () => undefined,
    onReset: () => undefined,
    memorySnapshot: async () => ({ facts: { user_name: "jinan" }, preferences: {}, recentTopics: [] }),
    forgetMemory: async () => true,
    recallSearch: async () => "no hits",
    todayBrief: async () => "Today (next 24h)\nTasks: (none open)",
    startJob: () => "job_test",
    jobsOverview: async () => [],
    recap: "",
    ...overrides
  } as Parameters<typeof MuseChatApp>[0];
}

const tick = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("MuseChatApp render — slash command echo + output", () => {
  it("echoes the typed command and shows its result in the transcript", async () => {
    const { stdin, lastFrame, unmount } = render(React.createElement(MuseChatApp, makeProps()));
    await tick();
    stdin.write("/memory");
    await tick();
    stdin.write("\r");
    await tick(120);
    const frame = lastFrame() ?? "";
    unmount();
    expect(frame).toContain("› /memory"); // the echo of what was typed
    expect(frame).toContain("What I remember about you"); // the command result, in-transcript
    expect(frame).toContain("user_name: jinan");
  });

  it("shows the fail-closed approval box for a gated tool and approves on y", async () => {
    let decision: boolean | undefined;
    const streamWithTools = (
      _messages: unknown,
      _model: string,
      requestApproval: (name: string, detail: string, kind: "outbound" | "tool") => Promise<boolean>
    ): AsyncGenerator<{ type: string; text?: string }> => (async function* () {
      decision = await requestApproval("email_send", "to: bob@x.com · subject: Hi", "outbound");
      yield { type: "text-delta", text: decision ? "sent." : "cancelled." };
      yield { type: "done" };
    })();

    const { stdin, lastFrame, unmount } = render(React.createElement(MuseChatApp, makeProps({ streamWithTools })));
    await tick();
    stdin.write("/tools"); await tick(); stdin.write("\r"); await tick(80); // enable tools
    stdin.write("email bob"); await tick(); stdin.write("\r"); await tick(120);
    const gated = lastFrame() ?? "";
    expect(gated).toContain("Outbound action — email_send");
    expect(gated).toContain("to: bob@x.com");
    stdin.write("y"); await tick(150); // approve
    unmount();
    expect(decision).toBe(true);
  });

  it("renders the launch brief as an opening turn when recap is set", async () => {
    const { lastFrame, unmount } = render(React.createElement(MuseChatApp, makeProps({
      recap: "♪ good morning\n\nToday (next 24h)",
      recapRole: "command"
    })));
    await tick(80);
    const frame = lastFrame() ?? "";
    unmount();
    expect(frame).toContain("good morning");
    expect(frame).toContain("Today (next 24h)");
  });
});
