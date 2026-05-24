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

import { createMuseRuntimeAssembly, resolveFollowupsFile, resolveRemindersFile } from "@muse/autoconfigure";
import { loadSkillsFromDirectory, type Skill } from "@muse/skills";
import { Box, Static, Text, render, useApp, useCursor, useInput } from "ink";
import { spawn } from "node:child_process";
import { mkdir, readFile as fsReadFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import React, { useCallback, useEffect, useRef, useState } from "react";

import { appendLastChatTurn, clearLastChatHistory, readLastChatHistory } from "./chat-history.js";
import {
  buildTurnMessages,
  chatHelp,
  cursorCoords,
  emptyInput,
  extractAttachmentPaths,
  friendlyError,
  matchAgentNames,
  matchModelNames,
  matchSlashCommands,
  parseInlineSpans,
  parseMarkdownBlocks,
  parseSlashCommand,
  reduceInput,
  type ChatTurnMessage,
  type InkKeyEvent,
  type InputState
} from "./chat-ink-core.js";
import { renderMuseBanner } from "./muse-banner.js";
import { loadAgents, resolveAgentsDir, type AgentDef } from "./commands-agents.js";
import { readDueFollowups, readDueReminders } from "./commands-today.js";
import { imminentItems, pickUnseen, proactiveNoticeText, relativeWhen, type ProactiveItem } from "./chat-proactive.js";
import { buildMusePersona, formatCurrentContextLine } from "./muse-persona.js";
import { resolvePersona } from "./program-helpers.js";
import { resolveDefaultUserKey } from "./user-id.js";

const h = React.createElement;

const SLASH_COMMANDS: readonly { readonly cmd: string; readonly desc: string }[] = [
  { cmd: "help", desc: "show command help" },
  { cmd: "new", desc: "new conversation (clear context)" },
  { cmd: "clear", desc: "clear the screen (keep context)" },
  { cmd: "model", desc: "show the current model" },
  { cmd: "agents", desc: "list defined agents" },
  { cmd: "agent", desc: "switch agent — /agent <name> (default to clear)" },
  { cmd: "skills", desc: "list installed skills + how to add" },
  { cmd: "tools", desc: "toggle tools (read + local writes; outbound stays off)" },
  { cmd: "save", desc: "save the last reply to a note file" },
  { cmd: "copy", desc: "copy the last reply to the clipboard" },
  { cmd: "cost", desc: "show this session's token usage" },
  { cmd: "exit", desc: "quit Muse (ctrl-c)" }
];

// Third-party-outbound actuators stay blocked in chat until an in-chat
// approval UX exists — outbound-safety: never an autonomous send. Read tools
// and local writes (notes/tasks/calendar) are allowed when tools are on.
const OUTBOUND_ACTUATORS: readonly string[] = [
  "email_send", "web_action", "home_action", "smart_home", "muse.messaging.send", "objective.act"
];

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toString();
}

/** Render a completed assistant message with light markdown: fenced code
 * (green), headers (bold cyan), inline `code` (yellow) and **bold**. */
