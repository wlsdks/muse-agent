/**
 * Ink chat surface for a bare `muse` — a claude / codex style bottom
 * input BOX with a streaming transcript scrolling above it.
 *
 * The CJK problem (Korean composing below the box) is solved with Ink's
 * `useCursor`: after every render we place the REAL terminal cursor at
 * the input position INSIDE the box, so an IME composes there. The
 * cursor's x accounts for wide (2-column) characters via `displayWidth`.
 * Render-free logic lives in `chat-ink-core.ts` and is unit-tested.
 */

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import { loadSkillsFromDirectory, type Skill } from "@muse/skills";
import { Box, Static, Text, render, useApp, useCursor, useInput } from "ink";
import { homedir } from "node:os";
import { join } from "node:path";
import React, { useCallback, useEffect, useRef, useState } from "react";

import { appendLastChatTurn, clearLastChatHistory, readLastChatHistory } from "./chat-history.js";
import {
  buildTurnMessages,
  cursorCoords,
  emptyInput,
  matchSlashCommands,
  parseSlashCommand,
  reduceInput,
  type ChatTurnMessage,
  type InkKeyEvent,
  type InputState
} from "./chat-ink-core.js";
import { renderMuseBanner } from "./muse-banner.js";
import { buildMusePersona, formatCurrentContextLine } from "./muse-persona.js";
import { resolvePersona } from "./program-helpers.js";
import { resolveDefaultUserKey } from "./user-id.js";

const h = React.createElement;

const SLASH_COMMANDS: readonly { readonly cmd: string; readonly desc: string }[] = [
  { cmd: "help", desc: "명령어 도움말 보기" },
  { cmd: "new", desc: "새 대화 시작 (맥락 비우기)" },
  { cmd: "clear", desc: "화면 지우기 (맥락 유지)" },
  { cmd: "model", desc: "현재 모델 확인" },
  { cmd: "skills", desc: "설치된 스킬 목록 + 추가 방법" },
  { cmd: "exit", desc: "Muse 종료 (ctrl-c)" }
];

// Box geometry: left border (1) + paddingX (1) + the "› " prompt (2).
// The input text — and therefore the cursor — starts at this column.
const INPUT_COL_OFFSET = 4;

export interface RunChatInkOptions {
  readonly model?: string;
  readonly continueHistory?: boolean;
  readonly userId?: string;
  readonly persona?: string;
}

interface DisplayTurn {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
}

export interface SkillInfo {
  readonly name: string;
  readonly description: string;
}

