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
    agents: [{ name: "researcher", description: "researches things", prompt: "You research." }],
    model: "ollama/qwen3:8b",
    models: ["ollama/qwen3:8b", "ollama/qwen3.6:35b-a3b"],
    proactiveOn: false,
    localOnly: true,
    skills: [{ name: "summarize", description: "summarize text" }],
    skillsDir: "/tmp/skills",
    skillsPromptFor: () => "",
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
    rememberFact: async () => true,
    setPreference: async () => true,
    wipeMemory: async () => true,
    trustInfo: async () => ({ trusted: [], blocked: [] }),
    recallSearch: async () => "no hits",
    todayBrief: async () => "Today (next 24h)\nTasks: (none open)",
    startJob: () => "job_test",
    jobsOverview: async () => [],
    recap: "",
    ...overrides
  } as Parameters<typeof MuseChatApp>[0];
}

const tick = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Ink renders asynchronously, so a fixed post-Enter wait flakes under load
// (the command output may not be in the frame yet → false miss). Poll the
// frame until every needle is present or a bounded timeout — fast when idle,
// robust under the full-suite parallel contention.
async function waitForFrame(
  lastFrame: () => string | undefined,
  needles: readonly string[],
  timeoutMs = 2000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let frame = lastFrame() ?? "";
  while (Date.now() < deadline && !needles.every((needle) => frame.includes(needle))) {
    await new Promise((r) => setTimeout(r, 20));
    frame = lastFrame() ?? "";
  }
  return frame;
}

