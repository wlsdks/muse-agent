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

import { createMuseRuntimeAssembly, parseBoolean, resolveEpisodesFile, resolveFollowupsFile, resolveLocalCalendarFile, resolveRemindersFile, resolveTasksFile } from "@muse/autoconfigure";
import { LocalCalendarProvider } from "@muse/calendar";
import { readEpisodes, readFollowups, readTasks } from "@muse/mcp";
import { loadSkillsFromDirectory, type Skill } from "@muse/skills";
import { buildSkillsPrompt } from "./chat-skills.js";
import { selectPersonaEpisodes } from "./episode-selection.js";
import { Box, Static, Text, render, useApp, useCursor, useInput } from "ink";
import { spawn } from "node:child_process";
import { mkdir, readFile as fsReadFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import React, { useCallback, useEffect, useRef, useState } from "react";

import { appendActivity, appendLastChatTurn, appendSessionBoundary, clearLastChatHistory, maybeCompactLastChatHistory, readLastChatHistory } from "./chat-history.js";
import {
  buildRecap,
  buildTurnMessages,
  chatHelp,
  chatToolApprovalGate,
  composeMorningGreeting,
  cursorCoords,
  emptyInput,
  extractAttachmentPaths,
  firstOpenToday,
  formatJobsList,
  greetingName,
  formatMemoryView,
  formatRecallHits,
  formatTrust,
  friendlyError,
  matchAgentNames,
  matchModelNames,
  matchSlashCommands,
  resolveChatHistoryWindow,
  parseInlineSpans,
  parseMarkdownBlocks,
  parseRememberArg,
  parseSlashCommand,
  recurringEpisodeThreads,
  reduceInput,
  resolveForgetKey,
  type ChatTurnMessage,
  type InkKeyEvent,
  type InputState,
  type JobListItem,
  type MemorySnapshot,
  type RecurringThread
} from "./chat-ink-core.js";
import { renderMuseBanner } from "./muse-banner.js";
import { loadAgents, resolveAgentsDir, type AgentDef } from "./commands-agents.js";
import { searchRecall } from "./commands-recall.js";
import { readTrust } from "./commands-trust.js";
import { appendInputHistory, loadInputHistory } from "./chat-input-history.js";
import { extractMemoryFromTurn, formatLearnedSummary, shouldAutoExtract, type AutoMemoryProvider } from "./chat-auto-memory.js";
import { formatReflection, synthesizeReflection, type ReflectionProvider } from "./chat-reflection.js";
import { listRecentJobIds, readJobSummary, startBackgroundJob } from "./commands-jobs.js";
import { buildLocalTodayText, parseLookaheadHours, readDueFollowups, readDueReminders } from "./commands-today.js";
import { calendarEventItems, dueTaskItems, groupProactiveNotice, imminentItems, jobCompletionItems, pickUnseen, type ProactiveItem } from "./chat-proactive.js";
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
  { cmd: "today", desc: "morning briefing — tasks, calendar, weather, headlines" },
  { cmd: "tools", desc: "toggle tools (reads run; writes/actions ask first)" },
  { cmd: "job", desc: "run a long task in the background — /job <prompt>" },
  { cmd: "jobs", desc: "show recent background jobs + status" },
  { cmd: "memory", desc: "show what Muse remembers about you" },
  { cmd: "remember", desc: "teach a fact — /remember <key>=<value>" },
  { cmd: "pref", desc: "set a preference — /pref <key>=<value>" },
  { cmd: "recall", desc: "search past notes + episodes — /recall <query>" },
  { cmd: "reflect", desc: "reflect on patterns across your past sessions" },
  { cmd: "forget", desc: "forget one thing — /forget <key> (or --all)" },
  { cmd: "trust", desc: "show this user's trusted + blocked tools" },
  { cmd: "persona", desc: "show the active persona slot" },
  { cmd: "history", desc: "how many turns are in context" },
  { cmd: "save", desc: "save the last reply to a note file" },
  { cmd: "copy", desc: "copy the last reply to the clipboard" },
  { cmd: "cost", desc: "show this session's token usage" },
  { cmd: "exit", desc: "quit Muse (ctrl-c)" }
];

