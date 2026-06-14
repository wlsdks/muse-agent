import { describe, expect, it } from "vitest";

import {
  buildTurnMessages,
  type ChatTurnMessage,
  resolveChatHistoryWindow,
  chatHelp,
  cursorCoords,
  displayWidth,
  emptyInput,
  extractAttachmentPaths,
  imageMimeForPath,
  friendlyError,
  buildRecap,
  chatToolApprovalGate,
  firstOpenToday,
  formatJobsList,
  composeMorningGreeting,
  formatMemoryView,
  recurringEpisodeThreads,
  formatRecallHits,
  formatTrust,
  greetingName,
  matchAgentNames,
  matchModelNames,
  parseInlineSpans,
  parseMarkdownBlocks,
  parseRememberArg,
  matchSlashCommands,
  parseSlashCommand,
  reduceInput,
  resolveForgetKey,
  summarizeToolArgs,
  type InputState
} from "./chat-ink-core.js";

const at = (value: string, cursor: number): InputState => ({ cursor, value });

describe("displayWidth", () => {
  it("counts ASCII as 1 and Hangul/CJK as 2", () => {
    expect(displayWidth("hi")).toBe(2);
    expect(displayWidth("안녕")).toBe(4);
    expect(displayWidth("a안")).toBe(3);
  });
});

describe("reduceInput — editing", () => {
  it("inserts printable text at the cursor", () => {
    const r = reduceInput(at("ac", 1), "b", {});
    expect(r.state).toEqual({ cursor: 2, value: "abc" });
    expect(r.submit).toBe(false);
  });

  it("Enter submits; Shift+Enter and Alt+Enter insert a newline", () => {
    expect(reduceInput(at("hi", 2), "\r", { return: true }).submit).toBe(true);
    expect(reduceInput(at("hi", 2), "\r", { return: true, shift: true }).state).toEqual({ cursor: 3, value: "hi\n" });
    expect(reduceInput(at("hi", 2), "\r", { return: true, meta: true }).state.value).toBe("hi\n");
  });

  it("Backspace deletes one codepoint (whole Hangul syllable)", () => {
    expect(reduceInput(at("안녕", 2), "", { backspace: true }).state).toEqual({ cursor: 1, value: "안" });
    expect(reduceInput(at("", 0), "", { backspace: true }).state).toEqual(emptyInput);
  });

  it("Alt+Backspace and Ctrl+W delete the previous word", () => {
    expect(reduceInput(at("hello world", 11), "", { backspace: true, meta: true }).state).toEqual({ cursor: 6, value: "hello " });
    expect(reduceInput(at("hello world", 11), "w", { ctrl: true }).state.value).toBe("hello ");
  });

  it("Ctrl+U clears to the start of the current line", () => {
    expect(reduceInput(at("ab\ncde", 6), "u", { ctrl: true }).state).toEqual({ cursor: 3, value: "ab\n" });
  });

  it("Ctrl+A / Ctrl+E jump to line start / end; arrows move the cursor", () => {
    expect(reduceInput(at("ab\ncd", 5), "a", { ctrl: true }).state.cursor).toBe(3);
    expect(reduceInput(at("ab\ncd", 3), "e", { ctrl: true }).state.cursor).toBe(5);
    expect(reduceInput(at("abc", 1), "", { leftArrow: true }).state.cursor).toBe(0);
    expect(reduceInput(at("abc", 1), "", { rightArrow: true }).state.cursor).toBe(2);
  });

  it("Up / Down move between lines keeping the column", () => {
    expect(reduceInput(at("abcd\nef", 6), "", { upArrow: true }).state.cursor).toBe(1); // col 1 on line 0
    expect(reduceInput(at("ab\ncdef", 1), "", { downArrow: true }).state.cursor).toBe(4); // col 1 on line 1
  });
});

describe("cursorCoords", () => {
  it("reports line + wide-aware column", () => {
    expect(cursorCoords(at("안녕", 2))).toEqual({ col: 4, line: 0 }); // 2 wide chars
    expect(cursorCoords(at("ab\ncd", 4))).toEqual({ col: 1, line: 1 });
  });
});