describe("MuseChatApp render — slash command echo + output", () => {
  it("echoes the typed command and shows its result in the transcript", async () => {
    const { stdin, lastFrame, unmount } = render(React.createElement(MuseChatApp, makeProps()));
    await tick();
    stdin.write("/memory");
    await tick();
    stdin.write("\r");
    const frame = await waitForFrame(lastFrame, ["› /memory", "What I remember about you", "user_name: jinan"]);
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
    stdin.write("email bob"); await tick(); stdin.write("\r");
    const gated = await waitForFrame(lastFrame, ["Outbound action — email_send", "to: bob@x.com"]);
    expect(gated).toContain("Outbound action — email_send");
    expect(gated).toContain("to: bob@x.com");
    stdin.write("y"); // approve
    for (let i = 0; i < 100 && decision === undefined; i += 1) await tick(20);
    unmount();
    expect(decision).toBe(true);
  });

  it("/remember teaches a fact (echo + confirmation), closing the memory loop", async () => {
    let saved: { key: string; value: string } | undefined;
    const { stdin, lastFrame, unmount } = render(React.createElement(MuseChatApp, makeProps({
      rememberFact: async (key: string, value: string) => { saved = { key, value }; return true; }
    })));
    await tick();
    stdin.write("/remember city=Seoul"); await tick(); stdin.write("\r");
    const frame = await waitForFrame(lastFrame, ["› /remember city=Seoul", "✓ Remembered city: Seoul"]);
    unmount();
    expect(frame).toContain("› /remember city=Seoul");
    expect(frame).toContain("✓ Remembered city: Seoul");
    expect(saved).toEqual({ key: "city", value: "Seoul" });
  });

  it("/pref sets a preference (echo + confirmation)", async () => {
    let saved: { key: string; value: string } | undefined;
    const { stdin, lastFrame, unmount } = render(React.createElement(MuseChatApp, makeProps({
      setPreference: async (key: string, value: string) => { saved = { key, value }; return true; }
    })));
    await tick();
    stdin.write("/pref reply_style=concise"); await tick(); stdin.write("\r");
    const frame = await waitForFrame(lastFrame, ["› /pref reply_style=concise", "✓ Preference reply_style: concise"]);
    unmount();
    expect(frame).toContain("› /pref reply_style=concise");
    expect(frame).toContain("✓ Preference reply_style: concise");
    expect(saved).toEqual({ key: "reply_style", value: "concise" });
  });

  it("/remember shows a visible supersede when overwriting an existing fact", async () => {
    const { stdin, lastFrame, unmount } = render(React.createElement(MuseChatApp, makeProps({
      memorySnapshot: async () => ({ facts: { city: "Seoul" }, preferences: {}, recentTopics: [] }),
      rememberFact: async () => true
    })));
    await tick();
    stdin.write("/remember city=Busan"); await tick(); stdin.write("\r");
    const frame = await waitForFrame(lastFrame, ["✓ Updated city: Seoul → Busan"]);
    unmount();
    expect(frame).toContain("✓ Updated city: Seoul → Busan");
  });

  it("/forget resolves a substring key and reports ambiguity safely", async () => {
    const forgotten: string[] = [];
    const props = makeProps({
      memorySnapshot: async () => ({ facts: { user_name: "jinan", city: "Seoul", work_city: "Busan" }, preferences: {}, recentTopics: [] }),
      forgetMemory: async (k: string) => { forgotten.push(k); return true; }
    });
    // unique substring "name" → user_name
    const a = render(React.createElement(MuseChatApp, props));
    await tick(); a.stdin.write("/forget name"); await tick(); a.stdin.write("\r");
    expect(await waitForFrame(a.lastFrame, ['✓ Forgot "user_name".'])).toContain('✓ Forgot "user_name".');
    a.unmount();
    expect(forgotten).toEqual(["user_name"]);
    // ambiguous "cit" → matches city + work_city, no exact → asks, forgets nothing
    forgotten.length = 0;
    const b = render(React.createElement(MuseChatApp, props));
    await tick(); b.stdin.write("/forget cit"); await tick(); b.stdin.write("\r");
    const fb = await waitForFrame(b.lastFrame, ["matches 2", "Be more specific"]);
    b.unmount();
    expect(fb).toContain("matches 2");
    expect(fb).toContain("Be more specific");
    expect(forgotten).toEqual([]);
  });

  it("↑ recalls a prior-session input from the seeded history", async () => {
    const { stdin, lastFrame, unmount } = render(React.createElement(MuseChatApp, makeProps({
      inputHistorySeed: ["what's due today?"]
    })));
    await tick();
    stdin.write("\u001B[A"); // up arrow
    const frame = await waitForFrame(lastFrame, ["what's due today?"]);
    unmount();
    expect(frame).toContain("what's due today?");
  });

  it("surfaces an auto-learned memory notice after a turn", async () => {
    const { stdin, lastFrame, unmount } = render(React.createElement(MuseChatApp, makeProps({
      autoLearn: async () => "📝 remembered: home_city = Busan (/forget <key> to undo)"
    })));
    await tick();
    stdin.write("by the way I live in Busan"); await tick(); stdin.write("\r");
    const frame = await waitForFrame(lastFrame, ["📝 remembered: home_city = Busan"]);
    unmount();
    expect(frame).toContain("📝 remembered: home_city = Busan");
  });

  it("groups several due items into ONE proactive notice (not a wall)", async () => {
    const due = new Date().toISOString();
    const { lastFrame, unmount } = render(React.createElement(MuseChatApp, makeProps({
      proactiveCheck: async () => [
        { id: "r1", text: "Dentist", dueAt: due },
        { id: "r2", text: "Pay rent", dueAt: due }
      ]
    })));
    // The idle proactive tick first fires at ~1500ms; poll up to 3s for it.
    const frame = await waitForFrame(lastFrame, ["📌 2 things need you:", "Dentist", "Pay rent"], 3000);
    unmount();
    expect(frame).toContain("📌 2 things need you:");
    expect(frame).toContain("Dentist");
    expect(frame).toContain("Pay rent");
  });

  it("surfaces a due check-in AND a pattern suggestion in-chat via proactiveNudges (P-N3)", async () => {
    const { lastFrame, unmount } = render(React.createElement(MuseChatApp, makeProps({
      proactiveNudges: async () => [
        { id: "checkin:c1", text: "📌 Following up — you mentioned you'd \"email Bob\". How did it go?" },
        { id: "pattern:p1", text: "💡 월요일마다 보고서 만드시던데, 지금 초안 잡아둘까요?" }
      ]
    })));
    const frame = await waitForFrame(lastFrame, ["📌 Following up", "email Bob", "💡 월요일마다"], 3000);
    unmount();
    expect(frame).toContain("📌 Following up");
    expect(frame).toContain("💡 월요일마다 보고서 만드시던데");
  });

  it("renders the launch brief as an opening turn when recap is set", async () => {
    const { lastFrame, unmount } = render(React.createElement(MuseChatApp, makeProps({
      recap: "♪ good morning\n\nToday (next 24h)",
      recapRole: "command"
    })));
    const frame = await waitForFrame(lastFrame, ["good morning", "Today (next 24h)"]);
    unmount();
    expect(frame).toContain("good morning");
    expect(frame).toContain("Today (next 24h)");
  });
});