export function MuseChatApp(props: {
  readonly banner: string;
  readonly history: readonly ChatTurnMessage[];
  readonly model: string;
  readonly proactiveOn: boolean;
  readonly skills: readonly SkillInfo[];
  readonly skillsDir: string;
  readonly skillsPrompt: string;
  readonly personaPrompt: () => string | undefined;
  readonly stream: (messages: readonly ChatTurnMessage[]) => AsyncIterable<{ type: string; text?: string; error?: unknown }>;
  readonly onCommit: (user: string, assistant: string) => void;
  readonly onReset: () => void;
}): React.ReactElement {
  const app = useApp();
  const { setCursorPosition } = useCursor();
  const [turns, setTurns] = useState<readonly DisplayTurn[]>([]);
  const [inputState, setInputState] = useState<InputState>(emptyInput);
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const historyRef = useRef<ChatTurnMessage[]>([...props.history]);

  // Clean teardown: re-render once with the cursor released and the input
  // box removed (so Ink's final frame leaves the cursor at the bottom and
  // no stray `› ` lingers under the shell prompt), THEN exit.
  useEffect(() => {
    if (exiting) app.exit();
  }, [exiting, app]);

  const submit = useCallback(async (raw: string) => {
    const message = raw.trim();
    if (message.length === 0) return;

    const slash = parseSlashCommand(message);
    if (slash) {
      const note = (text: string): void => setTurns((prev) => [...prev, { role: "system", text }]);
      if (slash.cmd === "exit" || slash.cmd === "quit") { setExiting(true); return; }
      if (slash.cmd === "clear") { setTurns([]); return; }
      if (slash.cmd === "new") {
        historyRef.current = [];
        setTurns([]);
        props.onReset();
        note("새 대화를 시작했어요 — 이전 맥락을 비웠습니다.");
        return;
      }
      if (slash.cmd === "model") { note(`현재 모델: ${props.model}`); return; }
      if (slash.cmd === "skills") {
        if (props.skills.length === 0) {
          note(`설치된 스킬이 없어요. ${props.skillsDir}/<이름>/SKILL.md 를 추가하거나 \`muse skills add <이름>\` 로 만들 수 있어요.`);
        } else {
          note(`설치된 스킬 (${props.skills.length}): ` + props.skills.map((s) => `${s.name} — ${s.description}`).join(" · ") + ` · 추가: ${props.skillsDir}/`);
        }
        return;
      }
      if (slash.cmd === "help") {
        note("명령어: " + SLASH_COMMANDS.map((c) => `/${c.cmd}`).join(" · ") + " · 그냥 입력하면 대화합니다.");
        return;
      }
      note(`알 수 없는 명령어: /${slash.cmd}`);
      return;
    }

    setTurns((prev) => [...prev, { role: "user", text: message }]);
    setBusy(true);
    setStreaming("");
    const system = (props.personaPrompt() ?? formatCurrentContextLine()) + props.skillsPrompt;
    const messages = buildTurnMessages(system, historyRef.current, message);
    let accumulated = "";
    try {
      for await (const event of props.stream(messages)) {
        if (event.type === "error") {
          const err = event.error;
          throw err instanceof Error ? err : new Error(typeof err === "string" ? err : "model stream failed");
        }
        if (event.type === "text-delta" && typeof event.text === "string") {
          accumulated += event.text;
          setStreaming(accumulated);
        }
      }
    } catch (error) {
      accumulated = `⚠ ${error instanceof Error ? error.message : String(error)}`;
    }
    historyRef.current.push({ content: message, role: "user" });
    historyRef.current.push({ content: accumulated, role: "assistant" });
    setTurns((prev) => [...prev, { role: "assistant", text: accumulated }]);
    setStreaming("");
    setBusy(false);
    props.onCommit(message, accumulated);
  }, [app, props]);

  const slashMenu = matchSlashCommands(inputState.value, SLASH_COMMANDS);
  const slashSel = slashMenu.length > 0 ? Math.min(slashIndex, slashMenu.length - 1) : 0;

  useInput((rawInput: string, key: InkKeyEvent) => {
    if (busy || exiting) return;
    if (key.ctrl && rawInput === "c") { setExiting(true); return; }
    // When the slash menu is open, ↑/↓ move the selection and Tab completes
    // the highlighted command instead of editing text.
    if (slashMenu.length > 0) {
      if (key.upArrow) { setSlashIndex(Math.max(0, slashSel - 1)); return; }
      if (key.downArrow) { setSlashIndex(Math.min(slashMenu.length - 1, slashSel + 1)); return; }
      if (key.tab) {
        const chosen = slashMenu[slashSel]?.cmd ?? "";
        setInputState({ cursor: chosen.length + 2, value: `/${chosen} ` });
        setSlashIndex(0);
        return;
      }
    }
    const result = reduceInput(inputState, rawInput, key);
    if (result.submit) {
      const value = inputState.value;
      setInputState(emptyInput);
      setSlashIndex(0);
      void submit(value);
      return;
    }
    setInputState(result.state);
  });

  // Place the REAL terminal cursor at the input column INSIDE the box so a
  // CJK IME composes there (same technique as the official Ink cursor-ime
  // example and claude-code). Called in the render body — `useCursor` stores
  // it in a ref and applies it during commit via useInsertionEffect, so a
  // post-commit useEffect would lag a frame and reset the cursor. Idle: the
  // box is the first dynamic block, input row at y=1. Busy: hide it.
  const caret = cursorCoords(inputState);
  setCursorPosition(busy || exiting ? undefined : { x: INPUT_COL_OFFSET + caret.col, y: 1 + caret.line });

  const transcript = h(Static, {
    children: (item: unknown, index: number) => {
      if (index === 0) return h(Text, { key: "banner" }, props.banner);
      const turn = item as DisplayTurn;
      if (turn.role === "user") {
        // The user's message stays as a snapshot — the same `› ` prompt
        // they typed it into (codex / claude style), not a "you:" label.
        return h(Box, { key: index, marginBottom: 1, marginTop: 1 },
          h(Text, { color: "cyan" }, "› "),
          h(Text, { color: "cyan" }, turn.text));
      }
      // Assistant + system answers sit indented from the left wall.
      return h(Box, { key: index, marginBottom: 1, paddingLeft: 2 },
        h(Text, { dimColor: turn.role === "system" }, turn.text));
    },
    items: [props.banner, ...turns]
  });

  // Teardown frame: leave only the transcript so the input box and its
  // in-box cursor don't collide with the shell prompt after exit.
  if (exiting) {
    return h(Box, { flexDirection: "column" }, transcript);
  }

  const placeholder = "무엇이든 물어보세요";
  const lines = inputState.value.length > 0 ? inputState.value.split("\n") : [""];

  return h(Box, { flexDirection: "column" },
    transcript,
    // While replying, show the streaming answer ABOVE the box, indented.
    busy
      ? h(Box, { marginBottom: 1, paddingLeft: 2 },
          h(Text, null, streaming.length > 0 ? streaming : "…"))
      : null,
    // The input BOX. When idle it is the first dynamic block, so its
    // content row is y=1 — where useCursor placed the real cursor.
    h(Box, { borderColor: busy ? "gray" : "cyan", borderStyle: "round", flexDirection: "column", paddingX: 1 },
      ...lines.map((ln, i) => h(Box, { key: i },
        h(Text, { color: "cyan" }, i === 0 ? "› " : "  "),
        inputState.value.length === 0
          ? h(Text, { dimColor: true }, placeholder)
          : h(Text, null, ln)))),
    // Slash-command menu: ↑/↓ select, Tab completes, Enter runs.
    slashMenu.length > 0
      ? h(Box, { flexDirection: "column", paddingLeft: 2 },
          ...slashMenu.map((command, i) => {
            const on = i === slashSel;
            return h(Box, { key: command.cmd },
              h(Text, { color: on ? "cyan" : "gray" }, `${on ? "▸ " : "  "}/${command.cmd}`),
              h(Text, { dimColor: !on }, `  — ${command.desc}`));
          }),
          h(Text, { dimColor: true }, "  ↑↓ 선택 · Tab 자동완성 · ⏎ 실행"))
      : null,
    h(Text, { dimColor: true }, "⏎ 전송 · shift+⏎ 줄바꿈 · /help · ctrl-c 종료"),
    // HUD: persistent status — model, proactive (speaks-first) mode, skills.
    h(Box, null,
      h(Text, { color: "magenta" }, "♪ "),
      h(Text, { color: "cyan" }, props.model),
      h(Text, { dimColor: true }, "  ·  proactive "),
      h(Text, { color: props.proactiveOn ? "green" : "gray" }, props.proactiveOn ? "on" : "off"),
      h(Text, { dimColor: true }, `  ·  skills ${props.skills.length.toString()}`))
  );
}

