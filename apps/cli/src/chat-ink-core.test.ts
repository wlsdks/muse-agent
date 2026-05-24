import { describe, expect, it } from "vitest";

import {
  buildTurnMessages,
  cursorCoords,
  displayWidth,
  emptyInput,
  matchSlashCommands,
  parseSlashCommand,
  reduceInput,
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

describe("parseSlashCommand", () => {
  it("parses commands and ignores chat", () => {
    expect(parseSlashCommand("/clear")).toEqual({ arg: "", cmd: "clear" });
    expect(parseSlashCommand("hello")).toBeUndefined();
  });
});