describe("buildTurnMessages", () => {
  it("system first, history middle, user last", () => {
    const out = buildTurnMessages("sys", [{ content: "hi", role: "user" }], "q");
    expect(out[0]).toEqual({ content: "sys", role: "system" });
    expect(out[out.length - 1]).toEqual({ content: "q", role: "user" });
  });
  it("windows history to the last N messages, keeping system + current message", () => {
    const history = Array.from({ length: 10 }, (_, i): ChatTurnMessage => ({ content: `m${i}`, role: i % 2 === 0 ? "user" : "assistant" }));
    const out = buildTurnMessages("sys", history, "now", 4);
    expect(out[0]).toEqual({ content: "sys", role: "system" });
    expect(out[out.length - 1]).toEqual({ content: "now", role: "user" });
    // middle = last 4 of history (m6..m9)
    expect(out.slice(1, -1).map((m) => m.content)).toEqual(["m6", "m7", "m8", "m9"]);
  });
  it("is a no-op when history is at or under the window (or window undefined)", () => {
    const history = [{ content: "a", role: "user" as const }, { content: "b", role: "assistant" as const }];
    expect(buildTurnMessages("s", history, "q", 5).slice(1, -1).map((m) => m.content)).toEqual(["a", "b"]);
    expect(buildTurnMessages("s", history, "q").slice(1, -1).map((m) => m.content)).toEqual(["a", "b"]);
  });
});

describe("resolveChatHistoryWindow", () => {
  it("defaults to 40, honors a valid override, ignores junk/negative", () => {
    expect(resolveChatHistoryWindow({})).toBe(40);
    expect(resolveChatHistoryWindow({ MUSE_CHAT_HISTORY_WINDOW: "12" })).toBe(12);
    expect(resolveChatHistoryWindow({ MUSE_CHAT_HISTORY_WINDOW: "0" })).toBe(0);
    expect(resolveChatHistoryWindow({ MUSE_CHAT_HISTORY_WINDOW: "-5" })).toBe(40);
    expect(resolveChatHistoryWindow({ MUSE_CHAT_HISTORY_WINDOW: "abc" })).toBe(40);
  });
});

describe("matchSlashCommands", () => {
  const cmds = [{ cmd: "help", desc: "h" }, { cmd: "clear", desc: "c" }, { cmd: "exit", desc: "e" }];
  it("returns nothing for non-slash input", () => {
    expect(matchSlashCommands("hello", cmds)).toEqual([]);
  });
  it("lists all on a bare slash and narrows by prefix", () => {
    expect(matchSlashCommands("/", cmds)).toHaveLength(3);
    expect(matchSlashCommands("/cl", cmds).map((c) => c.cmd)).toEqual(["clear"]);
    expect(matchSlashCommands("/e", cmds).map((c) => c.cmd)).toEqual(["exit"]);
    expect(matchSlashCommands("/zzz", cmds)).toEqual([]);
  });
  it("closes (no matches) once a space follows the command", () => {
    expect(matchSlashCommands("/clear ", cmds)).toEqual([]);
    expect(matchSlashCommands("/model gpt", cmds)).toEqual([]);
  });
});

describe("extractAttachmentPaths", () => {
  it("pulls @paths (deduped, in order), ignores plain text and emails", () => {
    expect(extractAttachmentPaths("summarize @notes/plan.md and @./todo.txt")).toEqual(["notes/plan.md", "./todo.txt"]);
    expect(extractAttachmentPaths("@a.md again @a.md")).toEqual(["a.md"]);
    expect(extractAttachmentPaths("no files here")).toEqual([]);
    expect(extractAttachmentPaths("@/abs/path/file.log please")).toEqual(["/abs/path/file.log"]);
  });
});

describe("chatHelp", () => {
  const cmds = [{ cmd: "help", desc: "show command help" }, { cmd: "tools", desc: "toggle tools" }, { cmd: "cost", desc: "show this session's token usage" }];
  it("lists commands with no topic, gives a blurb for a known topic, errors for unknown", () => {
    const idx = chatHelp("", cmds);
    expect(idx).toContain("/help");
    expect(idx).toContain("/tools");
    expect(chatHelp("tools", cmds)).toContain("run tools in chat"); // dedicated topic
    expect(chatHelp("file", cmds)).toContain("@file");
    expect(chatHelp("nope", cmds)).toMatch(/No help for 'nope'/);
  });
  it("falls back to a command's description when there's no dedicated topic", () => {
    expect(chatHelp("cost", cmds)).toBe("/cost — show this session's token usage");
  });
});