/**
 * Build the local runtime and drive the Ink chat to completion. Prior
 * turns feed the model for memory but are NOT shown (clean entry like
 * `claude`); the transcript scrolls above the box as you chat.
 */
export async function runChatInk(options: RunChatInkOptions = {}): Promise<void> {
  const continueHistory = options.continueHistory !== false;
  if (options.model && !process.env.MUSE_MODEL) process.env.MUSE_MODEL = options.model;
  if (options.model?.startsWith("ollama/") && !process.env.MUSE_MODEL_PROVIDER_ID) {
    process.env.MUSE_MODEL_PROVIDER_ID = "ollama";
  }

  const assembly = createMuseRuntimeAssembly();
  if (!assembly.modelProvider) {
    process.stderr.write("muse: no model configured — set MUSE_MODEL (or pass --model) and re-run.\n");
    process.exitCode = 1;
    return;
  }
  const model = options.model ?? assembly.defaultModel ?? "default";
  const baseUser = resolveDefaultUserKey({ override: options.userId });
  const personaSlot = resolvePersona(options.persona);
  const userId = personaSlot && personaSlot.length > 0 ? `${baseUser}@${personaSlot}` : baseUser;
  const memoryStore = assembly.userMemoryStore;
  const userMemory = memoryStore ? await Promise.resolve(memoryStore.findByUserId(userId)) : undefined;
  const personaPrompt = (): string | undefined => (userMemory ? buildMusePersona(userMemory, userId) : undefined);

  const seedLines = continueHistory ? await readLastChatHistory().catch(() => []) : [];
  const history: ChatTurnMessage[] = seedLines
    .filter((l) => l.role === "user" || l.role === "assistant")
    .map((l) => ({ content: l.content, role: l.role as "user" | "assistant" }))
    .slice(-20);

  const provider = assembly.modelProvider;
  const stream = (messages: readonly ChatTurnMessage[]): AsyncIterable<{ type: string; text?: string; error?: unknown }> =>
    provider.stream({ messages: messages as { role: "system" | "user" | "assistant"; content: string }[], model });

  const onCommit = (user: string, assistant: string): void => {
    void appendLastChatTurn({ message: user, response: assistant }).catch(() => undefined);
  };
  const onReset = (): void => {
    void clearLastChatHistory().catch(() => undefined);
  };

  // Skills: each is a `~/.muse/skills/<name>/SKILL.md` (claude-style). Their
  // instructions are injected into the system prompt so the local model can
  // follow the relevant one. Add a skill = drop a folder there.
  const skillsDir = process.env.MUSE_SKILLS_DIR?.trim() || join(homedir(), ".muse", "skills");
  const skills = await loadSkillsFromDirectory(skillsDir, "user").catch(() => [] as readonly Skill[]);
  const skillsPrompt = buildSkillsPrompt(skills);
  const skillInfos = skills.map((s) => ({ description: s.description, name: s.name }));

  const banner = renderMuseBanner({
    status: `model: ${model}`,
    hint: "새 대화를 시작하세요 — 이전 맥락은 기억하고 있어요."
  }).replace(/^\n+|\n+$/gu, "");
  // Enable the kitty keyboard protocol so the terminal disambiguates
  // modified keys (Shift+Enter → a distinct event Ink reports as
  // key.shift+return). Without it, legacy terminals send Shift+Enter as a
  // bare CR, indistinguishable from Enter. Supporting terminals (Ghostty/
  // cmux, iTerm2, kitty, WezTerm) opt in; others ignore the sequence.
  const proactiveOn = Boolean(process.env.MUSE_PROACTIVE_PROVIDER?.trim() && process.env.MUSE_PROACTIVE_DESTINATION?.trim());
  const instance = render(h(MuseChatApp, {
    banner,
    history,
    model,
    onCommit,
    onReset,
    personaPrompt,
    proactiveOn,
    skills: skillInfos,
    skillsDir,
    skillsPrompt,
    stream
  }), {
    kittyKeyboard: { flags: ["disambiguateEscapeCodes"], mode: "enabled" }
  });
  await instance.waitUntilExit();
}

/** Inject each skill's instructions so the local model can follow them. */
function buildSkillsPrompt(skills: readonly Skill[]): string {
  if (skills.length === 0) return "";
  const blocks = skills.map((skill) => `### ${skill.name}\n${skill.description}\n${skill.body.slice(0, 600).trim()}`);
  return `\n\n## Skills — follow the most relevant one when the user's request matches its purpose.\n${blocks.join("\n\n")}`;
}
