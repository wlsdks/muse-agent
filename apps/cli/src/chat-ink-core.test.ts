import { describe, expect, it } from "vitest";
import { MUSE_TAGLINE } from "./muse-identity.js";

import { trimConversationMessages, type ConversationMessage } from "@muse/memory";

import {
  BIRD_IDLE_CYCLE,
  birdAnimationEnabled,
  birdColorEnabled,
  birdIdleFrame,
  buildTurnMessages,
  createContextualGroundingLookup,
  type ChatTurnMessage,
  type DisplayTurnRole,
  HUD_SEGMENTS_DEFAULT,
  resolveHudSegments,
  resolveHudLocality,
  hasCloudCredential,
  providerIdFromModel,
  formatContextUsage,
  turnSeparator,
  resolveChatHistoryWindow,
  chatHelp,
  cursorCoords,
  homeInputCursorY,
  displayWidth,
  emptyInput,
  extractAttachmentPaths,
  imageMimeForPath,
  formatCompactPreview,
  friendlyError,
  buildRecap,
  chatToolApprovalGate,
  formatNoModelMessage,
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
  normalizeChatInput,
  parseRememberArg,
  matchSlashCommands,
  parseSlashCommand,
  reduceInput,
  resolveForgetKey,
  runFocusedCompaction,
  summarizeToolArgs,
  formatUndoNotice,
  parseUndoArg,
  undoExchanges,
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

describe("normalizeChatInput — NFC-normalize + trim a submitted chat turn (macOS/Swift delivers Hangul as NFD)", () => {
  it("folds an NFD Korean turn to its NFC form (the interactive Ink chat's own paste path)", () => {
    const nfd = "뭐야".normalize("NFD");
    expect(normalizeChatInput(nfd)).toBe("뭐야".normalize("NFC"));
    expect(normalizeChatInput(nfd)).not.toBe(nfd);
  });
  it("trims surrounding whitespace, same as the old bare .trim()", () => {
    expect(normalizeChatInput("  hello  ")).toBe("hello");
  });
  it("is a no-op on already-NFC ASCII text", () => {
    expect(normalizeChatInput("hello world")).toBe("hello world");
  });
});

describe("createContextualGroundingLookup — resolve an anaphoric follow-up BEFORE grounding retrieval (Ink-chat parity with runLocalChat's inline rewrite)", () => {
  const history: readonly ChatTurnMessage[] = [
    { content: "우리 사무실 와이파이 비밀번호 뭐야?", role: "user" },
    { content: "muse2026 입니다 [from wifi.md]", role: "assistant" }
  ];

  it("a follow-up pronoun question retrieves against the REWRITTEN query, not the raw pronoun turn", async () => {
    const seen: string[] = [];
    const lookup = createContextualGroundingLookup({
      retrieve: async (query) => { seen.push(query); return { block: "", matches: [] }; },
      rewrite: async () => "와이파이 비밀번호 언제 바뀌었는지"
    });
    await lookup("그거 언제 바뀌었지?", history);
    expect(seen).toEqual(["와이파이 비밀번호 언제 바뀌었는지"]);
  });

  it("a self-contained question skips the rewrite entirely — retrieves on the raw turn", async () => {
    const seen: string[] = [];
    const lookup = createContextualGroundingLookup({
      retrieve: async (query) => { seen.push(query); return { block: "", matches: [] }; },
      rewrite: async () => { throw new Error("must not be called"); }
    });
    await lookup("회사 와이파이 비밀번호 뭐야?", history);
    expect(seen).toEqual(["회사 와이파이 비밀번호 뭐야?"]);
  });

  it("fails open to the RAW turn when the rewrite dependency throws", async () => {
    const seen: string[] = [];
    const lookup = createContextualGroundingLookup({
      retrieve: async (query) => { seen.push(query); return { block: "", matches: [] }; },
      rewrite: async () => { throw new Error("model unavailable"); }
    });
    await lookup("그거 언제 바뀌었지?", history);
    expect(seen).toEqual(["그거 언제 바뀌었지?"]);
  });

  it("with no `rewrite` dependency (no provider), never rewrites — always retrieves on the raw turn", async () => {
    const seen: string[] = [];
    const lookup = createContextualGroundingLookup({
      retrieve: async (query) => { seen.push(query); return { block: "", matches: [] }; }
    });
    await lookup("그거 언제 바뀌었지?", history);
    expect(seen).toEqual(["그거 언제 바뀌었지?"]);
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

describe("homeInputCursorY (full-height home cursor anchoring)", () => {
  // The full-height live region is `rows-1` tall (bottom row index rows-2).
  // The cursor row is that bottom row minus every fixed row below the cursor's
  // input line: input-bottom-border + hint(margin+line) + HUD.
  it("anchors a single empty input line from the bottom", () => {
    // below = inputBelow(1) + hint(2) + hud(1) = 4 → rows-2-4
    expect(homeInputCursorY({ rows: 40, inputLines: 1, caretLine: 0, menuRows: 0, hasNotice: false })).toBe(34);
    expect(homeInputCursorY({ rows: 24, inputLines: 1, caretLine: 0, menuRows: 0, hasNotice: false })).toBe(18);
  });

  it("an open picker pushes the cursor further up by (menuRows + marginTop + footer)", () => {
    // menuBelow = menuRows(5) + 2 = 7 → below = 1+7+2+1 = 11 → 40-2-11 = 27
    expect(homeInputCursorY({ rows: 40, inputLines: 1, caretLine: 0, menuRows: 5, hasNotice: false })).toBe(27);
  });

  it("a command notice adds two rows (marginTop + line) below the input", () => {
    // below = 1 + notice(2) + 2 + 1 = 6 → 40-2-6 = 32
    expect(homeInputCursorY({ rows: 40, inputLines: 1, caretLine: 0, menuRows: 0, hasNotice: true })).toBe(32);
  });

  it("a multi-line input keeps the cursor on its own line (rows below shrink as caret descends)", () => {
    // 3 input lines. caret on line 0: inputBelow = 3-0 = 3 → below = 3+2+1 = 6 → 40-2-6 = 32
    expect(homeInputCursorY({ rows: 40, inputLines: 3, caretLine: 0, menuRows: 0, hasNotice: false })).toBe(32);
    // caret on line 2 (last): inputBelow = 3-2 = 1 → below = 1+2+1 = 4 → 40-2-4 = 34
    expect(homeInputCursorY({ rows: 40, inputLines: 3, caretLine: 2, menuRows: 0, hasNotice: false })).toBe(34);
  });

  it("clamps to 0 on a terminal too small to fit the bottom stack", () => {
    expect(homeInputCursorY({ rows: 4, inputLines: 1, caretLine: 0, menuRows: 0, hasNotice: false })).toBe(0);
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

  it("gates an un-analyzable run_command (shell construct hides the real command) even when declared read", async () => {
    const seenDetails: string[] = [];
    let asked = false;
    const gate = chatToolApprovalGate(outbound, async (_name, detail) => {
      asked = true;
      seenDetails.push(detail);
      return false;
    });
    const decision = await gate({
      risk: "read",
      toolCall: { name: "run_command", arguments: { command: "sh", args: ["-c", "eval \"$X\""] } }
    });
    expect(asked).toBe(true);
    expect(decision).toEqual({ allowed: false, reason: "user declined the tool call" });
    expect(seenDetails[0]).toContain("un-inspectable shell construction (eval)");
  });

  it("un-analyzable run_command: approve lets it through, decline blocks it", async () => {
    const approveGate = chatToolApprovalGate(outbound, async () => true);
    const approved = await approveGate({
      risk: "execute",
      toolCall: { name: "run_command", arguments: { command: "sh", args: ["-c", "rm -rf $(echo /)"] } }
    });
    expect(approved).toEqual({ allowed: true });

    const denyGate = chatToolApprovalGate(outbound, async () => false);
    const denied = await denyGate({
      risk: "execute",
      toolCall: { name: "run_command", arguments: { command: "sh", args: ["-c", "rm -rf $(echo /)"] } }
    });
    expect(denied).toEqual({ allowed: false, reason: "user declined the tool call" });
  });

  it("un-analyzable run_command detail names the construct", async () => {
    let detail = "";
    const gate = chatToolApprovalGate(outbound, async (_name, d) => { detail = d; return true; });
    await gate({
      risk: "execute",
      toolCall: { name: "run_command", arguments: { command: "sh", args: ["-c", "rm -rf $(echo /)"] } }
    });
    expect(detail).toContain("un-inspectable shell construction (command-substitution)");
    expect(detail).toContain("command:");
  });

  it("analyzable run_command: detail is the plain summary, no topology warning", async () => {
    let detail = "";
    const gate = chatToolApprovalGate(outbound, async (_name, d) => { detail = d; return true; });
    const decision = await gate({
      risk: "execute",
      toolCall: { name: "run_command", arguments: { command: "sh", args: ["-c", "ls -la /tmp"] } }
    });
    expect(decision).toEqual({ allowed: true });
    expect(detail).not.toContain("un-inspectable");
    expect(detail).toBe(summarizeToolArgs({ command: "sh", args: ["-c", "ls -la /tmp"] }));

    const denyGate = chatToolApprovalGate(outbound, async () => false);
    const denied = await denyGate({
      risk: "execute",
      toolCall: { name: "run_command", arguments: { command: "sh", args: ["-c", "ls -la /tmp"] } }
    });
    expect(denied).toEqual({ allowed: false, reason: "user declined the tool call" });
  });

  it("highlights risky tokens in a risky run_command's detail", async () => {
    let detail = "";
    const gate = chatToolApprovalGate(outbound, async (_name, d) => { detail = d; return true; });
    await gate({
      risk: "execute",
      toolCall: { name: "run_command", arguments: { command: "sh", args: ["-c", "rm -rf /tmp/x"] } }
    });
    expect(detail).toContain("\x1b[1;31mrm\x1b[0m");
    expect(detail).toContain("\x1b[1;31m-rf\x1b[0m");
  });

  it("a safe run_command's detail has no emphasis ANSI (byte-identical to the plain summary)", async () => {
    let detail = "";
    const gate = chatToolApprovalGate(outbound, async (_name, d) => { detail = d; return true; });
    await gate({
      risk: "execute",
      toolCall: { name: "run_command", arguments: { command: "ls", args: ["-la"] } }
    });
    expect(detail).not.toContain("\x1b[");
    expect(detail).toBe(summarizeToolArgs({ command: "ls", args: ["-la"] }));
  });

  it("a genuine read tool that is NOT run_command still silently allows, ask never called", async () => {
    let asked = false;
    const gate = chatToolApprovalGate(outbound, async () => { asked = true; return true; });
    const decision = await gate({ risk: "read", toolCall: { name: "file_read", arguments: { path: "/tmp/x" } } });
    expect(decision).toEqual({ allowed: true });
    expect(asked).toBe(false);
  });

  it("a non-run_command execute tool has an unchanged plain-summary detail (no topology warning)", async () => {
    let detail = "";
    const gate = chatToolApprovalGate(outbound, async (_name, d) => { detail = d; return true; });
    await gate({ risk: "execute", toolCall: { name: "email_send", arguments: { to: "a@b.c", body: "$(whoami)" } } });
    expect(detail).not.toContain("un-inspectable");
    expect(detail).toBe(summarizeToolArgs({ to: "a@b.c", body: "$(whoami)" }));
  });

  it("an over-length (un-analyzable, no named construct) command still asks and reads 'un-analyzable', not 'undefined'", async () => {
    let detail = "";
    let asked = false;
    const gate = chatToolApprovalGate(outbound, async (_name, d) => { detail = d; asked = true; return false; });
    const huge = "x".repeat(9000);
    const decision = await gate({ risk: "read", toolCall: { name: "run_command", arguments: { command: "sh", args: ["-c", huge] } } });
    expect(asked).toBe(true);
    expect(detail).toContain("un-analyzable");
    expect(detail).not.toContain("undefined");
    expect(decision.allowed).toBe(false);
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

describe("formatCompactPreview", () => {
  it("reports nothing dropped when the conversation is well under budget", () => {
    const messages: ConversationMessage[] = [
      { content: "hi", role: "user" },
      { content: "hello!", role: "assistant" }
    ];
    const result = trimConversationMessages(messages, { maxContextWindowTokens: 128_000, outputReserveTokens: 4_096 });
    expect(result.removedCount).toBe(0);
    const out = formatCompactPreview(messages.length, result);
    expect(out).toContain("Compaction preview — 2 message(s) in context");
    expect(out).toContain("nothing would be dropped right now.");
  });

  it("reports the SAME numbers a direct trimConversationMessages call produces when the budget is exceeded", () => {
    const messages: ConversationMessage[] = Array.from({ length: 40 }, (_, i) => ({
      content: `turn number ${i.toString()} `.repeat(50),
      role: i % 2 === 0 ? "user" : "assistant"
    }));
    const options = { maxContextWindowTokens: 500, outputReserveTokens: 50 };
    const result = trimConversationMessages(messages, options);
    expect(result.removedCount).toBeGreaterThan(0);

    const out = formatCompactPreview(messages.length, result);
    expect(out).toContain(`Compaction preview — ${messages.length.toString()} message(s) in context`);
    expect(out).toContain(`tokens: ~${result.estimatedTokens.toString()} / ${result.budgetTokens.toString()} budget`);
    expect(out).toContain(`would drop ${result.removedCount.toString()} message(s) (trigger: ${result.triggeredBy})`);

    // Re-running the SAME trim directly must match what the preview reported —
    // the preview never hand-rolls its own numbers.
    const again = trimConversationMessages(messages, options);
    expect(again.removedCount).toBe(result.removedCount);
    expect(again.estimatedTokens).toBe(result.estimatedTokens);
    expect(again.dropped.length).toBe(result.dropped.length);
  });

  it("never mutates the input array passed in", () => {
    const messages: ConversationMessage[] = Array.from({ length: 20 }, (_, i) => ({
      content: `turn ${i.toString()} `.repeat(80),
      role: i % 2 === 0 ? "user" : "assistant"
    }));
    const snapshot = messages.map((m) => ({ ...m }));
    const result = trimConversationMessages(messages, { maxContextWindowTokens: 300, outputReserveTokens: 50 });
    formatCompactPreview(messages.length, result);
    expect(messages).toEqual(snapshot);
    expect(messages.length).toBe(20);
  });

  it("strips untrusted terminal control chars from the oldest-dropped preview", () => {
    const ESC = String.fromCharCode(27);
    const messages: ConversationMessage[] = Array.from({ length: 20 }, (_, i) => ({
      content: i === 0 ? `${ESC}[2Ksneaky content` : `padding content number ${i.toString()} `.repeat(40),
      role: i % 2 === 0 ? "user" : "assistant"
    }));
    const result = trimConversationMessages(messages, { maxContextWindowTokens: 300, outputReserveTokens: 50 });
    expect(result.removedCount).toBeGreaterThan(0);
    const out = formatCompactPreview(messages.length, result);
    expect(out).not.toContain(ESC);
  });
});

describe("runFocusedCompaction — /compact <topic> pipeline (stub summarizer, no real model)", () => {
  // A realistically large hard cap (matching production defaults) so the
  // FORCED working-budget target (computed from the tail) is what actually
  // drives the trim, not an accidentally-small hard cap.
  const trimOptions = { maxContextWindowTokens: 128_000, outputReserveTokens: 4_096 };

  function longHistory(): ChatTurnMessage[] {
    const history: ChatTurnMessage[] = [];
    for (let i = 0; i < 12; i++) {
      history.push({ content: `old filler turn ${i.toString()} `.repeat(10), role: i % 2 === 0 ? "user" : "assistant" });
    }
    history.push({ content: 'the vacation budget is "Ironclad Resort" for $3,000', role: "user" });
    history.push({ content: "we'll go with Ironclad Resort, noted.", role: "assistant" });
    history.push({ content: "what's next on the itinerary?", role: "user" });
    history.push({ content: "let's check flights next.", role: "assistant" });
    return history;
  }

  it("does nothing (and reports so) when the conversation is still too short to compact", async () => {
    const history: ChatTurnMessage[] = [{ content: "hi", role: "user" }, { content: "hello!", role: "assistant" }];
    const result = await runFocusedCompaction("vacation", history, trimOptions, undefined);
    expect(result.messages).toEqual(history);
    expect(result.note).toContain("Nothing to compact yet");
  });

  it("compacts NOW (unlike bare /compact, which only previews) and forwards the topic to the summarizer", async () => {
    let seenTopic: string | undefined;
    const summarizer = async (_msgs: unknown, options?: { focusTopic?: string }) => {
      seenTopic = options?.focusTopic;
      return 'The vacation budget is "Ironclad Resort" for $3,000.';
    };

    const history = longHistory();
    const result = await runFocusedCompaction("vacation budget", history, trimOptions, summarizer);

    expect(seenTopic).toBe("vacation budget");
    expect(result.messages.length).toBeLessThan(history.length); // an actual compaction happened, not a preview
    const summary = result.messages.find((m) => m.role === "system");
    expect(summary).toBeDefined();
    expect(result.note).toContain("Added a topic-focused recap");
    expect(result.note).toContain("vacation budget");
  });

  it("fails closed: a lossy recap missing the user's own hard anchors is rejected, deterministic summary still lands", async () => {
    const summarizer = async () => "we chatted about some stuff"; // drops the amount/name entirely
    const history = longHistory();
    const result = await runFocusedCompaction("vacation budget", history, trimOptions, summarizer);

    const summary = result.messages.find((m) => m.role === "system");
    expect(summary).toBeDefined(); // deterministic floor still inserted
    expect(result.note).toContain("didn't preserve enough");
    expect(result.note).not.toContain("Added a topic-focused recap");
  });

  it("still compacts (deterministic-only) when no summarizer is configured", async () => {
    const history = longHistory();
    const result = await runFocusedCompaction("vacation budget", history, trimOptions, undefined);
    expect(result.messages.length).toBeLessThan(history.length);
    expect(result.messages.some((m) => m.role === "system")).toBe(true);
    expect(result.note).not.toContain("Added a topic-focused recap");
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

describe("formatNoModelMessage — first-run onboarding for a brand-new user", () => {
  it("leads with the local-first identity and names only real setup commands", () => {
    const out = formatNoModelMessage();
    expect(out).toContain(MUSE_TAGLINE);                 // identity lead, not a bare error
    expect(out.startsWith("muse: ")).toBe(false);        // not the old generic-error opener
    expect(out).toContain("muse setup local");           // real command
    expect(out).toContain("muse setup model");           // real command
    expect(out).toContain("muse setup wizard");          // real command
    expect(out).toMatch(/local.*free|free.*local/i);     // local framed as the free/private default
  });
});

describe("birdIdleFrame — home-screen bird idle loop", () => {
  it("cycles the canonical bob/blink vocabulary and wraps by cycle length", () => {
    const len = BIRD_IDLE_CYCLE.length;
    for (let t = 0; t < len * 2 + 3; t++) {
      expect(birdIdleFrame(t, true)).toBe(BIRD_IDLE_CYCLE[t % len]);
    }
  });

  it("includes both a bob (hopUp) and a blink somewhere in the cycle", () => {
    expect(BIRD_IDLE_CYCLE).toContain("hopUp");
    expect(BIRD_IDLE_CYCLE).toContain("blink");
    // still subtle — the bird is standing for most of the loop
    expect(BIRD_IDLE_CYCLE.filter((f) => f === "stand").length).toBeGreaterThan(BIRD_IDLE_CYCLE.length / 2);
  });

  it("pins to a single static 'stand' frame under reduced motion (animate=false)", () => {
    for (const t of [0, 2, 5, 7, 100]) expect(birdIdleFrame(t, false)).toBe("stand");
  });

  it("handles negative / fractional ticks without going out of range", () => {
    expect(BIRD_IDLE_CYCLE).toContain(birdIdleFrame(-1, true));
    expect(BIRD_IDLE_CYCLE).toContain(birdIdleFrame(3.9, true));
  });
});

describe("birdColorEnabled / birdAnimationEnabled — reduced-motion + NO_COLOR gates", () => {
  it("no color bird when NO_COLOR is set (any value), even on a TTY", () => {
    expect(birdColorEnabled({ NO_COLOR: "" }, true)).toBe(false);
    expect(birdColorEnabled({ NO_COLOR: "1" }, true)).toBe(false);
    expect(birdAnimationEnabled({ NO_COLOR: "1" }, true)).toBe(false);
  });

  it("no color bird when not a TTY (piped / CI)", () => {
    expect(birdColorEnabled({}, false)).toBe(false);
    expect(birdAnimationEnabled({}, false)).toBe(false);
  });

  it("animates on a color TTY with no override", () => {
    expect(birdColorEnabled({}, true)).toBe(true);
    expect(birdAnimationEnabled({}, true)).toBe(true);
  });

  it("MUSE_NO_ANIM disables animation but keeps the (static) color bird", () => {
    expect(birdAnimationEnabled({ MUSE_NO_ANIM: "1" }, true)).toBe(false);
    expect(birdColorEnabled({ MUSE_NO_ANIM: "1" }, true)).toBe(true);
  });

  it("treats falsy MUSE_NO_ANIM values as NOT set (still animates)", () => {
    for (const v of ["", "0", "false", "no", "off"]) {
      expect(birdAnimationEnabled({ MUSE_NO_ANIM: v }, true)).toBe(true);
    }
  });
});

describe("resolveHudSegments — customizable status bar", () => {
  it("defaults to the full ordered segment list when nothing is set", () => {
    expect(resolveHudSegments({})).toEqual(HUD_SEGMENTS_DEFAULT);
    expect(resolveHudSegments({})).toEqual(["model", "locality", "proactive", "agent", "tools", "skills", "ctx", "tokens"]);
  });

  it("MUSE_HUD_SEGMENTS picks AND orders the listed segments", () => {
    expect(resolveHudSegments({ MUSE_HUD_SEGMENTS: "tokens,model,tools" })).toEqual(["tokens", "model", "tools"]);
    expect(resolveHudSegments({ MUSE_HUD_SEGMENTS: "model,locality,tools,skills" })).toEqual(["model", "locality", "tools", "skills"]);
  });

  it("ignores unknown names and de-duplicates, preserving first-seen order", () => {
    expect(resolveHudSegments({ MUSE_HUD_SEGMENTS: "model, bogus, MODEL , tools ,tools" })).toEqual(["model", "tools"]);
  });

  it("falls back to the default when the list has no valid segments", () => {
    expect(resolveHudSegments({ MUSE_HUD_SEGMENTS: "nonsense,foo" })).toEqual(HUD_SEGMENTS_DEFAULT);
  });

  it("falls back to the default when the list is empty/blank (never a blank HUD)", () => {
    expect(resolveHudSegments({ MUSE_HUD_SEGMENTS: "" })).toEqual(HUD_SEGMENTS_DEFAULT);
    expect(resolveHudSegments({ MUSE_HUD_SEGMENTS: "   " })).toEqual(HUD_SEGMENTS_DEFAULT);
    expect(resolveHudSegments({ MUSE_HUD_SEGMENTS: " , , " })).toEqual(HUD_SEGMENTS_DEFAULT);
  });

  it("MUSE_HUD presets are sugar over a segment list", () => {
    expect(resolveHudSegments({ MUSE_HUD: "minimal" })).toEqual(["model", "locality"]);
    expect(resolveHudSegments({ MUSE_HUD: "FULL" })).toEqual(HUD_SEGMENTS_DEFAULT);
    expect(resolveHudSegments({ MUSE_HUD: "  Minimal  " })).toEqual(["model", "locality"]);
  });

  it("an unknown preset falls back to the default", () => {
    expect(resolveHudSegments({ MUSE_HUD: "fancy" })).toEqual(HUD_SEGMENTS_DEFAULT);
  });

  it("an explicit segment list takes precedence over a preset", () => {
    expect(resolveHudSegments({ MUSE_HUD: "minimal", MUSE_HUD_SEGMENTS: "tools,skills" })).toEqual(["tools", "skills"]);
  });

  it("supports config-object fallback when the env is unset", () => {
    expect(resolveHudSegments({}, { segments: "model,tools" })).toEqual(["model", "tools"]);
    expect(resolveHudSegments({}, { preset: "minimal" })).toEqual(["model", "locality"]);
    // env wins over config
    expect(resolveHudSegments({ MUSE_HUD_SEGMENTS: "skills" }, { segments: "model" })).toEqual(["skills"]);
  });
});

describe("providerIdFromModel — provider prefix of a model string", () => {
  it("extracts the provider before the slash", () => {
    expect(providerIdFromModel("ollama/gemma4:12b")).toBe("ollama");
    expect(providerIdFromModel("openai/gpt-4o")).toBe("openai");
    expect(providerIdFromModel("anthropic/claude-haiku-4-5")).toBe("anthropic");
  });

  it("lower-cases and trims", () => {
    expect(providerIdFromModel("  Ollama/Gemma4  ")).toBe("ollama");
  });

  it("falls back to the whole string when there's no provider prefix", () => {
    expect(providerIdFromModel("gemma4:12b")).toBe("gemma4:12b");
    expect(providerIdFromModel("default")).toBe("default");
  });
});

describe("hasCloudCredential — any cloud LLM key present", () => {
  it("true when a cloud key is set", () => {
    expect(hasCloudCredential({ OPENAI_API_KEY: "sk-x" })).toBe(true);
    expect(hasCloudCredential({ GEMINI_API_KEY: "g" })).toBe(true);
    expect(hasCloudCredential({ ANTHROPIC_API_KEY: "a" })).toBe(true);
    expect(hasCloudCredential({ OPENROUTER_API_KEY: "o" })).toBe(true);
  });

  it("false when none are set (or only blank)", () => {
    expect(hasCloudCredential({})).toBe(false);
    expect(hasCloudCredential({ OPENAI_API_KEY: "   " })).toBe(false);
    expect(hasCloudCredential({ MUSE_MODEL: "ollama/gemma4:12b" })).toBe(false);
  });
});

describe("resolveHudLocality — truthful cloud/local badge", () => {
  it("a LOCAL provider reads 🔒 local even when local-only is OFF (the fixed bug)", () => {
    const loc = resolveHudLocality({ cloudKeyPresent: false, localOnly: false, providerId: "ollama" });
    expect(loc.locality).toBe("local");
    expect(loc.warn).toBe(false);
    expect(loc.text).toBe("🔒 local");
    expect(loc.tone).toBe("green");
  });

  it("a LOCAL provider stays 🔒 local when local-only is ON", () => {
    const loc = resolveHudLocality({ cloudKeyPresent: true, localOnly: true, providerId: "ollama" });
    expect(loc.text).toBe("🔒 local");
    expect(loc.warn).toBe(false);
  });

  it("a LOCAL provider warns ⚠ local when local-only is OFF and a cloud key is present (egress possible)", () => {
    const loc = resolveHudLocality({ cloudKeyPresent: true, localOnly: false, providerId: "ollama" });
    expect(loc.locality).toBe("local"); // still truthfully local
    expect(loc.warn).toBe(true);
    expect(loc.text).toBe("⚠ local");
    expect(loc.tone).toBe("yellow");
  });

  it("a CLOUD provider reads ⚠ cloud regardless of the flag or keys", () => {
    for (const providerId of ["openai", "anthropic", "gemini", "openrouter"]) {
      const loc = resolveHudLocality({ cloudKeyPresent: false, localOnly: false, providerId });
      expect(loc.locality, providerId).toBe("cloud");
      expect(loc.text, providerId).toBe("⚠ cloud");
      expect(loc.tone, providerId).toBe("yellow");
    }
  });

  it("a remote local-inference HOST counts as cloud egress", () => {
    const loc = resolveHudLocality({ baseUrl: "http://192.168.1.9:11434", cloudKeyPresent: false, localOnly: false, providerId: "ollama" });
    expect(loc.locality).toBe("cloud");
    expect(loc.text).toBe("⚠ cloud");
  });

  it("a loopback openai-compatible endpoint is local", () => {
    const loc = resolveHudLocality({ baseUrl: "http://localhost:8000/v1", cloudKeyPresent: false, localOnly: false, providerId: "openai-compatible" });
    expect(loc.locality).toBe("local");
    expect(loc.text).toBe("🔒 local");
  });
});

describe("formatContextUsage — ctx window fill indicator", () => {
  it("renders a rounded percentage of the budget", () => {
    expect(formatContextUsage(12_800, 128_000)).toBe("ctx 10%");
    expect(formatContextUsage(64_000, 128_000)).toBe("ctx 50%");
  });

  it("shows <1% instead of a misleading 0% for a tiny fill", () => {
    expect(formatContextUsage(100, 128_000)).toBe("ctx <1%");
  });

  it("clamps an over-budget fill to 100%", () => {
    expect(formatContextUsage(200_000, 128_000)).toBe("ctx 100%");
  });

  it("self-omits (undefined) when the budget or usage is unknown/zero", () => {
    expect(formatContextUsage(0, 128_000)).toBeUndefined();
    expect(formatContextUsage(5_000, undefined)).toBeUndefined();
    expect(formatContextUsage(5_000, 0)).toBeUndefined();
  });
});

describe("turnSeparator — per-exchange scannable rule", () => {
  const U: DisplayTurnRole = "user";
  const A: DisplayTurnRole = "assistant";

  it("draws NO separator for the first turn overall", () => {
    expect(turnSeparator([U, A], 0, { plain: false, width: 40 })).toBe("");
  });

  it("draws NO separator for a non-user turn (assistant/system/sub-line)", () => {
    expect(turnSeparator([U, A, U, A], 1, { plain: false, width: 40 })).toBe("");
    expect(turnSeparator([U, A, U, A], 3, { plain: false, width: 40 })).toBe("");
  });

  it("draws a rule with the exchange number above a subsequent user turn", () => {
    const sep = turnSeparator([U, A, U, A], 2, { plain: false, width: 40 });
    expect(sep).toContain("#2");
    expect(sep.startsWith("──")).toBe(true);
    expect(displayWidth(sep)).toBe(40);
  });

  it("numbers exchanges by counting user turns, ignoring interleaved system notes", () => {
    // [system recap, user, assistant, user] → the 2nd user is exchange #2
    const roles: DisplayTurnRole[] = ["system", U, A, U];
    expect(turnSeparator(roles, 3, { plain: false, width: 30 })).toContain("#2");
    // a rule ALSO sits above the first user turn when a note precedes it (#1)
    expect(turnSeparator(roles, 1, { plain: false, width: 30 })).toContain("#1");
  });

  it("uses ASCII dashes and no box-drawing under NO_COLOR / non-TTY (plain)", () => {
    const sep = turnSeparator([U, A, U], 2, { plain: true, width: 24 });
    expect(sep).toContain("#2");
    expect(sep).toMatch(/^-+ #2 -+$/u);
    expect(sep).not.toContain("─");
    expect(sep.length).toBe(24); // all ASCII → 1 col each
  });

  it("clamps the rule width to a sane band for tiny / huge terminals", () => {
    expect(displayWidth(turnSeparator([U, A, U], 2, { plain: false, width: 4 }))).toBe(12);
    expect(displayWidth(turnSeparator([U, A, U], 2, { plain: false, width: 500 }))).toBe(120);
  });
});

function exchange(n: number): ChatTurnMessage[] {
  return [
    { content: `question ${n.toString()}`, role: "user" },
    { content: `answer ${n.toString()}`, role: "assistant" }
  ];
}

describe("parseUndoArg — /undo [N] argument parsing (strict integer, clamped 1-20)", () => {
  it("defaults to 1 for a bare /undo", () => {
    expect(parseUndoArg("")).toEqual({ count: 1, kind: "ok" });
    expect(parseUndoArg("   ")).toEqual({ count: 1, kind: "ok" });
  });

  it("parses a plain integer", () => {
    expect(parseUndoArg("3")).toEqual({ count: 3, kind: "ok" });
  });

  it("clamps an in-bounds-but-large integer to 20", () => {
    expect(parseUndoArg("100")).toEqual({ count: 20, kind: "ok" });
  });

  it("clamps zero / negative integers up to 1", () => {
    expect(parseUndoArg("0")).toEqual({ count: 1, kind: "ok" });
    expect(parseUndoArg("-5")).toEqual({ count: 1, kind: "ok" });
  });

  it("rejects a non-integer like '2x'", () => {
    expect(parseUndoArg("2x")).toEqual({ kind: "invalid", raw: "2x" });
  });

  it("rejects a decimal", () => {
    expect(parseUndoArg("2.5")).toEqual({ kind: "invalid", raw: "2.5" });
  });

  it("rejects non-numeric garbage", () => {
    expect(parseUndoArg("all")).toEqual({ kind: "invalid", raw: "all" });
  });
});

describe("undoExchanges — roll back the last N user/assistant exchanges", () => {
  it("removes the last exchange (count=1)", () => {
    const history = [...exchange(1), ...exchange(2), ...exchange(3)];
    const result = undoExchanges(history, 1);
    expect(result.removedExchanges).toBe(1);
    expect(result.remainingExchanges).toBe(2);
    expect(result.history).toEqual([...exchange(1), ...exchange(2)]);
  });

  it("removes the last N exchanges", () => {
    const history = [...exchange(1), ...exchange(2), ...exchange(3), ...exchange(4)];
    const result = undoExchanges(history, 3);
    expect(result.removedExchanges).toBe(3);
    expect(result.remainingExchanges).toBe(1);
    expect(result.history).toEqual([...exchange(1)]);
  });

  it("clamps count to the number of exchanges actually present", () => {
    const history = [...exchange(1), ...exchange(2)];
    const result = undoExchanges(history, 20);
    expect(result.removedExchanges).toBe(2);
    expect(result.remainingExchanges).toBe(0);
    expect(result.history).toEqual([]);
  });

  it("empty history is a no-op", () => {
    const result = undoExchanges([], 1);
    expect(result.removedExchanges).toBe(0);
    expect(result.remainingExchanges).toBe(0);
    expect(result.history).toEqual([]);
  });

  it("a trailing un-answered user message counts as one exchange and is removed cleanly", () => {
    const history: ChatTurnMessage[] = [...exchange(1), { content: "dangling question", role: "user" }];
    const result = undoExchanges(history, 1);
    expect(result.removedExchanges).toBe(1);
    expect(result.history).toEqual([...exchange(1)]);
    // no dangling assistant is ever left behind by the removal itself
    expect(result.history.every((m, i, arr) => m.role !== "assistant" || arr[i - 1]?.role === "user")).toBe(true);
  });

  it("removes everything between two user turns, including non-final entries (tool calls/results)", () => {
    const history: ChatTurnMessage[] = [
      ...exchange(1),
      { content: "question 2", role: "user" },
      { content: "tool call: web_search(query=x)", role: "assistant" },
      { content: "tool result: [...]", role: "system" },
      { content: "final answer using the tool result", role: "assistant" }
    ];
    const result = undoExchanges(history, 1);
    expect(result.removedExchanges).toBe(1);
    expect(result.history).toEqual([...exchange(1)]);
  });

  it("never mutates the input array", () => {
    const history = [...exchange(1), ...exchange(2)];
    const snapshot = history.map((m) => ({ ...m }));
    undoExchanges(history, 1);
    expect(history).toEqual(snapshot);
  });
});

describe("formatUndoNotice", () => {
  it("reports how many exchanges were removed and how many remain", () => {
    expect(formatUndoNotice({ history: [], remainingExchanges: 2, removedExchanges: 1 })).toBe(
      "Removed the last 1 exchange — 2 remaining."
    );
  });

  it("pluralizes for more than one removed", () => {
    expect(formatUndoNotice({ history: [], remainingExchanges: 0, removedExchanges: 3 })).toBe(
      "Removed the last 3 exchanges — 0 remaining."
    );
  });

  it("says there's nothing to undo and changes nothing when removedExchanges is 0", () => {
    expect(formatUndoNotice({ history: [], remainingExchanges: 0, removedExchanges: 0 })).toBe(
      "Nothing to undo yet."
    );
  });
});