describe("parseRememberArg", () => {
  it("parses key=value and key: value, slugifying the key", () => {
    expect(parseRememberArg("city=Seoul")).toEqual({ key: "city", value: "Seoul" });
    expect(parseRememberArg("reply style: concise")).toEqual({ key: "reply_style", value: "concise" });
    expect(parseRememberArg("  Home Town = Busan ")).toEqual({ key: "home_town", value: "Busan" });
  });
  it("preserves a Korean key (진안 types /remember 취미=등산, not an ASCII slug)", () => {
    expect(parseRememberArg("취미=등산")).toEqual({ key: "취미", value: "등산" });
    expect(parseRememberArg("내 취미: 등산")).toEqual({ key: "내_취미", value: "등산" });
  });
  it("rejects input without a usable key+value", () => {
    expect(parseRememberArg("just text")).toBeUndefined();
    expect(parseRememberArg("=novalue")).toBeUndefined();
    expect(parseRememberArg("key=")).toBeUndefined();
    expect(parseRememberArg("!!!=value")).toBeUndefined();
  });
});

describe("summarizeToolArgs / format* strip terminal-control bytes from untrusted content", () => {
  const ESC = String.fromCharCode(27);
  it("summarizeToolArgs strips the ESC control byte from an attacker-controlled arg", () => {
    const out = summarizeToolArgs({ subject: `${ESC}[2JHi` });
    expect(out).not.toContain(ESC);
    expect(out).toContain("Hi");
  });
  it("formatRecallHits + formatJobsList strip ESC from snippets/prompts", () => {
    expect(formatRecallHits("q", [{ source: "notes", ref: "n1", score: 0.5, snippet: `${ESC}]0;xhello` }])).not.toContain(ESC);
    expect(formatJobsList([{ id: "j1", status: "done", prompt: `${ESC}[2Kgo`, finalText: `${ESC}[1mout` }])).not.toContain(ESC);
  });
});

describe("parseMarkdownBlocks", () => {
  it("separates fenced code from prose and captures the language", () => {
    const blocks = parseMarkdownBlocks("before\n```ts\nconst x = 1;\n```\nafter");
    expect(blocks.map((b) => b.type)).toEqual(["text", "code", "text"]);
    expect(blocks[1]).toEqual({ lang: "ts", lines: ["const x = 1;"], type: "code" });
    expect(blocks[0]?.lines).toEqual(["before"]);
    expect(blocks[2]?.lines).toEqual(["after"]);
  });
  it("plain text is a single text block", () => {
    expect(parseMarkdownBlocks("just words")).toEqual([{ lines: ["just words"], type: "text" }]);
  });
});

describe("parseInlineSpans", () => {
  it("splits bold and inline code, keeps plain runs", () => {
    expect(parseInlineSpans("a **b** c `d` e")).toEqual([
      { text: "a " }, { bold: true, text: "b" }, { text: " c " }, { code: true, text: "d" }, { text: " e" }
    ]);
    expect(parseInlineSpans("plain")).toEqual([{ text: "plain" }]);
  });
});

describe("friendlyError", () => {
  it("maps common failures to actionable hints, passes through the rest", () => {
    expect(friendlyError("fetch failed: ECONNREFUSED 127.0.0.1:11434")).toMatch(/ollama serve/);
    expect(friendlyError("model 'x' not found (404)")).toMatch(/pull it/);
    expect(friendlyError("401 Unauthorized")).toMatch(/setup model/);
    expect(friendlyError("429 rate limit exceeded")).toMatch(/rate limited/);
    expect(friendlyError("request timed out")).toMatch(/timed out/);
    expect(friendlyError("some weird thing")).toBe("some weird thing");
  });
});