describe("MuseChatApp render — every slash command responds", () => {
  // Each entry: type the input, Enter, then assert the frame contains every
  // listed substring (echo of what was typed + the command's own output).
  const cases: ReadonlyArray<{ readonly input: string; readonly contains: readonly string[] }> = [
    { input: "/help", contains: ["› /help", "Commands:", "/today"] },
    { input: "/help cost", contains: ["session"] }, // desc fallback for a topic-less command
    { input: "/model ollama/qwen3.6:35b-a3b", contains: ["Switched model to ollama/qwen3.6:35b-a3b"] },
    { input: "/agents", contains: ["› /agents", "researcher"] },
    { input: "/agent researcher", contains: ["Switched to 'researcher'"] },
    { input: "/agent default", contains: ["Back to the default Muse"] },
    { input: "/skills", contains: ["› /skills", "summarize"] },
    { input: "/tools", contains: ["› /tools", "Tools ON"] },
    { input: "/today", contains: ["› /today", "Today (next 24h)"] },
    { input: "/job research X", contains: ["› /job research X", "Started background job job_test"] },
    { input: "/jobs", contains: ["› /jobs", "No background jobs yet"] },
    { input: "/memory", contains: ["› /memory", "What I remember about you", "user_name: jinan"] },
    { input: "/remember city=Seoul", contains: ["✓ Remembered city: Seoul"] },
    { input: "/pref reply_style=concise", contains: ["✓ Preference reply_style: concise"] },
    { input: "/recall budget", contains: ["› /recall budget", "no hits"] },
    { input: "/forget user_name", contains: ["✓ Forgot \"user_name\"."] },
    { input: "/forget --all", contains: ["Wiped everything"] },
    { input: "/trust", contains: ["› /trust", "Trusted tools (0)"] },
    { input: "/persona", contains: ["› /persona", "persona"] },
    { input: "/history", contains: ["› /history", "turns in this conversation"] },
    { input: "/cost", contains: ["› /cost", "No tokens used yet"] },
    { input: "/save", contains: ["Nothing to save yet"] },
    { input: "/copy", contains: ["Nothing to save yet"] },
    { input: "/bogus", contains: ["Unknown command: /bogus"] }
  ];

  for (const c of cases) {
    it(`${c.input} → ${c.contains[0] ?? ""}`, async () => {
      const { stdin, lastFrame, unmount } = render(React.createElement(MuseChatApp, makeProps()));
      await tick();
      stdin.write(c.input); await tick(); stdin.write("\r");
      const frame = await waitForFrame(lastFrame, c.contains);
      unmount();
      for (const needle of c.contains) expect(frame, `"${c.input}" frame missing: ${needle}`).toContain(needle);
    });
  }
});