export function renderMarkdown(text: string): React.ReactElement {
  const blocks = parseMarkdownBlocks(text);
  return h(Box, { flexDirection: "column" },
    ...blocks.map((block, bi) => {
      if (block.type === "code") {
        return h(Box, { borderColor: "gray", borderLeft: true, borderRight: false, borderTop: false, borderBottom: false, borderStyle: "round", flexDirection: "column", key: `c${bi.toString()}`, paddingLeft: 1 },
          ...block.lines.map((ln, li) => h(Text, { color: "green", key: li.toString() }, ln.length > 0 ? ln : " ")));
      }
      return h(Box, { flexDirection: "column", key: `t${bi.toString()}` },
        ...block.lines.map((line, li) => {
          const header = /^(#{1,6})\s+(.*)$/u.exec(line);
          if (header) return h(Text, { bold: true, color: "cyan", key: li.toString() }, header[2] ?? "");
          const spans = parseInlineSpans(line);
          return h(Text, { key: li.toString() }, ...spans.map((s, si) =>
            h(Text, { bold: s.bold === true, color: s.code === true ? "yellow" : undefined, key: si.toString() }, s.text)));
        }));
    }));
}

// Box geometry: left border (1) + paddingX (1) + the "› " prompt (2).
// The input text — and therefore the cursor — starts at this column.
const INPUT_COL_OFFSET = 4;

// Proactive ("speaks-first") cadence: how far ahead to look, and how often
// to poll while the chat is idle.
const PROACTIVE_LEAD_MS = 60 * 60_000;
const PROACTIVE_POLL_MS = 45_000;

export interface RunChatInkOptions {
  readonly model?: string;
  readonly continueHistory?: boolean;
  readonly userId?: string;
  readonly persona?: string;
}

interface DisplayTurn {
  readonly role: "user" | "assistant" | "system" | "proactive";
  readonly text: string;
}

export interface SkillInfo {
  readonly name: string;
  readonly description: string;
}

export function MuseChatApp(props: {
  readonly banner: string;
  readonly history: readonly ChatTurnMessage[];
  readonly agents: readonly AgentDef[];
  readonly model: string;
  readonly models: readonly string[];
  readonly proactiveOn: boolean;
  readonly skills: readonly SkillInfo[];
  readonly skillsDir: string;
  readonly skillsPrompt: string;
  readonly personaPrompt: () => string | undefined;
  readonly stream: (messages: readonly ChatTurnMessage[], model: string) => AsyncIterable<{ type: string; text?: string; error?: unknown; name?: string; response?: { usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } } }>;
  readonly streamWithTools: (messages: readonly ChatTurnMessage[], model: string) => AsyncIterable<{ type: string; text?: string; error?: unknown; name?: string; response?: { usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } } }>;
  readonly readFile: (relativePath: string) => Promise<string | undefined>;
  readonly saveText: (text: string) => Promise<string | undefined>;
  readonly copyToClipboard: (text: string) => Promise<boolean>;
  readonly onCommit: (user: string, assistant: string) => void;
  readonly onReset: () => void;
  readonly proactiveCheck?: () => Promise<readonly ProactiveItem[]>;
}): React.ReactElement {
  const app = useApp();
  const { setCursorPosition } = useCursor();
  const [turns, setTurns] = useState<readonly DisplayTurn[]>([]);
  const [inputState, setInputState] = useState<InputState>(emptyInput);
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [activeAgent, setActiveAgent] = useState<AgentDef | undefined>(undefined);
  const [currentModel, setCurrentModel] = useState(props.model);
  const [toolsOn, setToolsOn] = useState(false);
  const [ctrlCArmed, setCtrlCArmed] = useState(false);
  const interruptRef = useRef(false);
  const lastAnswerRef = useRef("");
  const [commandNotice, setCommandNotice] = useState<string | undefined>(undefined);
  const [histPos, setHistPos] = useState(-1);
  const [sessionTokens, setSessionTokens] = useState(0);
  const [spinTick, setSpinTick] = useState(0);
  const inputHistoryRef = useRef<string[]>([]);

  // Animate a spinner while a reply is in flight (until the first token).
  useEffect(() => {
    if (!busy) return undefined;
    const timer = setInterval(() => setSpinTick((t) => t + 1), 120);
    return () => clearInterval(timer);
  }, [busy]);
  const historyRef = useRef<ChatTurnMessage[]>([...props.history]);

  // Clean teardown: re-render once with the cursor released and the input
  // box removed (so Ink's final frame leaves the cursor at the bottom and
  // no stray `› ` lingers under the shell prompt), THEN exit.
  useEffect(() => {
    if (exiting) app.exit();
  }, [exiting, app]);

  // Speaks-first: while idle, poll for imminent reminders / follow-ups and
  // raise each (once) in the transcript so Muse opens the conversation.
  const seenRef = useRef<Set<string>>(new Set());
  const idleRef = useRef(true);
  idleRef.current = !busy && !exiting;
  useEffect(() => {
    const check = props.proactiveCheck;
    if (!check) return undefined;
    let active = true;
    const tick = async (): Promise<void> => {
      if (!idleRef.current) return;
      const items = await check().catch(() => [] as readonly ProactiveItem[]);
      if (!active) return;
      const now = Date.now();
      const unseen = pickUnseen(imminentItems(items, now, PROACTIVE_LEAD_MS), seenRef.current);
      if (unseen.length === 0) return;
      for (const item of unseen) seenRef.current.add(item.id);
      setTurns((prev) => [
        ...prev,
        ...unseen.map((item) => ({ role: "proactive" as const, text: proactiveNoticeText(item, relativeWhen(item.dueAt, now)) }))
      ]);
    };
    const first = setTimeout(() => { void tick(); }, 1500);
    const timer = setInterval(() => { void tick(); }, PROACTIVE_POLL_MS);
    return () => { active = false; clearTimeout(first); clearInterval(timer); };
  }, [props]);

  const submit = useCallback(async (raw: string) => {
    const message = raw.trim();
    if (message.length === 0) return;
    setCommandNotice(undefined); // clear the previous command result

    const slash = parseSlashCommand(message);
    if (slash) {
      // Command feedback shows in the bottom area (transient), not the
      // scrolling transcript — like claude / codex.
      const note = (text: string): void => setCommandNotice(text);
      if (slash.cmd === "exit" || slash.cmd === "quit") { setExiting(true); return; }
      if (slash.cmd === "clear") { setTurns([]); return; }
      if (slash.cmd === "new") {
        historyRef.current = [];
        setTurns([]);
        props.onReset();
        note("Started a new conversation — earlier context cleared.");
        return;
      }
      if (slash.cmd === "model") {
        const target = slash.arg.trim();
        if (target.length === 0) {
          note(`Current model: ${currentModel}. Switch this session with /model <name> (e.g. ollama/qwen3.6:35b-a3b).`);
        } else {
          setCurrentModel(target);
          note(`Switched model to ${target} for this session.`);
        }
        return;
      }
      if (slash.cmd === "agents") {
        if (props.agents.length === 0) {
          note("No agents yet. Create one with `muse agents add <name>`, then switch with `/agent <name>`.");
        } else {
          const active = activeAgent ? ` (active: ${activeAgent.name})` : "";
          note(`Agents${active}: ` + props.agents.map((a) => `${a.name} — ${a.description}`).join(" · ") + " · switch: /agent <name>");
        }
        return;
      }
      if (slash.cmd === "agent") {
        const target = slash.arg.trim();
        if (target.length === 0 || target === "default" || target === "off") {
          setActiveAgent(undefined);
          note("Back to the default Muse.");
          return;
        }
        const found = props.agents.find((a) => a.name.toLowerCase() === target.toLowerCase());
        if (!found) {
          note(`No agent named '${target}'. Run /agents to see the list.`);
          return;
        }
        setActiveAgent(found);
        note(`Switched to '${found.name}' — ${found.description}`);
        return;
      }
      if (slash.cmd === "skills") {
        if (props.skills.length === 0) {
          note(`No skills yet. Add ${props.skillsDir}/<name>/SKILL.md, or run \`muse skills add <name>\`.`);
        } else {
          note(`Skills (${props.skills.length}): ` + props.skills.map((s) => `${s.name} — ${s.description}`).join(" · ") + ` · add: ${props.skillsDir}/`);
        }
        return;
      }
      if (slash.cmd === "tools") {
        const next = !toolsOn;
        setToolsOn(next);
        note(next
          ? "Tools ON — read + local writes (notes/tasks/calendar). Outbound (email/web/home) stays blocked for safety."
          : "Tools OFF — plain chat (faster).");
        return;
      }
      if (slash.cmd === "save" || slash.cmd === "copy") {
        const answer = lastAnswerRef.current.trim();
        if (answer.length === 0) { note("Nothing to save yet — ask something first."); return; }
        if (slash.cmd === "save") {
          const path = await props.saveText(answer);
          note(path ? `Saved the last reply to ${path}` : "Couldn't save the reply.");
        } else {
          const ok = await props.copyToClipboard(answer);
          note(ok ? "Copied the last reply to the clipboard." : "Clipboard not available on this system.");
        }
        return;
      }
      if (slash.cmd === "cost") {
        note(sessionTokens > 0 ? `This session: ${formatTokens(sessionTokens)} tokens (local model = $0).` : "No tokens used yet this session.");
        return;
      }
      if (slash.cmd === "help") {
        note(chatHelp(slash.arg, SLASH_COMMANDS.map((c) => c.cmd)));
        return;
      }
      note(`Unknown command: /${slash.cmd}`);
      return;
    }

    setTurns((prev) => [...prev, { role: "user", text: message }]);
    setBusy(true);
    setStreaming("");
    interruptRef.current = false;

    // `@path` attachments: read referenced files and prepend their contents
    // so the model can answer about them. Missing/oversize files fail soft.
    const attachmentPaths = extractAttachmentPaths(message);
    let attachmentBlock = "";
    for (const rel of attachmentPaths) {
      try {
        const body = await props.readFile(rel);
        if (body !== undefined) attachmentBlock += `\n\n[Attached file: ${rel}]\n${body}`;
      } catch { /* skip unreadable attachment */ }
    }
    if (attachmentPaths.length > 0) {
      setCommandNotice(`Attached: ${attachmentPaths.join(", ")}`);
    }

    const base = props.personaPrompt() ?? formatCurrentContextLine();
    const agentPrefix = activeAgent ? `${activeAgent.prompt}\n\n` : "";
    const system = agentPrefix + base + props.skillsPrompt;
    const messages = buildTurnMessages(system, historyRef.current, message + attachmentBlock);
    let accumulated = "";
    let turnTokens = 0;
    const streamer = toolsOn ? props.streamWithTools : props.stream;
    try {
      for await (const event of streamer(messages, currentModel)) {
        if (interruptRef.current) { accumulated += accumulated.length > 0 ? " …(interrupted)" : "(interrupted)"; break; }
        if (event.type === "error") {
          const err = event.error;
          throw err instanceof Error ? err : new Error(typeof err === "string" ? err : "model stream failed");
        }
        if (event.type === "tool-call-started" && typeof event.name === "string" && accumulated.length === 0) {
          setStreaming(`🔧 using ${event.name}…`);
        }
        if (event.type === "text-delta" && typeof event.text === "string") {
          accumulated += event.text;
          setStreaming(accumulated);
        }
        if (event.type === "done") {
          const u = event.response?.usage;
          turnTokens = (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0) + (u?.reasoningTokens ?? 0);
        }
      }
    } catch (error) {
      accumulated = `⚠ ${friendlyError(error instanceof Error ? error.message : String(error))}`;
    }
    if (turnTokens > 0) setSessionTokens((t) => t + turnTokens);
    historyRef.current.push({ content: message, role: "user" });
    historyRef.current.push({ content: accumulated, role: "assistant" });
    setTurns((prev) => [...prev, { role: "assistant", text: accumulated }]);
    setStreaming("");
    setBusy(false);
    if (!accumulated.startsWith("⚠") && accumulated !== "(interrupted)") lastAnswerRef.current = accumulated;
    props.onCommit(message, accumulated);
  }, [app, props, activeAgent, currentModel, sessionTokens, toolsOn]);

  const slashMenu = matchSlashCommands(inputState.value, SLASH_COMMANDS);
  const agentMenu = slashMenu.length === 0 ? matchAgentNames(inputState.value, props.agents.map((a) => a.name)) : [];
  const modelMenu = slashMenu.length === 0 && agentMenu.length === 0 ? matchModelNames(inputState.value, props.models) : [];
  // The active arg-picker (after `/agent ` or `/model `) and its kind.
  const argKind: "agent" | "model" | undefined = agentMenu.length > 0 ? "agent" : modelMenu.length > 0 ? "model" : undefined;
  const argItems = agentMenu.length > 0 ? agentMenu : modelMenu;
  const menuLen = slashMenu.length > 0 ? slashMenu.length : argItems.length;
  const menuSel = menuLen > 0 ? Math.min(slashIndex, menuLen - 1) : 0;

  useInput((rawInput: string, key: InkKeyEvent) => {
    // Ctrl-C: two presses to quit (even mid-stream). First press clears the
    // line and arms; the next quits. Detect both legacy (\x03) and the kitty
    // protocol form. exitOnCtrlC is off so Ink doesn't pre-empt this.
    const isCtrlC = key.ctrl && (rawInput === "c" || rawInput === "");
    if (isCtrlC) {
      if (ctrlCArmed || exiting) { setExiting(true); return; }
      setCtrlCArmed(true);
      setInputState(emptyInput);
      setSlashIndex(0);
      return;
    }
    // Esc while replying interrupts the stream (UI stops consuming it).
    if (busy && key.escape) { interruptRef.current = true; return; }
    if (busy || exiting) return;
    if (ctrlCArmed) setCtrlCArmed(false); // any other key disarms

    // When a picker is open (slash commands, or names after `/agent `/`/model `),
    // ↑/↓ move the selection, Tab completes, Enter runs the highlighted item.
    if (menuLen > 0) {
      if (key.upArrow) { setSlashIndex(Math.max(0, menuSel - 1)); return; }
      if (key.downArrow) { setSlashIndex(Math.min(menuLen - 1, menuSel + 1)); return; }
      const selectedCmd = slashMenu.length > 0 ? (slashMenu[menuSel]?.cmd ?? "") : "";
      const selectedArg = argItems[menuSel] ?? "";
      // Commands that need an argument complete to `/cmd ` so the arg picker opens.
      const needsArg = selectedCmd === "agent" || selectedCmd === "model";
      if (key.tab || (key.return && slashMenu.length > 0 && needsArg)) {
        const completed = slashMenu.length > 0 ? `/${selectedCmd} ` : `/${argKind} ${selectedArg}`;
        setInputState({ cursor: [...completed].length, value: completed });
        setSlashIndex(0);
        return;
      }
      if (key.return) {
        const toRun = slashMenu.length > 0 ? `/${selectedCmd}` : `/${argKind} ${selectedArg}`;
        setInputState(emptyInput);
        setSlashIndex(0);
        void submit(toRun);
        return;
      }
    }
    // ↑/↓ recall previous inputs (single-line only — multiline uses them to
    // move the cursor, handled by reduceInput below).
    if ((key.upArrow || key.downArrow) && !inputState.value.includes("\n") && inputHistoryRef.current.length > 0) {
      const hist = inputHistoryRef.current;
      const next = key.upArrow ? Math.min(histPos + 1, hist.length - 1) : histPos - 1;
      if (next < 0) {
        setHistPos(-1);
        setInputState(emptyInput);
      } else {
        const recalled = hist[hist.length - 1 - next] ?? "";
        setHistPos(next);
        setInputState({ cursor: [...recalled].length, value: recalled });
      }
      return;
    }

    const result = reduceInput(inputState, rawInput, key);
    if (result.submit) {
      const value = inputState.value;
      if (value.trim().length > 0) inputHistoryRef.current.push(value);
      setHistPos(-1);
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
      if (index === 0) return h(Box, { key: "banner", marginBottom: 1 }, h(Text, null, props.banner));
      const turn = item as DisplayTurn;
      if (turn.role === "user") {
        // The user's message stays as a snapshot — the same `› ` prompt
        // they typed it into (codex / claude style), not a "you:" label.
        return h(Box, { key: index, marginBottom: 1, marginTop: 1 },
          h(Text, { color: "cyan" }, "› "),
          h(Text, { color: "cyan" }, turn.text));
      }
      if (turn.role === "proactive") {
        // Muse opening the conversation — stands out from normal answers.
        return h(Box, { key: index, marginBottom: 1, marginTop: 1, paddingLeft: 2 },
          h(Text, { bold: true, color: "magenta" }, turn.text));
      }
      // System notes stay as a plain dim line; assistant answers render with
      // light markdown (code/headers/inline). Both sit indented from the wall.
      return h(Box, { key: index, marginBottom: 1, paddingLeft: 2 },
        turn.role === "system" ? h(Text, { dimColor: true }, turn.text) : renderMarkdown(turn.text));
    },
    items: [props.banner, ...turns]
  });

  // Teardown frame: leave only the transcript so the input box and its
  // in-box cursor don't collide with the shell prompt after exit.
  if (exiting) {
    return h(Box, { flexDirection: "column" }, transcript);
  }

  const placeholder = "Ask me anything";
  const lines = inputState.value.length > 0 ? inputState.value.split("\n") : [""];

  return h(Box, { flexDirection: "column" },
    transcript,
    // While replying, show the streaming answer ABOVE the box, indented.
    busy
      ? h(Box, { marginBottom: 1, paddingLeft: 2 },
          streaming.length > 0
            ? h(Text, null, streaming)
            : h(Text, { color: "cyan" }, `${"⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[spinTick % 10]} thinking…`))
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
      ? h(Box, { flexDirection: "column", marginTop: 1, paddingLeft: 2 },
          ...slashMenu.map((command, i) => {
            const on = i === menuSel;
            return h(Box, { key: command.cmd },
              h(Text, { color: on ? "cyan" : "gray" }, `${on ? "▸ " : "  "}/${command.cmd}`),
              h(Text, { dimColor: !on }, `  — ${command.desc}`));
          }),
          h(Text, { dimColor: true }, "  ↑↓ select · Tab complete · ⏎ run"))
      : null,
    // Agent-name picker while typing `/agent <partial>`.
    agentMenu.length > 0
      ? h(Box, { flexDirection: "column", marginTop: 1, paddingLeft: 2 },
          ...agentMenu.map((name, i) => {
            const on = i === menuSel;
            const def = props.agents.find((a) => a.name === name);
            return h(Box, { key: name },
              h(Text, { color: on ? "yellow" : "gray" }, `${on ? "▸ " : "  "}${name}`),
              h(Text, { dimColor: !on }, def ? `  — ${def.description}` : ""));
          }),
          h(Text, { dimColor: true }, "  ↑↓ select · Tab complete · ⏎ switch"))
      : null,
    // Model picker while typing `/model <partial>`.
    modelMenu.length > 0
      ? h(Box, { flexDirection: "column", marginTop: 1, paddingLeft: 2 },
          ...modelMenu.slice(0, 8).map((name, i) => {
            const on = i === menuSel;
            return h(Box, { key: name },
              h(Text, { color: on ? "cyan" : "gray" }, `${on ? "▸ " : "  "}${name}`),
              name === currentModel ? h(Text, { color: "green" }, "  ✓ current") : null);
          }),
          h(Text, { dimColor: true }, "  ↑↓ select · Tab complete · ⏎ switch"))
      : null,
    // Command feedback (from a slash command) shows here in the bottom area,
    // transient — cleared on the next input.
    commandNotice
      ? h(Box, { marginTop: 1, paddingLeft: 2 }, h(Text, { color: "cyan" }, commandNotice))
      : null,
    // Breathing room above the hint, plus the two-press ctrl-c affordance.
    h(Box, { marginTop: 1 },
      ctrlCArmed
        ? h(Text, { color: "yellow" }, "Press ctrl-c again to quit")
        : busy
          ? h(Text, { dimColor: true }, "esc to stop · ctrl-c×2 quit")
          : h(Text, { dimColor: true }, "⏎ send · shift+⏎ newline · @file · /help · ctrl-c×2 quit")),
    // HUD: persistent status — model, proactive (speaks-first) mode, skills.
    h(Box, null,
      h(Text, { color: "magenta" }, "♪ "),
      h(Text, { color: "cyan" }, currentModel),
      h(Text, { dimColor: true }, "  ·  proactive "),
      h(Text, { color: props.proactiveOn ? "green" : "gray" }, props.proactiveOn ? "on" : "off"),
      h(Text, { dimColor: true }, `  ·  agent `),
      h(Text, { color: activeAgent ? "yellow" : "gray" }, activeAgent ? activeAgent.name : "default"),
      h(Text, { dimColor: true }, "  ·  tools "),
      h(Text, { color: toolsOn ? "green" : "gray" }, toolsOn ? "on" : "off"),
      h(Text, { dimColor: true }, `  ·  skills ${props.skills.length.toString()}`),
      sessionTokens > 0 ? h(Text, { dimColor: true }, `  ·  ${formatTokens(sessionTokens)} tok`) : null)
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
    process.stderr.write(
      "muse: no model configured yet.\n" +
      "  • Local (free):  muse setup local      (installs/points at an Ollama model)\n" +
      "  • Cloud:         muse setup model       (OpenAI / Anthropic / Gemini key)\n" +
      "  Then run `muse` again.\n"
    );
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
  type ChatStream = AsyncIterable<{ type: string; text?: string; error?: unknown; name?: string; response?: { usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } } }>;
  const stream = (messages: readonly ChatTurnMessage[], useModel: string): ChatStream =>
    provider.stream({ messages: messages as { role: "system" | "user" | "assistant"; content: string }[], model: useModel });

  // Tools-on path: route through the agent runtime so the tool loop + guards
  // fire. Outbound actuators stay forbidden (no autonomous third-party send);
  // read tools + local writes run. Falls back to plain stream if no runtime.
  const agentRuntime = assembly.agentRuntime;
  const streamWithTools = (messages: readonly ChatTurnMessage[], useModel: string): ChatStream => {
    if (!agentRuntime) return stream(messages, useModel);
    return agentRuntime.stream({
      messages: messages as { role: "system" | "user" | "assistant"; content: string }[],
      metadata: { forbiddenToolNames: [...OUTBOUND_ACTUATORS] },
      model: useModel
    }) as ChatStream;
  };

  // `@path` attachments: read relative to the launch directory, fail-soft,
  // capped so a huge file can't blow the context window.
  const readFile = async (relativePath: string): Promise<string | undefined> => {
    try {
      const abs = isAbsolute(relativePath) ? relativePath : join(process.cwd(), relativePath);
      const body = await fsReadFile(abs, "utf8");
      return body.length > 8000 ? `${body.slice(0, 8000)}\n…(truncated)` : body;
    } catch {
      return undefined;
    }
  };

  // /save → write the reply to ~/.muse/chat-saves/<ts>.md
  const saveText = async (text: string): Promise<string | undefined> => {
    try {
      const dir = join(homedir(), ".muse", "chat-saves");
      await mkdir(dir, { recursive: true });
      const file = join(dir, `${new Date().toISOString().replace(/[:.]/gu, "-")}.md`);
      await writeFile(file, `${text}\n`, "utf8");
      return file;
    } catch {
      return undefined;
    }
  };
  // /copy → pipe the reply to the platform clipboard tool.
  const copyToClipboard = (text: string): Promise<boolean> => {
    const cmd = process.platform === "darwin" ? "pbcopy" : process.platform === "win32" ? "clip" : "xclip";
    const args = process.platform === "linux" ? ["-selection", "clipboard"] : [];
    return new Promise<boolean>((resolve) => {
      try {
        const proc = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
        proc.on("error", () => resolve(false));
        proc.on("close", (code) => resolve(code === 0));
        proc.stdin.end(text);
      } catch {
        resolve(false);
      }
    });
  };

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

  // Manually-defined agents (`~/.muse/agents/<name>/AGENT.md`). `/agent <name>`
  // switches the active one in chat; its body becomes the system prompt.
  const agents = await loadAgents(resolveAgentsDir(process.env)).catch(() => [] as readonly AgentDef[]);

  // Models the provider can serve (for the `/model` picker). Always include
  // the current one even if listing fails or omits it.
  const modelInfos = await provider.listModels().catch(() => []);
  const models = [...new Set([model, ...modelInfos.map((m) => `${m.providerId}/${m.modelId}`)])];

  // Just the art + tagline — the model and status live in the bottom HUD.
  const banner = renderMuseBanner().replace(/^\n+|\n+$/gu, "");
  // Enable the kitty keyboard protocol so the terminal disambiguates
  // modified keys (Shift+Enter → a distinct event Ink reports as
  // key.shift+return). Without it, legacy terminals send Shift+Enter as a
  // bare CR, indistinguishable from Enter. Supporting terminals (Ghostty/
  // cmux, iTerm2, kitty, WezTerm) opt in; others ignore the sequence.
  const proactiveOn = Boolean(process.env.MUSE_PROACTIVE_PROVIDER?.trim() && process.env.MUSE_PROACTIVE_DESTINATION?.trim());

  // Speaks-first source: imminent reminders + follow-ups from the local
  // stores. (Messenger push already runs via the proactive daemon; this
  // surfaces the same items inside the live chat.)
  const remindersFile = resolveRemindersFile(process.env);
  const followupsFile = resolveFollowupsFile(process.env);
  const proactiveCheck = async (): Promise<readonly ProactiveItem[]> => {
    const horizon = new Date(Date.now() + PROACTIVE_LEAD_MS);
    const [reminders, followups] = await Promise.all([
      readDueReminders(remindersFile, horizon).catch(() => []),
      readDueFollowups(followupsFile, horizon).catch(() => [])
    ]);
    return [
      ...reminders.map((r) => ({ dueAt: r.dueAt, id: r.id, text: r.text })),
      ...followups.map((f) => ({ dueAt: f.scheduledFor, id: f.id, text: f.summary }))
    ];
  };
  const instance = render(h(MuseChatApp, {
    agents,
    banner,
    history,
    model,
    models,
    onCommit,
    onReset,
    personaPrompt,
    proactiveCheck,
    readFile,
    saveText,
    copyToClipboard,
    proactiveOn,
    skills: skillInfos,
    skillsDir,
    skillsPrompt,
    stream,
    streamWithTools
  }), {
    exitOnCtrlC: false,
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
