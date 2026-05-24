import { describe, expect, it } from "vitest";

import {
  buildTurnMessages,
  chatHelp,
  cursorCoords,
  displayWidth,
  emptyInput,
  extractAttachmentPaths,
  friendlyError,
  buildRecap,
  chatToolApprovalGate,
  firstOpenToday,
  formatJobsList,
  formatMemoryView,
  formatRecallHits,
  matchAgentNames,
  matchModelNames,
  parseInlineSpans,
  parseMarkdownBlocks,
  matchSlashCommands,
  parseSlashCommand,
  reduceInput,
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
  it("lists commands with no topic, gives a blurb for a known topic, errors for unknown", () => {
    const idx = chatHelp("", ["help", "tools", "exit"]);
    expect(idx).toContain("/help");
    expect(idx).toContain("/tools");
    expect(chatHelp("tools", [])).toContain("run tools in chat");
    expect(chatHelp("file", [])).toContain("@file");
    expect(chatHelp("nope", [])).toMatch(/No help for 'nope'/);
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
});

describe("buildRecap", () => {
  it("composes episode summary with open-commitment counts", () => {
    expect(buildRecap({ lastEpisode: "Shipped the approval gate", pendingTasks: 2, pendingFollowups: 1 }))
      .toBe("Where we left off: Shipped the approval gate · 2 tasks, 1 follow-up waiting");
    expect(buildRecap({ pendingTasks: 1 })).toBe("Where we left off: 1 task waiting");
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