describe("MuseChatApp render — plain chat + editing", () => {
  it("a plain message streams an assistant reply into the transcript", async () => {
    async function* reply(): AsyncGenerator<{ type: string; text?: string }> {
      yield { type: "text-delta", text: "Hello " };
      yield { type: "text-delta", text: "there." };
      yield { type: "done" };
    }
    let committed: { user: string; assistant: string } | undefined;
    const { stdin, lastFrame, unmount } = render(React.createElement(MuseChatApp, makeProps({
      stream: () => reply(),
      onCommit: (user: string, assistant: string) => { committed = { user, assistant }; }
    })));
    await tick();
    stdin.write("hi muse"); await tick(); stdin.write("\r");
    const frame = await waitForFrame(lastFrame, ["› hi muse", "Hello there."]);
    unmount();
    expect(frame).toContain("› hi muse");
    expect(frame).toContain("Hello there.");
    expect(committed).toEqual({ assistant: "Hello there.", user: "hi muse" });
  });

  it("injects the per-turn grounding block into the system message the model receives", async () => {
    // The verification the pipe-driven efficacy test could NOT do: the Ink
    // INTERACTIVE path is a separate code path from headless `runLocalChat`,
    // and a grounding fix that never reaches THIS path's `stream` call is a
    // no-op. Capture the system message and assert the block is present.
    let capturedSystem = "";
    async function* reply(): AsyncGenerator<{ type: string; text?: string }> {
      yield { type: "text-delta", text: "1380." };
      yield { type: "done" };
    }
    const { stdin, lastFrame, unmount } = render(React.createElement(MuseChatApp, makeProps({
      groundingFor: async (msg: string) =>
        msg.includes("VPN")
          ? { block: "\n\n[NOTES] Office VPN MTU is 1380. [from vpn.md]", matches: [{ cosine: 0.9, score: 0.9, source: "vpn.md", text: "Office VPN MTU is 1380." }] }
          : { block: "", matches: [] },
      stream: (messages: readonly { role: string; content: string }[]) => {
        capturedSystem = messages.find((m) => m.role === "system")?.content ?? "";
        return reply();
      }
    })));
    await tick();
    stdin.write("what is my office VPN MTU?"); await tick(); stdin.write("\r");
    await waitForFrame(lastFrame, ["1380."]);
    unmount();
    expect(capturedSystem).toContain("Office VPN MTU is 1380.");
    expect(capturedSystem).toContain("[from vpn.md]");
  });

  it("applies finalizeAnswer to the streamed bubble AND the committed history (the audit's ink-gate hole)", async () => {
    let committed = "";
    async function* fabricated(): AsyncGenerator<{ type: string; text?: string }> {
      yield { text: "my cat is called Nabi", type: "text-delta" };
      yield { type: "done" };
    }
    const { stdin, lastFrame, unmount } = render(React.createElement(MuseChatApp, makeProps({
      finalizeAnswer: async () => ({ display: "I don't have that recorded yet.", forHistory: "I don't have that recorded yet.", untrustedOnly: false }),
      onCommit: (_q: string, answer: string) => { committed = answer; },
      stream: () => fabricated()
    })));
    await tick();
    stdin.write("what is my cat's name?"); await tick(); stdin.write("\r");
    await waitForFrame(lastFrame, ["recorded yet"]);
    expect(committed).toContain("recorded yet");
    expect(committed).not.toContain("Nabi");
    unmount();
  });

  it("commits forHistory (cue-free) to history, NOT the display string with the source-check cue (grounded≠true self-pollution guard)", async () => {
    let committed = "";
    async function* streamRaw(): AsyncGenerator<{ type: string; text?: string }> {
      yield { text: "your tasks: write report", type: "text-delta" };
      yield { type: "done" };
    }
    // DISTINCT display vs forHistory: display carries the ⚠️ source-check cue, forHistory does not.
    // A mis-route of the persist site (persisted→accumulated) would commit the cue → this goes RED.
    const { stdin, lastFrame, unmount } = render(React.createElement(MuseChatApp, makeProps({
      finalizeAnswer: async () => ({
        display: "your tasks: write report\n\n⚠️ 출처 확인: 도구로 가져온 데이터(tool-fetched)에만 근거합니다.",
        forHistory: "your tasks: write report",
        untrustedOnly: true
      }),
      onCommit: (_q: string, answer: string) => { committed = answer; },
      stream: () => streamRaw()
    })));
    await tick();
    stdin.write("what are my tasks?"); await tick(); stdin.write("\r");
    await waitForFrame(lastFrame, ["출처 확인"]); // the cue IS shown to the user (display)
    expect(committed).toBe("your tasks: write report"); // ...but history gets the cue-free forHistory
    expect(committed).not.toContain("출처 확인");
    unmount();
  });

  it("injects nothing when groundingFor finds nothing relevant (casual chat unaffected)", async () => {
    let capturedSystem = "__unset__";
    async function* reply(): AsyncGenerator<{ type: string; text?: string }> {
      yield { type: "text-delta", text: "Hey!" };
      yield { type: "done" };
    }
    const { stdin, lastFrame, unmount } = render(React.createElement(MuseChatApp, makeProps({
      groundingFor: async () => ({ block: "", matches: [] }),
      stream: (messages: readonly { role: string; content: string }[]) => {
        capturedSystem = messages.find((m) => m.role === "system")?.content ?? "";
        return reply();
      }
    })));
    await tick();
    stdin.write("hey how are you"); await tick(); stdin.write("\r");
    await waitForFrame(lastFrame, ["Hey!"]);
    unmount();
    expect(capturedSystem).not.toContain("[NOTES]");
    expect(capturedSystem).not.toContain("[from ");
  });

  it("/new acknowledges a fresh conversation (clears in-memory context)", async () => {
    // Note: <Static> scrollback can't be un-printed in a real terminal, so /new
    // clears historyRef + turns state (future context) — the observable signal
    // is the acknowledgement line.
    const { stdin, lastFrame, unmount } = render(React.createElement(MuseChatApp, makeProps()));
    await tick();
    stdin.write("/new"); await tick(); stdin.write("\r");
    const frame = await waitForFrame(lastFrame, ["Started a new conversation"]);
    unmount();
    expect(frame).toContain("Started a new conversation");
  });
});

describe("MuseChatApp HUD — local-only privacy posture", () => {
  it("shows a 🔒 local badge in the HUD when local-only is on (the default)", async () => {
    const { lastFrame, unmount } = render(React.createElement(MuseChatApp, makeProps({ localOnly: true })));
    await tick();
    const frame = lastFrame() ?? "";
    unmount();
    expect(frame).toContain("🔒 local");
    expect(frame).not.toContain("⚠ cloud");
  });

  it("warns ⚠ cloud in the HUD when local-only is off (cloud egress possible)", async () => {
    const { lastFrame, unmount } = render(React.createElement(MuseChatApp, makeProps({ localOnly: false })));
    await tick();
    const frame = lastFrame() ?? "";
    unmount();
    expect(frame).toContain("⚠ cloud");
    expect(frame).not.toContain("🔒 local");
  });
});