// Third-party-outbound actuators: in chat these reach the fail-closed
// approval gate, which flags them louder ("Outbound action") and never sends
// without the user's explicit y — outbound-safety: never an autonomous send.
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
  readonly role: "user" | "assistant" | "system" | "proactive" | "command";
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
  readonly skillsPromptFor: (prompt: string) => string;
  readonly historyWindow?: number;
  readonly personaPrompt: () => string | undefined;
  readonly stream: (messages: readonly ChatTurnMessage[], model: string) => AsyncIterable<{ type: string; text?: string; error?: unknown; name?: string; response?: { usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } } }>;
  readonly streamWithTools: (messages: readonly ChatTurnMessage[], model: string, requestApproval: (toolName: string, detail: string, kind: "outbound" | "tool") => Promise<boolean>) => AsyncIterable<{ type: string; text?: string; error?: unknown; name?: string; response?: { usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } } }>;
  readonly readFile: (relativePath: string) => Promise<string | undefined>;
  readonly saveText: (text: string) => Promise<string | undefined>;
  readonly copyToClipboard: (text: string) => Promise<boolean>;
  readonly onCommit: (user: string, assistant: string) => void;
  readonly autoLearn?: (user: string, assistant: string) => Promise<string | undefined>;
  readonly onReset: () => void;
  readonly proactiveCheck?: () => Promise<readonly ProactiveItem[]>;
  readonly jobCompletions?: () => Promise<readonly ProactiveItem[]>;
  readonly recapRole?: "system" | "command";
  readonly inputHistorySeed?: readonly string[];
  readonly onInput?: (value: string) => void;
  readonly episodeInfo?: { readonly count: number; readonly lastAt?: string };
  readonly recurringThreads?: readonly RecurringThread[];
  readonly reflect?: () => Promise<string>;
  readonly memorySnapshot: () => Promise<MemorySnapshot | undefined>;
  readonly forgetMemory: (key: string) => Promise<boolean>;
  readonly rememberFact: (key: string, value: string) => Promise<boolean>;
  readonly setPreference: (key: string, value: string) => Promise<boolean>;
  readonly wipeMemory: () => Promise<boolean>;
  readonly trustInfo: () => Promise<{ trusted: readonly string[]; blocked: readonly string[] }>;
  readonly persona?: string;
  readonly recallSearch: (query: string) => Promise<string>;
  readonly todayBrief: () => Promise<string>;
  readonly startJob: (prompt: string) => string;
  readonly jobsOverview: () => Promise<readonly JobListItem[]>;
  readonly recap: string;
}): React.ReactElement {
  const app = useApp();
  const { setCursorPosition } = useCursor();
  const [turns, setTurns] = useState<readonly DisplayTurn[]>(
    props.recap ? [{ role: props.recapRole ?? "system", text: props.recap }] : []
  );
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
  const [pendingApproval, setPendingApproval] = useState<{ readonly name: string; readonly detail: string; readonly kind: "outbound" | "tool"; readonly resolve: (ok: boolean) => void } | undefined>(undefined);
  const inputHistoryRef = useRef<string[]>([...(props.inputHistorySeed ?? [])]);

  // Tool-action approval: the gate (in streamWithTools) calls this for any
  // write/execute tool, which surfaces a y/n prompt and resolves when the user
  // answers. The detail line shows the exact arguments so the user confirms the
  // content, not just the tool name (outbound-safety.md rule 1).
  const requestApproval = useCallback((name: string, detail: string, kind: "outbound" | "tool"): Promise<boolean> =>
    new Promise<boolean>((resolve) => setPendingApproval({ detail, kind, name, resolve })), []);

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
    const jobsDone = props.jobCompletions;
    if (!check && !jobsDone) return undefined;
    let active = true;
    const tick = async (): Promise<void> => {
      if (!idleRef.current) return;
      const now = Date.now();
      const items = check ? await check().catch(() => [] as readonly ProactiveItem[]) : [];
      // Background jobs that finished since the chat opened are surfaced once
      // each (their own pre-phrased line), not via the reminder time-window.
      const completed = jobsDone ? await jobsDone().catch(() => [] as readonly ProactiveItem[]) : [];
      if (!active) return;
      const unseen = pickUnseen(imminentItems(items, now, PROACTIVE_LEAD_MS), seenRef.current);
      const unseenJobs = pickUnseen(completed, seenRef.current);
      if (unseen.length === 0 && unseenJobs.length === 0) return;
      for (const item of [...unseen, ...unseenJobs]) seenRef.current.add(item.id);
      const grouped = groupProactiveNotice(unseen, now);
      setTurns((prev) => [
        ...prev,
        ...(grouped ? [{ role: "proactive" as const, text: grouped }] : []),
        ...unseenJobs.map((item) => ({ role: "proactive" as const, text: item.text }))
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
      // Echo the command into the transcript (so it's clear WHAT ran) and
      // render its result there too — persistent + properly formatted, not a
      // transient bottom line that truncated multi-line output like /memory.
      const note = (text: string): void => setTurns((prev) => [...prev, { role: "command", text }]);
      const progress = (text: string): void => setCommandNotice(text);
      // Commands that wipe or leave the screen don't echo (nothing to keep).
      if (slash.cmd === "exit" || slash.cmd === "quit") { setExiting(true); return; }
      if (slash.cmd === "clear") { setTurns([]); return; }
      if (slash.cmd === "new") {
        // A clean break: clear the model context AND every per-session ref, so
        // proactive dedup, tool exposure, input history, and the last reply
        // don't leak into the "new" conversation.
        historyRef.current = [];
        setTurns([]);
        seenRef.current = new Set();
        inputHistoryRef.current = [];
        lastAnswerRef.current = "";
        setToolsOn(false);
        setHistPos(-1);
        props.onReset();
        setCommandNotice("Started a new conversation — earlier context cleared.");
        return;
      }
      setTurns((prev) => [...prev, { role: "user", text: message }]);
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
          ? "Tools ON — reads run silently; writes/actions (notes, tasks, email/web/home) ask for your y/n first."
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
      if (slash.cmd === "today") {
        progress("Composing today's briefing…");
        note(await props.todayBrief());
        setCommandNotice(undefined);
        return;
      }
      if (slash.cmd === "memory") {
        note(formatMemoryView(await props.memorySnapshot(), props.episodeInfo, props.recurringThreads));
        return;
      }
      if (slash.cmd === "reflect") {
        if (!props.reflect) { note("Reflection needs the local model — start Muse with tools/model enabled."); return; }
        note("🪞 reflecting on your past sessions…");
        note(await props.reflect());
        return;
      }
      if (slash.cmd === "remember") {
        const parsed = parseRememberArg(slash.arg);
        if (!parsed) { note("Tell me what to remember — /remember <key>=<value> (e.g. /remember city=Seoul)."); return; }
        const prior = (await props.memorySnapshot())?.facts[parsed.key];
        const ok = await props.rememberFact(parsed.key, parsed.value);
        if (!ok) { note("Couldn't save that — memory isn't available."); return; }
        note(prior !== undefined && prior !== parsed.value
          ? `✓ Updated ${parsed.key}: ${prior} → ${parsed.value}`
          : `✓ Remembered ${parsed.key}: ${parsed.value}`);
        return;
      }
      if (slash.cmd === "pref") {
        const parsed = parseRememberArg(slash.arg);
        if (!parsed) { note("Set a preference — /pref <key>=<value> (e.g. /pref reply_style=concise)."); return; }
        const ok = await props.setPreference(parsed.key, parsed.value);
        note(ok ? `✓ Preference ${parsed.key}: ${parsed.value}` : "Couldn't save that — memory isn't available.");
        return;
      }
      if (slash.cmd === "trust") {
        const t = await props.trustInfo();
        note(formatTrust(t.trusted, t.blocked));
        return;
      }
      if (slash.cmd === "persona") {
        note(props.persona
          ? `Active persona: ${props.persona}. Each persona keeps its own memory; switch by relaunching: muse --persona <slot>.`
          : "No persona (base profile). Start one with: muse --persona <slot> (e.g. work / home).");
        return;
      }
      if (slash.cmd === "history") {
        note(`${historyRef.current.length} turns in this conversation. /new starts fresh; /clear just clears the screen.`);
        return;
      }
      if (slash.cmd === "recall") {
        progress("Searching memory…");
        note(await props.recallSearch(slash.arg));
        setCommandNotice(undefined);
        return;
      }
      if (slash.cmd === "job") {
        const prompt = slash.arg.trim();
        if (prompt.length === 0) { note("What should I run in the background? — /job <prompt>"); return; }
        const id = props.startJob(prompt);
        note(`Started background job ${id} — keep chatting; check it with /jobs.`);
        return;
      }
      if (slash.cmd === "jobs") {
        progress("Checking jobs…");
        note(formatJobsList(await props.jobsOverview()));
        setCommandNotice(undefined);
        return;
      }
      if (slash.cmd === "forget") {
        const key = slash.arg.trim();
        if (key.length === 0) { note("Tell me what to forget — /forget <key>, or /forget --all to wipe everything."); return; }
        if (key === "--all" || key.toLowerCase() === "all") {
          const wiped = await props.wipeMemory();
          note(wiped ? "✓ Wiped everything I remembered about you." : "Nothing to wipe.");
          return;
        }
        const snap = await props.memorySnapshot();
        const keys = snap ? [...Object.keys(snap.facts), ...Object.keys(snap.preferences)] : [];
        const resolved = resolveForgetKey(keys, key);
        if (resolved.kind === "none") { note(`Nothing remembered matching "${key}" — check /memory for the keys.`); return; }
        if (resolved.kind === "ambiguous") { note(`"${key}" matches ${resolved.matches.length}: ${resolved.matches.join(", ")}. Be more specific.`); return; }
        const ok = await props.forgetMemory(resolved.key);
        note(ok ? `✓ Forgot "${resolved.key}".` : `Nothing remembered under "${resolved.key}".`);
        return;
      }
      if (slash.cmd === "help") {
        note(chatHelp(slash.arg, SLASH_COMMANDS));
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
    const system = agentPrefix + base + props.skillsPromptFor(message);
    const messages = buildTurnMessages(system, historyRef.current, message + attachmentBlock, props.historyWindow);
    let accumulated = "";
    let turnTokens = 0;
    const iter = toolsOn
      ? props.streamWithTools(messages, currentModel, requestApproval)
      : props.stream(messages, currentModel);
    try {
      for await (const event of iter) {
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
    // Background auto-memory: surface anything Muse learned so the user sees it.
    void props.autoLearn?.(message, accumulated)
      .then((summary) => { if (summary) setTurns((prev) => [...prev, { role: "system", text: summary }]); })
      .catch(() => undefined);
  }, [app, props, activeAgent, currentModel, sessionTokens, toolsOn, requestApproval]);

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
    const isCtrlC = key.ctrl && (rawInput === "c" || rawInput === "\x03");
    if (isCtrlC) {
      if (ctrlCArmed || exiting) { setExiting(true); return; }
      setCtrlCArmed(true);
      setInputState(emptyInput);
      setSlashIndex(0);
      return;
    }
    // An outbound action is awaiting confirmation: y approves, anything else
    // (n / Esc / Enter) denies. Fail-closed — only an explicit y sends.
    if (pendingApproval) {
      const approved = rawInput === "y" || rawInput === "Y";
      pendingApproval.resolve(approved);
      setPendingApproval(undefined);
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
      if (value.trim().length > 0) {
        inputHistoryRef.current.push(value);
        props.onInput?.(value);
      }
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
      if (turn.role === "command") {
        // Slash-command output — readable normal-weight text (not the muted
        // system grey), indented under its `› /cmd` echo.
        return h(Box, { key: index, marginBottom: 1, paddingLeft: 2 }, h(Text, null, turn.text));
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
    // Tool action awaiting confirmation — show the exact content, fail-closed.
    pendingApproval
      ? h(Box, { borderColor: "yellow", borderStyle: "round", flexDirection: "column", marginBottom: 1, paddingX: 1 },
          h(Text, { bold: true, color: "yellow" },
            `⚠ ${pendingApproval.kind === "outbound" ? "Outbound action" : "Tool action"} — ${pendingApproval.name}`),
          h(Text, null, pendingApproval.detail),
          h(Text, { dimColor: true },
            `${pendingApproval.kind === "outbound" ? "Send this?" : "Run this?"}  y = approve  ·  any other key = cancel`))
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
  // Mutable holder so /forget and /remember take effect on the NEXT turn's
  // persona — otherwise the system prompt keeps injecting a fact the user just
  // dropped (what /memory shows would diverge from what's actually injected).
  const memoryHolder: { current: Awaited<ReturnType<NonNullable<typeof memoryStore>["findByUserId"]>> | undefined } = {
    current: memoryStore ? await Promise.resolve(memoryStore.findByUserId(userId)) : undefined
  };
  const refreshMemory = async (): Promise<void> => {
    if (memoryStore) memoryHolder.current = await Promise.resolve(memoryStore.findByUserId(userId));
  };
  // Episodic memory in the persona: the most recent episodes for this user
  // ride into the system prompt so Muse recalls past sessions, not just the
  // last-chat tail. Best-effort (missing/corrupt episodes file → none).
  const personaEpisodes = await loadPersonaEpisodes(userId).catch(() => []);
  const recurringThreads = recurringEpisodeThreads(personaEpisodes);
  const personaPrompt = (): string | undefined =>
    memoryHolder.current ? buildMusePersona({ ...memoryHolder.current, episodes: personaEpisodes, recurringThreads }, userId) : undefined;

  // Long-session compaction: if last-chat.jsonl has grown past the threshold,
  // summarise the old turns into one line before seeding — so a multi-day
  // continuous relationship doesn't blow the context window ("doesn't forget;
  // it abstracts"). Best-effort; falls through on any failure.
  if (continueHistory && assembly.modelProvider) {
    try {
      await maybeCompactLastChatHistory(
        assembly.modelProvider as Parameters<typeof maybeCompactLastChatHistory>[0],
        model
      );
    } catch { /* compaction is best-effort */ }
  }

  const seedLines = continueHistory ? await readLastChatHistory().catch(() => []) : [];
  const history: ChatTurnMessage[] = seedLines
    .filter((l) => l.role === "user" || l.role === "assistant")
    .map((l) => ({ content: l.content, role: l.role as "user" | "assistant" }))
    .slice(-20);

  // Shell-style ↑/↓ input history across sessions.
  const inputHistorySeed = await loadInputHistory().catch(() => [] as string[]);

  // Mark the session start: an activity event (routine learning) + a boundary
  // sentinel in last-chat.jsonl. The boundary tells the end-of-session episode
  // extractor which turns belong to THIS session (read on exit, below).
  await appendActivity({ kind: "repl-start", userId }).catch(() => undefined);
  await appendSessionBoundary({ tsIso: new Date().toISOString(), userId }).catch(() => undefined);

  const provider = assembly.modelProvider;
  type ChatStream = AsyncIterable<{ type: string; text?: string; error?: unknown; name?: string; response?: { usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } } }>;
  const stream = (messages: readonly ChatTurnMessage[], useModel: string): ChatStream =>
    provider.stream({ messages: messages as { role: "system" | "user" | "assistant"; content: string }[], model: useModel });

  // Tools-on path: route through the agent runtime so the tool loop + guards
  // fire. Outbound actuators stay forbidden (no autonomous third-party send);
  // read tools + local writes run. Falls back to plain stream if no runtime.
  const agentRuntime = assembly.agentRuntime;
  const streamWithTools = (
    messages: readonly ChatTurnMessage[],
    useModel: string,
    requestApproval: (toolName: string, detail: string, kind: "outbound" | "tool") => Promise<boolean>
  ): ChatStream => {
    if (!agentRuntime) return stream(messages, useModel);
    return agentRuntime.stream({
      messages: messages as { role: "system" | "user" | "assistant"; content: string }[],
      // `localMode` exposes execute-risk tools (email/web/home actuators, shell)
      // to the chat model; the fail-closed gate below is what keeps them safe —
      // every write/execute call must be confirmed by the user with its content
      // shown, reads run silently, and a denial / gate error blocks the call
      // (runtime fail-close). This is the in-chat "act" path per outbound-safety.md.
      metadata: { localMode: true, userId },
      model: useModel,
      toolApprovalGate: chatToolApprovalGate(OUTBOUND_ACTUATORS, requestApproval)
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

  // Background auto-memory: after a turn, quietly learn durable facts the user
  // stated in passing — no "remember this" needed. Cooldown-gated so the snappy
  // reply path isn't slowed; returns a short summary of what was newly stored so
  // the chat can surface it (the user sees it + can /forget). Opt out with
  // MUSE_USER_MEMORY_AUTO_EXTRACT=false.
  const autoMemoryEnabled = memoryStore !== undefined
    && process.env.MUSE_USER_MEMORY_AUTO_EXTRACT?.trim().toLowerCase() !== "false"
    && "generate" in provider;
  const lastExtract = { current: undefined as number | undefined };
  const autoLearn = async (user: string, assistant: string): Promise<string | undefined> => {
    if (!autoMemoryEnabled || assistant.trim().length === 0) return undefined;
    const now = Date.now();
    if (!shouldAutoExtract(lastExtract.current, now)) return undefined;
    lastExtract.current = now;
    try {
      const { facts, preferences } = await extractMemoryFromTurn({
        assistant, model, provider: provider as unknown as AutoMemoryProvider, user
      });
      const wroteFacts: Record<string, string> = {};
      const wrotePrefs: Record<string, string> = {};
      for (const [key, value] of Object.entries(facts).slice(0, 5)) {
        await Promise.resolve(memoryStore!.upsertFact(userId, key, value)); wroteFacts[key] = value;
      }
      for (const [key, value] of Object.entries(preferences).slice(0, 5)) {
        await Promise.resolve(memoryStore!.upsertPreference(userId, key, value)); wrotePrefs[key] = value;
      }
      const summary = formatLearnedSummary(wroteFacts, wrotePrefs);
      if (summary) await refreshMemory();
      return summary;
    } catch {
      return undefined;
    }
  };
  const onReset = (): void => {
    void clearLastChatHistory().catch(() => undefined);
  };

  // Memory transparency/control surfaced inside the chat: /memory reads what
  // Muse knows, /remember teaches a fact, /forget drops one key. All re-read
  // from the store + refresh the persona holder so the change is reflected both
  // in /memory AND in the next turn's injected system prompt. Fail-soft.
  const memorySnapshot = async (): Promise<MemorySnapshot | undefined> => {
    if (!memoryStore) return undefined;
    try {
      const m = await Promise.resolve(memoryStore.findByUserId(userId));
      return m
        ? {
          facts: m.facts,
          preferences: m.preferences,
          recentTopics: m.recentTopics,
          ...(m.factHistory
            ? { factHistory: m.factHistory.map((e) => ({ key: e.key, previousValue: e.previousValue, replacedAt: e.replacedAt.toISOString() })) }
            : {})
        }
        : undefined;
    } catch {
      return undefined;
    }
  };
  const forgetMemory = async (key: string): Promise<boolean> => {
    if (!memoryStore?.forget) return false;
    try {
      const removed = await Promise.resolve(memoryStore.forget(userId, key));
      if (removed) await refreshMemory();
      return removed;
    } catch {
      return false;
    }
  };
  const rememberFact = async (key: string, value: string): Promise<boolean> => {
    if (!memoryStore) return false;
    try {
      await Promise.resolve(memoryStore.upsertFact(userId, key, value));
      await refreshMemory();
      return true;
    } catch {
      return false;
    }
  };
  const setPreference = async (key: string, value: string): Promise<boolean> => {
    if (!memoryStore) return false;
    try {
      await Promise.resolve(memoryStore.upsertPreference(userId, key, value));
      await refreshMemory();
      return true;
    } catch {
      return false;
    }
  };
  const wipeMemory = async (): Promise<boolean> => {
    if (!memoryStore) return false;
    try {
      const dropped = await Promise.resolve(memoryStore.deleteByUserId(userId));
      await refreshMemory();
      return dropped;
    } catch {
      return false;
    }
  };
  const trustInfo = async (): Promise<{ trusted: readonly string[]; blocked: readonly string[] }> => {
    try {
      const t = await readTrust(userId);
      return { blocked: t.blockedTools, trusted: t.trustedTools };
    } catch {
      return { blocked: [], trusted: [] };
    }
  };

  // /recall — semantic search across the notes + episode indices. Reuses the
  // same pipeline as `muse recall`; fail-soft to a hint when Ollama is down or
  // no index has been built (the embed call throws / hits come back empty).
  const recallSearch = async (query: string): Promise<string> => {
    const q = query.trim();
    if (q.length === 0) return "What should I recall? — /recall <query>";
    const embedModel = process.env.MUSE_RECALL_EMBED_MODEL?.trim() || "nomic-embed-text";
    try {
      const warnings: string[] = [];
      const hits = await searchRecall({ query: q, source: "all", limit: 5, embedModel, env: process.env, onWarn: (m) => warnings.push(m.trim()) });
      const body = formatRecallHits(q, hits);
      return hits.length === 0 && warnings.length > 0 ? `${body}\n${warnings.join("\n")}` : body;
    } catch {
      return "Recall needs Ollama running + an index — try `muse notes reindex` / `muse episode reindex`.";
    }
  };

  // /reflect — cross-session synthesis: read this user's episodes and ask the
  // local model for ONE grounded observation (fenced against hallucination).
  // reflectInsight returns the RAW insight ("" when none); /reflect formats it
  // with a friendly empty-state, while the morning brief surfaces it ONLY when
  // non-empty (no "nothing stands out" nag at session open).
  const reflectInsight = async (): Promise<string> => {
    try {
      const all = await readEpisodes(resolveEpisodesFile(process.env)).catch(() => []);
      const mine = all.filter((episode) => episode.userId === userId);
      return await synthesizeReflection({ episodes: mine, model, provider: provider as unknown as ReflectionProvider });
    } catch {
      return "";
    }
  };
  const reflect = async (): Promise<string> => formatReflection(await reflectInsight());

  // /today — the morning briefing composed locally (tasks/events/weather/
  // headlines/reminders) so the small model never chains four tool calls.
  const todayBrief = (): Promise<string> =>
    buildLocalTodayText(process.env, parseLookaheadHours(undefined)).catch(() => "Couldn't compose today's briefing.");

  // /job — fire off a long-running task in a detached worker (same machinery
  // as `muse job run`) so the user keeps chatting; /jobs reads recent statuses.
  const startJob = (prompt: string): string => startBackgroundJob(prompt, {
    ...(options.userId ? { user: options.userId } : {}),
    ...(personaSlot ? { persona: personaSlot } : {})
  }).id;
  const jobsOverview = async (): Promise<readonly JobListItem[]> => {
    try {
      const summaries = await Promise.all(listRecentJobIds(8).map((id) => readJobSummary(id)));
      return summaries
        .filter((s): s is NonNullable<typeof s> => Boolean(s))
        .map((s) => ({
          id: s.id,
          status: s.status,
          ...(s.prompt ? { prompt: s.prompt } : {}),
          ...(s.finalText ? { finalText: s.finalText } : {})
        }));
    } catch {
      return [];
    }
  };
  // Muse speaks up when a job started this session finishes. `chatStartedIso`
  // stops jobs that completed before launch from announcing on the first poll.
  const chatStartedIso = new Date().toISOString();
  const jobCompletions = async (): Promise<readonly ProactiveItem[]> => {
    const summaries = await Promise.all(listRecentJobIds(20).map((id) => readJobSummary(id)));
    return jobCompletionItems(
      summaries
        .filter((s): s is NonNullable<typeof s> => Boolean(s))
        .map((s) => ({ id: s.id, status: s.status, finishedAt: s.finishedAt, prompt: s.prompt, finalText: s.finalText })),
      chatStartedIso
    );
  };

  // Launch recap — "where we left off": the most recent episode summary plus
  // open-commitment counts. Only when resuming a continuous session; fail-soft
  // to no recap if any store is missing/unreadable.
  const oneLineRecap = continueHistory
    ? await (async (): Promise<string> => {
        const [episodes, tasks, followups] = await Promise.all([
          readEpisodes(resolveEpisodesFile(process.env)).catch(() => []),
          readTasks(resolveTasksFile(process.env)).catch(() => []),
          readFollowups(resolveFollowupsFile(process.env)).catch(() => [])
        ]);
        const latest = [...episodes].sort((a, b) => a.endedAt.localeCompare(b.endedAt)).at(-1);
        return buildRecap({
          ...(latest ? { lastEpisode: latest.summary } : {}),
          pendingTasks: tasks.filter((t) => t.status === "open").length,
          pendingFollowups: followups.filter((f) => f.status === "scheduled").length
        });
      })().catch(() => "")
    : "";

  // First open of the day → greet with the FULL morning briefing instead of the
  // one-line recap (JARVIS opening the day). A YYYY-MM-DD marker in ~/.muse
  // gates it to once per day; same-day reopens fall back to the recap line.
  let recap = oneLineRecap;
  let recapRole: "system" | "command" = "system";
  if (continueHistory) {
    const todayStr = new Date().toISOString().slice(0, 10);
    const briefMarkerFile = join(homedir(), ".muse", "last-brief-date");
    let lastBrief: string | undefined;
    try { lastBrief = await fsReadFile(briefMarkerFile, "utf8"); } catch { lastBrief = undefined; }
    if (firstOpenToday(lastBrief, todayStr)) {
      const brief = await buildLocalTodayText(process.env, parseLookaheadHours(undefined)).catch(() => "");
      if (brief) {
        const who = greetingName(memoryHolder.current?.facts);
        // Proactive reflection: once-a-day, if a cross-session thread is
        // unresolved, Muse opens with the observation unprompted (speaks-first)
        // — but only when there's an honest insight, never a nag.
        const insight = await reflectInsight();
        recap = composeMorningGreeting({ brief, insight, ...(who ? { who } : {}) });
        recapRole = "command";
        try {
          await mkdir(join(homedir(), ".muse"), { recursive: true });
          await writeFile(briefMarkerFile, todayStr, "utf8");
        } catch { /* best-effort; a failed marker just re-briefs next open */ }
      }
    }
  }

  // Skills: each is a `~/.muse/skills/<name>/SKILL.md` (claude-style). Their
  // instructions are injected into the system prompt so the local model can
  // follow the relevant one. Add a skill = drop a folder there.
  const skillsDir = process.env.MUSE_SKILLS_DIR?.trim() || join(homedir(), ".muse", "skills");
  const skills = await loadSkillsFromDirectory(skillsDir, "user").catch(() => [] as readonly Skill[]);
  const skillsPromptFor = (prompt: string): string => buildSkillsPrompt(skills, prompt);
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
  const calendarFile = resolveLocalCalendarFile(process.env);
  const proactiveCheck = async (): Promise<readonly ProactiveItem[]> => {
    const now = new Date();
    const horizon = new Date(now.getTime() + PROACTIVE_LEAD_MS);
    const [reminders, followups, tasks, events] = await Promise.all([
      readDueReminders(remindersFile, horizon).catch(() => []),
      readDueFollowups(followupsFile, horizon).catch(() => []),
      readTasks(resolveTasksFile(process.env)).catch(() => []),
      new LocalCalendarProvider({ file: calendarFile }).listEvents({ from: now, to: horizon }).catch(() => [])
    ]);
    return [
      ...reminders.map((r) => ({ dueAt: r.dueAt, id: r.id, text: r.text })),
      ...followups.map((f) => ({ dueAt: f.scheduledFor, id: f.id, text: f.summary })),
      ...dueTaskItems(tasks, horizon.getTime()),
      ...calendarEventItems(
        events.map((e) => ({ id: e.id, startsAtIso: e.startsAt.toISOString(), title: e.title })),
        horizon.getTime()
      )
    ];
  };
  const instance = render(h(MuseChatApp, {
    agents,
    banner,
    history,
    model,
    models,
    onCommit,
    autoLearn,
    onReset,
    personaPrompt,
    proactiveCheck,
    readFile,
    saveText,
    copyToClipboard,
    proactiveOn,
    skills: skillInfos,
    skillsDir,
    skillsPromptFor,
    historyWindow: resolveChatHistoryWindow(process.env),
    stream,
    streamWithTools,
    memorySnapshot,
    forgetMemory,
    rememberFact,
    setPreference,
    wipeMemory,
    trustInfo,
    ...(personaSlot ? { persona: personaSlot } : {}),
    recallSearch,
    reflect,
    todayBrief,
    startJob,
    jobsOverview,
    jobCompletions,
    recap,
    recapRole,
    inputHistorySeed,
    onInput: (value: string) => { void appendInputHistory(value); },
    ...(personaEpisodes.length > 0 ? { episodeInfo: { count: personaEpisodes.length, ...(personaEpisodes[0]?.endedAt ? { lastAt: personaEpisodes[0].endedAt } : {}) } } : {}),
    ...(recurringThreads.length > 0 ? { recurringThreads } : {})
  }), {
    exitOnCtrlC: false,
    kittyKeyboard: { flags: ["disambiguateEscapeCodes"], mode: "enabled" }
  });
  await instance.waitUntilExit();

  // End-of-session episode: summarise the just-finished conversation (turns
  // since the boundary written at boot) into ~/.muse/episodes.json so /recall
  // and the launch recap keep growing from interactive use. Opt-in
  // (MUSE_EPISODIC_MEMORY_ENABLED, checked inside) + fail-soft, so a flaky
  // model or filesystem never blocks exit. Needs a generate-capable provider.
  if (assembly.modelProvider && "generate" in assembly.modelProvider) {
    const { captureEndOfSessionEpisode } = await import("./chat-end-session.js");
    await captureEndOfSessionEpisode({
      model,
      modelProvider: assembly.modelProvider as Parameters<typeof captureEndOfSessionEpisode>[0]["modelProvider"],
      userId
    }).catch(() => undefined);

    // End-of-session auto-distillation: turn any correction the user made this
    // session into a generalised [Learned Strategies] entry (ReasoningBank,
    // arXiv 2509.25140). Opt-in + fail-soft so a flaky model never blocks exit.
    if (parseBoolean(process.env.MUSE_PLAYBOOK_DISTILL_ENABLED, false)) {
      const { distillSessionCorrections } = await import("./chat-distill-corrections.js");
      await distillSessionCorrections({
        model,
        modelProvider: assembly.modelProvider as Parameters<typeof distillSessionCorrections>[0]["modelProvider"],
        userId
      }).catch(() => undefined);
    }

    // End-of-session skill authoring: turn a procedural correction into a
    // reusable, execute-gated SKILL.md (picked up next session). Opt-in +
    // fail-soft so a flaky model never blocks exit.
    if (parseBoolean(process.env.MUSE_SKILL_AUTHOR_ENABLED, false)) {
      const { authorSkillsFromSession } = await import("./chat-author-skills.js");
      const result = await authorSkillsFromSession({
        model,
        modelProvider: assembly.modelProvider as Parameters<typeof authorSkillsFromSession>[0]["modelProvider"]
      }).catch(() => undefined);
      if (result?.status === "authored") {
        for (const name of result.skills) {
          process.stderr.write(`💾 Learned skill: ${name}\n`);
        }
      }
    }
  }
}

/**
 * Most-recent episodes for a user, newest-first + capped, shaped for the
 * persona block (so past sessions ride into the system prompt). Best-effort.
 */
async function loadPersonaEpisodes(
  userId: string
): Promise<readonly { readonly endedAt: string; readonly summary: string; readonly topics?: readonly string[] }[]> {
  const all = await readEpisodes(resolveEpisodesFile(process.env));
  const capRaw = Number(process.env.MUSE_EPISODIC_MEMORY_MAX_ENTRIES);
  const cap = Number.isFinite(capRaw) && capRaw > 0 ? Math.trunc(capRaw) : 20;
  const mine = all.filter((entry) => entry.userId === userId);
  return selectPersonaEpisodes(mine, cap).map((entry) => ({
    endedAt: entry.endedAt,
    summary: entry.summary,
    ...(entry.topics && entry.topics.length > 0 ? { topics: entry.topics } : {})
  }));
}