describe("matchModelNames", () => {
  const models = ["ollama/qwen3:8b", "ollama/qwen3.6:35b-a3b", "ollama/nomic-embed-text"];
  it("completes after '/model ' by substring, ignores otherwise", () => {
    expect(matchModelNames("/model", models)).toEqual([]);
    expect(matchModelNames("/model ", models)).toEqual(models);
    expect(matchModelNames("/model 35", models)).toEqual(["ollama/qwen3.6:35b-a3b"]);
    expect(matchModelNames("/model qwen3", models)).toEqual(["ollama/qwen3:8b", "ollama/qwen3.6:35b-a3b"]);
    expect(matchModelNames("hi", models)).toEqual([]);
  });
});

describe("matchAgentNames", () => {
  const names = ["researcher", "reviewer", "coder"];
  it("completes only after '/agent ' and narrows by prefix", () => {
    expect(matchAgentNames("/agent", names)).toEqual([]); // no space yet
    expect(matchAgentNames("/agent ", names)).toEqual(names); // all
    expect(matchAgentNames("/agent re", names)).toEqual(["researcher", "reviewer"]);
    expect(matchAgentNames("/agent cod", names)).toEqual(["coder"]);
    expect(matchAgentNames("hello", names)).toEqual([]);
  });
});

describe("parseSlashCommand", () => {
  it("parses commands and ignores chat", () => {
    expect(parseSlashCommand("/clear")).toEqual({ arg: "", cmd: "clear" });
    expect(parseSlashCommand("hello")).toBeUndefined();
  });
});

describe("summarizeToolArgs", () => {
  it("renders a one-line content preview, skips empties, clips long values", () => {
    expect(summarizeToolArgs({ to: "bob@x.com", subject: "Hi" })).toBe("to: bob@x.com · subject: Hi");
    expect(summarizeToolArgs({ to: "bob@x.com", cc: "", note: null })).toBe("to: bob@x.com");
    expect(summarizeToolArgs({})).toBe("(no arguments)");
    expect(summarizeToolArgs({ body: "x".repeat(100) })).toMatch(/^body: x{60}…$/u);
    expect(summarizeToolArgs({ body: "line1\n  line2" })).toBe("body: line1 line2");
  });
});

describe("chatToolApprovalGate", () => {
  const outbound = ["email_send", "web_action"];

  it("auto-approves a read tool without asking", async () => {
    let asked = false;
    const gate = chatToolApprovalGate(outbound, async () => { asked = true; return true; });
    const d = await gate({ risk: "read", toolCall: { name: "notes_search", arguments: {} } });
    expect(d).toEqual({ allowed: true });
    expect(asked).toBe(false);
  });

  it("blocks a write/execute tool when the user declines (fail-closed)", async () => {
    const gate = chatToolApprovalGate(outbound, async () => false);
    const email = await gate({ risk: "execute", toolCall: { name: "email_send", arguments: { to: "a@b.c" } } });
    expect(email).toEqual({ allowed: false, reason: "user declined the outbound action" });
    const note = await gate({ risk: "write", toolCall: { name: "notes_add", arguments: { text: "x" } } });
    expect(note).toEqual({ allowed: false, reason: "user declined the tool call" });
  });

  it("lets an action through only on explicit approval, tagging outbound vs tool and showing content", async () => {
    const seen: string[] = [];
    const gate = chatToolApprovalGate(outbound, async (name, detail, kind) => { seen.push(`${kind}|${name}|${detail}`); return true; });
    const a = await gate({ risk: "execute", toolCall: { name: "email_send", arguments: { to: "a@b.c", subject: "Hi" } } });
    const b = await gate({ risk: "write", toolCall: { name: "tasks_add", arguments: { title: "Buy milk" } } });
    expect(a).toEqual({ allowed: true });
    expect(b).toEqual({ allowed: true });
    expect(seen).toEqual([
      "outbound|email_send|to: a@b.c · subject: Hi",
      "tool|tasks_add|title: Buy milk"
    ]);
  });
});

