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
import { homedir } from "node:os";
import { join } from "node:path";
import React, { useCallback, useEffect, useRef, useState } from "react";

import { appendLastChatTurn, clearLastChatHistory, readLastChatHistory } from "./chat-history.js";
import {
  buildTurnMessages,
  cursorCoords,
  emptyInput,
  matchAgentNames,
  matchSlashCommands,
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
  { cmd: "exit", desc: "quit Muse (ctrl-c)" }
];

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
  readonly proactiveOn: boolean;
  readonly skills: readonly SkillInfo[];
  readonly skillsDir: string;
  readonly skillsPrompt: string;
  readonly personaPrompt: () => string | undefined;
  readonly stream: (messages: readonly ChatTurnMessage[]) => AsyncIterable<{ type: string; text?: string; error?: unknown }>;
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
  const [ctrlCArmed, setCtrlCArmed] = useState(false);
  const [commandNotice, setCommandNotice] = useState<string | undefined>(undefined);
  const [histPos, setHistPos] = useState(-1);
  const inputHistoryRef = useRef<string[]>([]);
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
      if (slash.cmd === "model") { note(`Current model: ${props.model}`); return; }
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
      if (slash.cmd === "help") {
        note("Commands: " + SLASH_COMMANDS.map((c) => `/${c.cmd}`).join(" · ") + " · just type to chat.");
        return;
      }
      note(`Unknown command: /${slash.cmd}`);
      return;
    }

    setTurns((prev) => [...prev, { role: "user", text: message }]);
    setBusy(true);
    setStreaming("");
    const base = props.personaPrompt() ?? formatCurrentContextLine();
    const agentPrefix = activeAgent ? `${activeAgent.prompt}\n\n` : "";
    const system = agentPrefix + base + props.skillsPrompt;
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
  }, [app, props, activeAgent]);

  const slashMenu = matchSlashCommands(inputState.value, SLASH_COMMANDS);
  const agentMenu = slashMenu.length === 0 ? matchAgentNames(inputState.value, props.agents.map((a) => a.name)) : [];
  const menuLen = slashMenu.length > 0 ? slashMenu.length : agentMenu.length;
  const menuSel = menuLen > 0 ? Math.min(slashIndex, menuLen - 1) : 0;
  const slashSel = menuSel;

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
    if (busy || exiting) return;
    if (ctrlCArmed) setCtrlCArmed(false); // any other key disarms

    // When a picker (slash commands, or agent names after `/agent `) is open,
    // ↑/↓ move the selection and Tab completes the highlighted item.
    if (menuLen > 0) {
      if (key.upArrow) { setSlashIndex(Math.max(0, menuSel - 1)); return; }
      if (key.downArrow) { setSlashIndex(Math.min(menuLen - 1, menuSel + 1)); return; }
      if (key.tab) {
        const completed = slashMenu.length > 0
          ? `/${slashMenu[menuSel]?.cmd ?? ""} `
          : `/agent ${agentMenu[menuSel] ?? ""}`;
        setInputState({ cursor: [...completed].length, value: completed });
        setSlashIndex(0);
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
      if (index === 0) return h(Text, { key: "banner" }, props.banner);
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

  const placeholder = "Ask me anything";
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
      ? h(Box, { flexDirection: "column", marginTop: 1, paddingLeft: 2 },
          ...slashMenu.map((command, i) => {
            const on = i === slashSel;
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
    // Command feedback (from a slash command) shows here in the bottom area,
    // transient — cleared on the next input.
    commandNotice
      ? h(Box, { marginTop: 1, paddingLeft: 2 }, h(Text, { color: "cyan" }, commandNotice))
      : null,
    // Breathing room above the hint, plus the two-press ctrl-c affordance.
    h(Box, { marginTop: 1 },
      ctrlCArmed
        ? h(Text, { color: "yellow" }, "Press ctrl-c again to quit")
        : h(Text, { dimColor: true }, "⏎ send · shift+⏎ newline · /help · ctrl-c×2 quit")),
    // HUD: persistent status — model, proactive (speaks-first) mode, skills.
    h(Box, null,
      h(Text, { color: "magenta" }, "♪ "),
      h(Text, { color: "cyan" }, props.model),
      h(Text, { dimColor: true }, "  ·  proactive "),
      h(Text, { color: props.proactiveOn ? "green" : "gray" }, props.proactiveOn ? "on" : "off"),
      h(Text, { dimColor: true }, `  ·  agent `),
      h(Text, { color: activeAgent ? "yellow" : "gray" }, activeAgent ? activeAgent.name : "default"),
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

  // Manually-defined agents (`~/.muse/agents/<name>/AGENT.md`). `/agent <name>`
  // switches the active one in chat; its body becomes the system prompt.
  const agents = await loadAgents(resolveAgentsDir(process.env)).catch(() => [] as readonly AgentDef[]);

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
    onCommit,
    onReset,
    personaPrompt,
    proactiveCheck,
    proactiveOn,
    skills: skillInfos,
    skillsDir,
    skillsPrompt,
    stream
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