describe("formatMemoryView", () => {
  it("renders facts, preferences, and topics; offers /forget", () => {
    const out = formatMemoryView({
      facts: { name: "Stark", city: "Seoul" },
      preferences: { reply_style: "concise" },
      recentTopics: ["approval gate", "IME"]
    });
    expect(out).toContain("What I remember about you:");
    expect(out).toContain("    name: Stark");
    expect(out).toContain("    reply_style: concise");
    expect(out).toContain("Recent topics: approval gate, IME");
    expect(out).toContain("/forget");
  });
  it("gives an empty-state line when nothing is stored", () => {
    expect(formatMemoryView(undefined)).toMatch(/haven't remembered anything/);
    expect(formatMemoryView({ facts: {}, preferences: {}, recentTopics: [] })).toMatch(/haven't remembered/);
  });
  it("shows a fact's superseded prior value (temporal depth) with the change date", () => {
    const out = formatMemoryView({
      facts: { home_city: "Seoul" },
      preferences: {},
      recentTopics: [],
      factHistory: [{ key: "home_city", previousValue: "Busan", replacedAt: "2026-05-12T10:00:00.000Z" }]
    });
    expect(out).toContain("    home_city: Seoul (was Busan until 2026-05-12)");
  });
  it("shows only the MOST RECENT prior when a fact changed twice", () => {
    const out = formatMemoryView({
      facts: { job: "pilot" },
      preferences: {},
      recentTopics: [],
      factHistory: [
        { key: "job", previousValue: "student", replacedAt: "2026-01-01T00:00:00.000Z" },
        { key: "job", previousValue: "engineer", replacedAt: "2026-05-20T00:00:00.000Z" }
      ]
    });
    expect(out).toContain("    job: pilot (was engineer until 2026-05-20)");
    expect(out).not.toContain("student");
  });
});

describe("recurringEpisodeThreads", () => {
  it("ranks topics by the number of distinct sessions that touched them (≥2)", () => {
    const threads = recurringEpisodeThreads([
      { topics: ["Q3 budget", "Notion"] },
      { topics: ["Q3 budget"] },
      { topics: ["Notion", "vacation"] },
      { topics: ["Q3 budget"] }
    ]);
    expect(threads).toEqual([
      { topic: "Q3 budget", sessions: 3 },
      { topic: "Notion", sessions: 2 }
    ]);
  });
  it("counts a topic once per episode even if repeated, and is case-insensitive", () => {
    const threads = recurringEpisodeThreads([
      { topics: ["Budget", "budget", "BUDGET"] },
      { topics: ["budget"] }
    ]);
    expect(threads).toEqual([{ topic: "Budget", sessions: 2 }]);
  });
  it("returns nothing when no topic recurs across sessions", () => {
    expect(recurringEpisodeThreads([{ topics: ["a"] }, { topics: ["b"] }])).toEqual([]);
    expect(recurringEpisodeThreads([])).toEqual([]);
  });
  it("caps to the top N threads", () => {
    const episodes = [
      { topics: ["a", "b", "c", "d"] },
      { topics: ["a", "b", "c", "d"] }
    ];
    expect(recurringEpisodeThreads(episodes, { max: 2 })).toHaveLength(2);
  });
});

describe("formatMemoryView — recurring threads (reflection)", () => {
  it("renders the threads-you-keep-returning-to line", () => {
    const out = formatMemoryView(
      { facts: { name: "Jinan" }, preferences: {}, recentTopics: [] },
      undefined,
      [{ topic: "Q3 budget", sessions: 3 }, { topic: "Notion", sessions: 2 }]
    );
    expect(out).toContain("Threads you keep returning to: Q3 budget (3 sessions), Notion (2 sessions)");
  });
  it("shows the reflection even when facts/prefs/topics are empty", () => {
    const out = formatMemoryView(
      { facts: {}, preferences: {}, recentTopics: [] },
      undefined,
      [{ topic: "Q3 budget", sessions: 2 }]
    );
    expect(out).not.toMatch(/haven't remembered/);
    expect(out).toContain("Q3 budget (2 sessions)");
  });
});

describe("composeMorningGreeting (proactive reflection at session open)", () => {
  it("appends the reflection line only when there's an insight", () => {
    const withInsight = composeMorningGreeting({ who: "Jinan", brief: "Tasks: 2 open", insight: "You keep returning to the Q3 budget." });
    expect(withInsight).toBe("♪ good morning, Jinan\n\nTasks: 2 open\n\n🪞 You keep returning to the Q3 budget.");
  });
  it("omits the reflection line (no nag) when the insight is empty/blank", () => {
    expect(composeMorningGreeting({ who: "Jinan", brief: "Tasks: 2 open", insight: "" })).toBe("♪ good morning, Jinan\n\nTasks: 2 open");
    expect(composeMorningGreeting({ brief: "b", insight: "   " })).toBe("♪ good morning\n\nb");
  });
  it("greets without a name when none is known", () => {
    expect(composeMorningGreeting({ brief: "b" })).toBe("♪ good morning\n\nb");
  });
  it("strips terminal-control bytes from the insight", () => {
    const out = composeMorningGreeting({ brief: "b", insight: `hi${String.fromCharCode(27)}[31m there` });
    expect(out).not.toContain(String.fromCharCode(27));
    expect(out).toContain("🪞 hi");
    expect(out).toContain("there");
  });
});

describe("buildRecap", () => {
  it("composes episode summary with open-commitment counts", () => {
    expect(buildRecap({ lastEpisode: "Shipped the approval gate", pendingTasks: 2, pendingFollowups: 1 }))
      .toBe("Where we left off: Shipped the approval gate · 2 tasks, 1 follow-up waiting");
    expect(buildRecap({ pendingTasks: 1 })).toBe("Where we left off: 1 task waiting");
  });
  it("surfaces voiced-but-untracked open loops, distinct from tracked items", () => {
    expect(buildRecap({ openCommitments: 2 })).toBe("Where we left off: 2 loose ends you mentioned");
    expect(buildRecap({ lastEpisode: "X", pendingTasks: 1, openCommitments: 1 }))
      .toBe("Where we left off: X · 1 task waiting · 1 loose end you mentioned");
    expect(buildRecap({ openCommitments: 0 })).toBe("");
  });
  it("returns empty string for a brand-new relationship", () => {
    expect(buildRecap({})).toBe("");
    expect(buildRecap({ pendingTasks: 0, pendingFollowups: 0 })).toBe("");
  });
  it("clips a very long episode summary", () => {
    expect(buildRecap({ lastEpisode: "x".repeat(200) })).toMatch(/^Where we left off: x{80}…$/u);
  });
});

describe("formatRecallHits", () => {
  it("renders source/ref/score + clipped snippet per hit", () => {
    const out = formatRecallHits("approval", [
      { source: "episodes", ref: "e1", score: 0.8123, snippet: "Shipped\n the  gate" }
    ]);
    expect(out).toContain('Recall for "approval":');
    expect(out).toContain("  [episodes] e1 (0.81)");
    expect(out).toContain("    Shipped the gate");
  });
  it("gives an empty-state hint when nothing matched", () => {
    expect(formatRecallHits("xyz", [])).toMatch(/No memories matched "xyz"/);
  });
});

describe("formatJobsList", () => {
  it("renders a status glyph, prompt, and a result preview for done jobs", () => {
    const out = formatJobsList([
      { id: "job_2026-05-24_abc", status: "done", prompt: "research X", finalText: "found  three\nthings" },
      { id: "job_2026-05-24_def", status: "running", prompt: "long task" }
    ]);
    expect(out).toContain("✓ job_2026-05-24_abc — research X (done)");
    expect(out).toContain("      → found three things");
    expect(out).toContain("⏳ job_2026-05-24_def — long task (running)");
  });
  it("empty-state line when no jobs", () => {
    expect(formatJobsList([])).toMatch(/No background jobs yet/);
  });
});

describe("firstOpenToday", () => {
  it("true on a new/absent date, false when already briefed today", () => {
    expect(firstOpenToday(undefined, "2026-05-25")).toBe(true);
    expect(firstOpenToday("", "2026-05-25")).toBe(true);
    expect(firstOpenToday("2026-05-24", "2026-05-25")).toBe(true);
    expect(firstOpenToday("2026-05-25", "2026-05-25")).toBe(false);
    expect(firstOpenToday(" 2026-05-25 ", "2026-05-25")).toBe(false);
  });
});

describe("formatTrust", () => {
  it("renders sorted trusted/blocked lists with counts + empty states", () => {
    expect(formatTrust(["web_action", "email_send"], [])).toBe(
      "Trusted tools (2): email_send, web_action\nBlocked tools (0): (none)"
    );
    expect(formatTrust([], ["home_action"])).toContain("Blocked tools (1): home_action");
  });
});

describe("greetingName", () => {
  it("pulls the first name from common fact keys, else undefined", () => {
    expect(greetingName({ name: "Jinan Kim" })).toBe("Jinan");
    expect(greetingName({ user_name: "stark" })).toBe("stark");
    expect(greetingName({ first_name: "Tony" })).toBe("Tony");
    expect(greetingName({ city: "Seoul" })).toBeUndefined();
    expect(greetingName({})).toBeUndefined();
    expect(greetingName(undefined)).toBeUndefined();
  });
});

describe("resolveForgetKey", () => {
  const keys = ["user_name", "city", "reply_style", "work_city"];
  it("prefers an exact key", () => {
    expect(resolveForgetKey(keys, "city")).toEqual({ key: "city", kind: "exact" });
  });
  it("unique substring → that key", () => {
    expect(resolveForgetKey(keys, "name")).toEqual({ key: "user_name", kind: "unique" });
    expect(resolveForgetKey(keys, "style")).toEqual({ key: "reply_style", kind: "unique" });
  });
  it("multiple substring matches → ambiguous (never guesses)", () => {
    const r = resolveForgetKey(["city", "work_city"], "cITy");
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect(r.matches).toEqual(["city", "work_city"]);
  });
  it("no match → none", () => {
    expect(resolveForgetKey(keys, "weather")).toEqual({ kind: "none" });
  });
});

describe("formatMemoryView — episodic memory line", () => {
  it("surfaces past-session count + most-recent date when episodes exist", () => {
    const out = formatMemoryView({ facts: { name: "Jinan" }, preferences: {}, recentTopics: [] }, { count: 7, lastAt: "2026-05-24T11:00:00.000Z" });
    expect(out).toContain("Past sessions remembered: 7 (most recent 2026-05-24)");
    expect(out).toContain("/recall");
  });
  it("episodes alone (no facts/prefs) still render, not the empty state", () => {
    const out = formatMemoryView({ facts: {}, preferences: {}, recentTopics: [] }, { count: 3 });
    expect(out).toContain("Past sessions remembered: 3");
    expect(out).not.toMatch(/haven't remembered/);
  });
  it("no episodes → no past-sessions line", () => {
    expect(formatMemoryView({ facts: { name: "x" }, preferences: {}, recentTopics: [] })).not.toContain("Past sessions");
  });
});

describe("imageMimeForPath", () => {
  it("maps image extensions to MIME types (case-insensitive)", () => {
    expect(imageMimeForPath("photo.png")).toBe("image/png");
    expect(imageMimeForPath("a/b/Receipt.JPG")).toBe("image/jpeg");
    expect(imageMimeForPath("scan.webp")).toBe("image/webp");
    expect(imageMimeForPath("card.heic")).toBe("image/heic");
  });

  it("returns undefined for non-image files (read as text)", () => {
    expect(imageMimeForPath("notes.md")).toBeUndefined();
    expect(imageMimeForPath("data.json")).toBeUndefined();
    expect(imageMimeForPath("noext")).toBeUndefined();
  });
});

describe("buildTurnMessages with image attachments", () => {
  it("attaches images to the user message only", () => {
    const atts = [{ dataBase64: "QQ==", mimeType: "image/png" }];
    const msgs = buildTurnMessages("sys", [], "look at this", undefined, atts);
    const user = msgs.find((m) => m.role === "user");
    expect(user?.attachments).toEqual(atts);
    expect(msgs.find((m) => m.role === "system")?.attachments).toBeUndefined();
  });

  it("omits the attachments field when there are none", () => {
    const user = buildTurnMessages("sys", [], "hi", undefined, []).find((m) => m.role === "user");
    expect(user && "attachments" in user).toBe(false);
  });
});
