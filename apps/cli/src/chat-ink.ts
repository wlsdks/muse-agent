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

import { Box, Static, Text, useApp, useCursor, useInput, useStdout } from "ink";
import React, { useCallback, useEffect, useRef, useState } from "react";

import { FRAMES, toAnsi } from "@muse/mascot";
import { trimConversationMessages, type ConversationTrimOptions, type DroppedContextSummarizer } from "@muse/memory";

import {
  BIRD_FRAME_MS,
  birdAnimationEnabled,
  birdColorEnabled,
  birdIdleFrame,
  buildTurnMessages,
  chatHelp,
  cursorCoords,
  emptyInput,
  formatContextUsage,
  homeInputCursorY,
  providerIdFromModel,
  resolveHudLocality,
  resolveHudSegments,
  turnSeparator,
  type DisplayTurnRole,
  type HudSegmentId,
  extractAttachmentPaths,
  imageMimeForPath,
  formatCompactPreview,
  formatJobsList,
  formatMemoryView,
  formatTrust,
  formatUndoNotice,
  friendlyError,
  matchAgentNames,
  matchModelNames,
  matchSlashCommands,
  normalizeChatInput,
  parseRememberArg,
  parseSlashCommand,
  parseUndoArg,
  reduceInput,
  resolveForgetKey,
  runFocusedCompaction,
  undoExchanges,
  type ChatTurnMessage,
  type InkKeyEvent,
  type InputState,
  type JobListItem,
  type MemorySnapshot,
  type RecurringThread
} from "./chat-ink-core.js";
import { isQuiet } from "./cli-context.js";
import { parseAnswerMarkdown, type MdBlock, type MdListItem, type MdSpan } from "./chat-markdown.js";
import { type AgentDef } from "./commands-agents.js";
import { type ChatGrounding } from "./chat-grounding.js";
import { groupProactiveNotice, imminentItems, pickUnseen, type ProactiveItem } from "./chat-proactive.js";
import { formatCurrentContextLine } from "./muse-persona.js";

export { runChatInk } from "./chat-ink-run.js";

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
  { cmd: "orchestrate", desc: "fan out to background sub-agents — /orchestrate <prompt>" },
  { cmd: "memory", desc: "show what Muse remembers about you" },
  { cmd: "remember", desc: "teach a fact — /remember <key>=<value>" },
  { cmd: "pref", desc: "set a preference — /pref <key>=<value>" },
  { cmd: "recall", desc: "search past notes + episodes — /recall <query>" },
  { cmd: "reflect", desc: "reflect on patterns across your past sessions" },
  { cmd: "forget", desc: "forget one thing — /forget <key> (or --all)" },
  { cmd: "trust", desc: "show this user's trusted + blocked tools" },
  { cmd: "persona", desc: "show the active persona slot" },
  { cmd: "history", desc: "how many turns are in context" },
  { cmd: "compact", desc: "preview compaction (no arg), or /compact <topic> to compact now, focused on that topic" },
  { cmd: "undo", desc: "roll back the last exchange — /undo <N> to roll back N (1-20)" },
  { cmd: "save", desc: "save the last reply to a note file" },
  { cmd: "copy", desc: "copy the last reply to the clipboard" },
  { cmd: "cost", desc: "show this session's token usage" },
  { cmd: "exit", desc: "quit Muse (ctrl-c)" }
];

// Third-party-outbound actuators: in chat these reach the fail-closed
// approval gate, which flags them louder ("Outbound action") and never sends
// without the user's explicit y — outbound-safety: never an autonomous send.
export const OUTBOUND_ACTUATORS: readonly string[] = [
  "email_send", "web_action", "home_action", "smart_home", "muse.messaging.send", "objective.act"
];

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toString();
}

// Left-bar frame shared by code blocks and blockquotes: a dim `│` gutter
// (round border, left edge only) with the content indented one column. Ink
// draws the border char regardless of colour, so the frame survives NO_COLOR;
// only the tint drops. This is the deterministic structure the wall-of-text
// answer was missing.
const LEFT_BAR = { borderBottom: false, borderColor: "gray", borderLeft: true, borderRight: false, borderStyle: "round", borderTop: false, flexDirection: "column", paddingLeft: 1 } as const;

/** Render one line's inline spans (bold / italic / inline-code / link) as
 *  nested `<Text>`; a link renders as `text` + a dim ` (url)`. */
function renderSpans(spans: readonly MdSpan[], keyPrefix: string): React.ReactElement[] {
  return spans.map((s, si) => {
    const key = `${keyPrefix}-${si.toString()}`;
    if (s.url !== undefined) {
      return h(React.Fragment, { key },
        h(Text, { color: "cyan", underline: true }, s.text),
        h(Text, { dimColor: true }, ` (${s.url})`));
    }
    return h(Text, { bold: s.bold === true, color: s.code === true ? "yellow" : undefined, italic: s.italic === true, key }, s.text);
  });
}

function renderListItem(item: MdListItem, key: string): React.ReactElement {
  // A fixed-width marker gutter + a flexible content box gives a hanging
  // indent: wrapped continuation lines align under the text, not the bullet.
  const gutter = "  ".repeat(item.level);
  return h(Box, { key },
    h(Text, { color: "cyan" }, `${gutter}${item.marker} `),
    h(Box, { flexDirection: "column", flexGrow: 1 }, h(Text, null, ...renderSpans(item.spans, `${key}-s`))));
}

/** Render a block from the pure parser. `spaced` inserts a blank line above
 *  every block after the first so the answer breathes instead of walling up. */
function renderBlock(block: MdBlock, key: string, spaced: boolean): React.ReactElement {
  const top = spaced ? { marginTop: 1 } : null;
  if (block.kind === "code") {
    return h(Box, { ...LEFT_BAR, ...top, key },
      block.lang !== undefined && block.lang.length > 0 ? h(Text, { dimColor: true, key: "lang" }, block.lang) : null,
      ...block.lines.map((ln, li) => h(Text, { color: "green", key: li.toString() }, ln.length > 0 ? ln : " ")));
  }
  if (block.kind === "heading") {
    return h(Box, { ...top, key },
      h(Text, { bold: true, color: block.level <= 2 ? "cyan" : "blue" }, ...renderSpans(block.spans, `${key}-h`)));
  }
  if (block.kind === "list") {
    return h(Box, { ...top, flexDirection: "column", key }, ...block.items.map((it, li) => renderListItem(it, `${key}-${li.toString()}`)));
  }
  if (block.kind === "quote") {
    return h(Box, { ...LEFT_BAR, ...top, key },
      ...block.lines.map((ln, li) => h(Text, { dimColor: true, key: li.toString() }, ...renderSpans(ln, `${key}-${li.toString()}`))));
  }
  return h(Box, { ...top, flexDirection: "column", key },
    ...block.lines.map((ln, li) => h(Text, { key: li.toString() }, ...renderSpans(ln, `${key}-${li.toString()}`))));
}

/** Render a completed assistant message with structured markdown: fenced code
 *  in a framed block, headings, bulleted/ordered/nested lists, blockquotes,
 *  inline code/bold/italic/links, and a blank line between block elements. */
function renderMarkdown(text: string): React.ReactElement {
  const blocks = parseAnswerMarkdown(text);
  return h(Box, { flexDirection: "column" },
    ...blocks.map((block, bi) => renderBlock(block, `b${bi.toString()}`, bi > 0)));
}

// Box geometry: left border (1) + paddingX (1) + the "› " prompt (2).
// The input text — and therefore the cursor — starts at this column.
const INPUT_COL_OFFSET = 4;

// Proactive ("speaks-first") cadence: how far ahead to look, and how often
// to poll while the chat is idle.
export const PROACTIVE_LEAD_MS = 60 * 60_000;
const PROACTIVE_POLL_MS = 45_000;

// Fallback trim budget for `/compact` when the caller doesn't wire a
// `contextWindow` prop (e.g. an older test harness) — mirrors
// `buildContextWindowOptions`'s own defaults so the preview still means
// something rather than silently no-op-ing.
const DEFAULT_CONTEXT_WINDOW: ConversationTrimOptions = { maxContextWindowTokens: 128_000, outputReserveTokens: 4_096 };

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
  /** Whether the local-only posture is ON (cloud egress refused) — shown in the HUD. */
  readonly localOnly: boolean;
  /** The ACTIVE model's provider id (e.g. `ollama`), for the truthful HUD
   *  locality badge. Omit ⇒ derived from the `model` string's `provider/…`
   *  prefix. */
  readonly modelProviderId?: string;
  /** The provider's effective base URL, so a remote local-inference host reads
   *  as cloud egress. Omit ⇒ the provider's own default (loopback). */
  readonly modelBaseUrl?: string;
  /** Whether a cloud-LLM credential is present — drives the HUD's "egress
   *  possible" caution when local-only is off. Defaults to false. */
  readonly cloudKeyPresent?: boolean;
  readonly skills: readonly SkillInfo[];
  readonly skillsDir: string;
  readonly skillsPromptFor: (prompt: string) => string;
  readonly groundingFor?: (prompt: string, history: readonly ChatTurnMessage[]) => Promise<ChatGrounding>;
  /**
   * The shared post-stream pipeline (gate -> citation strips -> receipt). The
   * audit found this surface rendered the raw stream ungated while every other
   * chat path was gated — wired as a prop so ink stays runtime-agnostic.
   */
  readonly finalizeAnswer?: (args: {
    readonly question: string;
    readonly answer: string;
    readonly matches: ChatGrounding["matches"];
    readonly history: readonly { readonly role: string; readonly content: string }[];
    readonly toolsUsed: readonly string[];
    readonly toolGroundingSources?: readonly { readonly source: string; readonly text: string }[];
  }) => Promise<{ readonly display: string; readonly forHistory: string; readonly untrustedOnly: boolean }>;
  readonly historyWindow?: number;
  /** The live runtime's trim budget (`buildContextWindowOptions(process.env)`), so
   *  `/compact` previews against the SAME config the real compaction would use. */
  readonly contextWindow?: ConversationTrimOptions;
  /** Aux-model summarizer for `/compact <topic>` — a focused, real (non-preview)
   *  compaction of the in-session history. Absent ⇒ `/compact <topic>` still
   *  compacts (the deterministic `[Key details]` summary is unconditional) but
   *  skips the topic-focused LLM recap. */
  readonly contextSummarizer?: DroppedContextSummarizer;
  readonly personaPrompt: () => string | undefined;
  /**
   * Privacy-tiered routing seam (`chat-ink-run.ts` wires it to
   * `createChatCloudTurn`): resolve THIS turn's route and run the cloud leg
   * when eligible. Returns undefined to stay local — routing off, a personal
   * signal, or a cloud failure all fall back the same way, silently.
   */
  readonly cloudTurn?: (message: string, personaBlock: string, groundingBlock: string) => Promise<{ readonly text: string; readonly marker: string } | undefined>;
  readonly stream: (messages: readonly ChatTurnMessage[], model: string) => AsyncIterable<{ type: string; text?: string; error?: unknown; name?: string; grounding?: { source: string; text: string }; response?: { usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } } }>;
  readonly streamWithTools: (messages: readonly ChatTurnMessage[], model: string, requestApproval: (toolName: string, detail: string, kind: "outbound" | "tool") => Promise<boolean>) => AsyncIterable<{ type: string; text?: string; error?: unknown; name?: string; grounding?: { source: string; text: string }; response?: { usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } } }>;
  readonly readFile: (relativePath: string) => Promise<string | undefined>;
  readonly readImage?: (relativePath: string) => Promise<{ readonly mimeType: string; readonly dataBase64: string } | undefined>;
  readonly saveText: (text: string) => Promise<string | undefined>;
  readonly copyToClipboard: (text: string) => Promise<boolean>;
  readonly onCommit: (user: string, assistant: string, untrusted?: boolean) => void;
  readonly autoLearn?: (user: string, assistant: string) => Promise<string | undefined>;
  readonly onReset: () => void;
  /** Called when an answer rested on untrusted-only sources — runChatInk uses it to
   *  mark the end-of-session episode trusted:false (episode-laundering defense). */
  readonly onUntrustedAnswer?: () => void;
  readonly proactiveCheck?: () => Promise<readonly ProactiveItem[]>;
  readonly jobCompletions?: () => Promise<readonly ProactiveItem[]>;
  /** Consolidated results of `/orchestrate` background fan-outs that finished
   *  since this chat opened — surfaced through the SAME poll/dedup path as
   *  `jobCompletions`, one entry per orchestration (never per sub-agent). */
  readonly orchestrationCompletions?: () => Promise<readonly ProactiveItem[]>;
  /** Non-windowed nudges (due check-ins + fireable pattern suggestions), each surfaced once verbatim. */
  readonly proactiveNudges?: () => Promise<readonly ProactiveItem[]>;
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
  /** Dispatches a background sub-agent fan-out and returns immediately —
   *  never awaits a worker (hermes-parity: a slow local 12B never blocks
   *  the calling turn). */
  readonly startOrchestration?: (prompt: string) => { readonly orchestrationId: string; readonly subtaskCount: number };
  readonly recap: string;
}): React.ReactElement {
  const app = useApp();
  const { setCursorPosition } = useCursor();
  const { stdout } = useStdout();
  // Full-screen layout needs the live terminal height; re-render on resize so
  // the canvas/HUD reflow (Ink doesn't force a re-render on SIGWINCH by itself).
  const [, bumpResize] = useState(0);
  useEffect(() => {
    if (!stdout || typeof stdout.on !== "function") return undefined;
    const onResize = (): void => bumpResize((n) => n + 1);
    stdout.on("resize", onResize);
    return () => { stdout.off?.("resize", onResize); };
  }, [stdout]);
  const [turns, setTurns] = useState<readonly DisplayTurn[]>(
    props.recap ? [{ role: props.recapRole ?? "system", text: props.recap }] : []
  );
  const [birdTick, setBirdTick] = useState(0);
  // Animate the home-screen bird: a gentle idle loop that lives in the LIVE
  // render tree (not the one-shot <Static> banner), so Ink re-renders it on a
  // frame timer. Only runs on the empty HOME screen and when animation is
  // allowed (color TTY, no MUSE_NO_ANIM); cleared on unmount / first turn.
  useEffect(() => {
    const isTty = stdout?.isTTY === true;
    if (turns.length !== 0 || !birdAnimationEnabled(process.env, isTty)) return undefined;
    const timer = setInterval(() => setBirdTick((t) => t + 1), BIRD_FRAME_MS);
    return () => clearInterval(timer);
  }, [stdout, turns.length]);
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
  // The most recent turn's INPUT tokens — the live context-window fill, shown
  // as `ctx NN%` in the HUD (distinct from the cumulative session token count).
  const [lastContextTokens, setLastContextTokens] = useState(0);
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
    if (!busy || isQuiet()) return undefined;
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
    const orchestrationsDone = props.orchestrationCompletions;
    const nudge = props.proactiveNudges;
    if (!check && !jobsDone && !orchestrationsDone && !nudge) return undefined;
    let active = true;
    const tick = async (): Promise<void> => {
      if (!idleRef.current) return;
      const now = Date.now();
      const items = check ? await check().catch(() => [] as readonly ProactiveItem[]) : [];
      // Background jobs + `/orchestrate` fan-outs that finished since the chat
      // opened are surfaced once each (their own pre-phrased line — ONE entry
      // per orchestration, never one per sub-agent), not via the reminder
      // time-window.
      const completedJobs = jobsDone ? await jobsDone().catch(() => [] as readonly ProactiveItem[]) : [];
      const completedOrchestrations = orchestrationsDone
        ? await orchestrationsDone().catch(() => [] as readonly ProactiveItem[])
        : [];
      const completed = [...completedJobs, ...completedOrchestrations];
      // Due check-ins + fireable pattern suggestions — already-phrased nudges
      // the daemon would push to the channel; surface them in-chat once each,
      // verbatim (not the imminent time-window — a check-in due hours ago and an
      // undated pattern still belong here).
      const nudges = nudge ? await nudge().catch(() => [] as readonly ProactiveItem[]) : [];
      if (!active) return;
      const unseen = pickUnseen(imminentItems(items, now, PROACTIVE_LEAD_MS), seenRef.current);
      const unseenJobs = pickUnseen(completed, seenRef.current);
      const unseenNudges = pickUnseen(nudges, seenRef.current);
      if (unseen.length === 0 && unseenJobs.length === 0 && unseenNudges.length === 0) return;
      for (const item of [...unseen, ...unseenJobs, ...unseenNudges]) seenRef.current.add(item.id);
      const grouped = groupProactiveNotice(unseen, now);
      setTurns((prev) => [
        ...prev,
        ...(grouped ? [{ role: "proactive" as const, text: grouped }] : []),
        ...unseenJobs.map((item) => ({ role: "proactive" as const, text: item.text })),
        ...unseenNudges.map((item) => ({ role: "proactive" as const, text: item.text }))
      ]);
    };
    const first = setTimeout(() => { void tick(); }, 1500);
    const timer = setInterval(() => { void tick(); }, PROACTIVE_POLL_MS);
    return () => { active = false; clearTimeout(first); clearInterval(timer); };
  }, [props]);

  const submit = useCallback(async (raw: string) => {
    const message = normalizeChatInput(raw);
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
      if (slash.cmd === "compact") {
        const trimOptions: ConversationTrimOptions = {
          ...(props.contextWindow ?? DEFAULT_CONTEXT_WINDOW),
          systemPrompt: props.personaPrompt() ?? formatCurrentContextLine()
        };
        const topic = slash.arg.trim();
        if (topic.length === 0) {
          // Dry run only — reads historyRef.current, never writes it. Approximates
          // the system prompt with the persona/base line; the per-turn additions
          // (active-agent prefix, retrieval grounding block, matched skills) depend
          // on the NEXT message and can't be known ahead of a real turn, so this
          // slightly UNDER-counts the system-prompt token cost. The trim DECISION
          // itself is the exact function + budget config the live runtime uses.
          const result = trimConversationMessages(historyRef.current, trimOptions);
          note(formatCompactPreview(historyRef.current.length, result));
          return;
        }
        // `/compact <topic>` — a REAL, focused compaction now (not a preview):
        // force-compacts everything before the latest exchange, asks for a
        // topic-focused recap, and gates it before writing historyRef.current.
        progress(`Compacting, focused on "${topic}"…`);
        const { messages, note: outcome } = await runFocusedCompaction(topic, historyRef.current, trimOptions, props.contextSummarizer);
        historyRef.current = [...messages];
        note(outcome);
        setCommandNotice(undefined);
        return;
      }
      if (slash.cmd === "undo") {
        const parsed = parseUndoArg(slash.arg);
        if (parsed.kind === "invalid") {
          note(`"${parsed.raw}" isn't a valid turn count — /undo <N> takes a whole number from 1 to 20 (e.g. /undo 2).`);
          return;
        }
        const result = undoExchanges(historyRef.current, parsed.count);
        historyRef.current = [...result.history];
        note(formatUndoNotice(result));
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
      if (slash.cmd === "orchestrate") {
        const prompt = slash.arg.trim();
        if (prompt.length === 0) { note("What should the sub-agents work on? — /orchestrate <prompt>"); return; }
        if (!props.startOrchestration) { note("Orchestration isn't available in this session."); return; }
        const { subtaskCount } = props.startOrchestration(prompt);
        note(`${subtaskCount.toString()} subtasks dispatched in the background — I'll surface the merged result when the last one finishes.`);
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
    const imageAttachments: { readonly mimeType: string; readonly dataBase64: string }[] = [];
    for (const rel of attachmentPaths) {
      // An image `@photo.png` goes to gemma4 vision (inline attachment); any other
      // file is read as text and prepended as before.
      if (imageMimeForPath(rel) !== undefined && props.readImage) {
        const img = await props.readImage(rel);
        if (img) imageAttachments.push(img);
        continue;
      }
      try {
        const body = await props.readFile(rel);
        if (body !== undefined) attachmentBlock += `\n\n[Attached file: ${rel}]\n${body}`;
      } catch { /* skip unreadable attachment */ }
    }
    if (attachmentPaths.length > 0) {
      setCommandNotice(`Attached: ${attachmentPaths.join(", ")}`);
    }

    const personaBase = props.personaPrompt();
    const agentPrefix = activeAgent ? `${activeAgent.prompt}\n\n` : "";
    const grounding: ChatGrounding = props.groundingFor
      ? await props.groundingFor(message, historyRef.current).catch(() => ({ block: "", matches: [] }))
      : { block: "", matches: [] };

    // Privacy-tiered routing: an attachment splices file contents / a photo
    // into the turn, so it must stay local regardless of the routing decision
    // — the cloud request has no attachment channel to carry them safely.
    const cloudTurn = props.cloudTurn;
    const cloudEligible = cloudTurn !== undefined && attachmentPaths.length === 0 && imageAttachments.length === 0;
    let cloudResult: { readonly text: string; readonly marker: string } | undefined;
    if (cloudEligible) {
      setStreaming("☁️ …"); // the await below can take a couple seconds; a blank box reads as hung
      cloudResult = await cloudTurn(message, personaBase ?? "", grounding.block).catch(() => undefined);
    }

    let accumulated = "";
    let turnTokens = 0;
    let lastInputTokens = 0;
    const toolsRan: string[] = [];
    const toolGrounding: { source: string; text: string }[] = [];
    if (cloudResult) {
      accumulated = cloudResult.text;
    } else {
      const base = personaBase ?? formatCurrentContextLine();
      const system = agentPrefix + base + grounding.block + props.skillsPromptFor(message);
      const messages = buildTurnMessages(system, historyRef.current, message + attachmentBlock, props.historyWindow, imageAttachments);
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
          if (event.type === "tool-call-started" && typeof event.name === "string") {
            toolsRan.push(event.name);
            if (accumulated.length === 0) setStreaming(`🔧 using ${event.name}…`);
          }
          if (event.type === "tool-result" && event.grounding) {
            toolGrounding.push(event.grounding);
          }
          if (event.type === "text-delta" && typeof event.text === "string") {
            accumulated += event.text;
            setStreaming(accumulated);
          }
          if (event.type === "done") {
            const u = event.response?.usage;
            turnTokens = (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0) + (u?.reasoningTokens ?? 0);
            lastInputTokens = u?.inputTokens ?? 0;
          }
        }
      } catch (error) {
        accumulated = `⚠ ${friendlyError(error instanceof Error ? error.message : String(error))}`;
      }
    }
    if (turnTokens > 0) setSessionTokens((t) => t + turnTokens);
    if (lastInputTokens > 0) setLastContextTokens(lastInputTokens);
    // The same deterministic gate every other chat surface runs — post-hoc on
    // the streamed bubble (ask warns post-hoc too); fail-open keeps the raw
    // answer only if the finalizer itself crashes, never on a gate verdict.
    // `accumulated` is what the user SEES (display, incl. source-check cues);
    // `persisted` is what gets stored to history / episodes / auto-memory — the
    // answer WITHOUT those cues, so conversationMatches can't replay a display-only
    // warning as trusted grounding evidence next turn (grounded≠true self-pollution).
    let persisted = accumulated;
    // Per-turn untrusted-source verdict — persisted with the turn (onCommit) so a
    // RESUMED session's episode capture sees it even though it ran in a prior
    // process (episode-laundering defense, EP-1b / MemoryGraft).
    let turnUntrusted = false;
    if (props.finalizeAnswer && !interruptRef.current && !accumulated.startsWith("⚠")) {
      const finalized = await props.finalizeAnswer({
        answer: accumulated,
        history: historyRef.current,
        matches: grounding.matches,
        question: message,
        toolsUsed: toolsRan,
        toolGroundingSources: toolGrounding
      }).catch(() => undefined);
      if (finalized) {
        if (finalized.display !== accumulated) {
          accumulated = finalized.display;
          setStreaming(accumulated);
        }
        persisted = finalized.forHistory;
        turnUntrusted = finalized.untrustedOnly;
        // Bridge the session's source-trust verdict out to runChatInk (the
        // end-of-session episode capture runs after this component unmounts): once
        // ANY answer rested on untrusted-only sources, the stored episode is marked
        // trusted:false so it can't later launder that content as trusted "your own
        // history" grounding (MemoryGraft arXiv:2512.16962).
        if (finalized.untrustedOnly) {
          props.onUntrustedAnswer?.();
        }
      }
    }
    // "Shows its work" for a cloud-routed turn — display-only, appended AFTER
    // the gate ran on the bare answer and never folded into `persisted`, so a
    // resumed session's history/grounding never replays the marker as content.
    if (cloudResult) {
      accumulated += cloudResult.marker;
      setStreaming(accumulated);
    }
    historyRef.current.push({ content: message, role: "user" });
    historyRef.current.push({ content: persisted, role: "assistant" });
    setTurns((prev) => [...prev, { role: "assistant", text: accumulated }]);
    setStreaming("");
    setBusy(false);
    if (!accumulated.startsWith("⚠") && accumulated !== "(interrupted)") lastAnswerRef.current = accumulated;
    props.onCommit(message, persisted, turnUntrusted);
    // Background auto-memory: surface anything Muse learned so the user sees it.
    void props.autoLearn?.(message, persisted)
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

  // Layout: HOME (no turns yet) fills the terminal — banner at top, a flexGrow
  // canvas, then the input box pinned near the bottom with the HUD at the very
  // bottom (the Claude-Code feel). Once a turn exists the past turns scroll into
  // <Static> scrollback and the live region is a compact stack (streaming →
  // approval → input → menu → hint → HUD) sitting just under the transcript, so
  // the input stays at the bottom of the live area while answers scroll up.
  const rows = stdout?.rows ?? 24;
  const isHome = turns.length === 0;
  const placeholder = "Ask me anything";
  const lines = inputState.value.length > 0 ? inputState.value.split("\n") : [""];
  const menuRows = slashMenu.length > 0
    ? slashMenu.length
    : agentMenu.length > 0
      ? agentMenu.length
      : modelMenu.length > 0
        ? Math.min(modelMenu.length, 8)
        : 0;

  // Place the REAL terminal cursor at the input column INSIDE the box so a CJK
  // IME composes there (same technique as the official Ink cursor-ime example
  // and claude-code). Called in the render body — `useCursor` stores it in a ref
  // and applies it during commit via useInsertionEffect, so a post-commit
  // useEffect would lag a frame and reset the cursor. HOME anchors the cursor
  // from the BOTTOM of the full-height region (banner + canvas heights above are
  // decided by flex layout and can't be counted from the top); ACTIVE keeps the
  // input as the first live block, content row y=1. Busy: hide it.
  const caret = cursorCoords(inputState);
  const cursorY = isHome
    ? homeInputCursorY({ rows, inputLines: lines.length, caretLine: caret.line, menuRows, hasNotice: commandNotice !== undefined })
    : 1 + caret.line;
  setCursorPosition(busy || exiting ? undefined : { x: INPUT_COL_OFFSET + caret.col, y: cursorY });

  // Roles + width feed the pure per-exchange separator; plain (NO_COLOR /
  // non-TTY) swaps the box-rule for ASCII dashes and skips color.
  const transcriptRoles: readonly DisplayTurnRole[] = turns.map((t) => t.role);
  const transcriptPlain = !birdColorEnabled(process.env, stdout?.isTTY === true);
  const separatorWidth = (stdout?.columns ?? 80) - 2;
  const transcript = h(Static, {
    children: (item: unknown, index: number) => {
      if (index === 0) return h(Box, { key: "banner", marginBottom: 1 }, h(Text, null, props.banner));
      const turn = item as DisplayTurn;
      if (turn.role === "user") {
        // The user's message stays as a snapshot — the same `› ` prompt they
        // typed it into (codex / claude style), now a BOLD header so each Q→A
        // exchange reads as its own unit, with a dim rule + `#N` above it (item
        // index 0 is the banner, so the turn's position in `turns` is index-1).
        const sep = turnSeparator(transcriptRoles, index - 1, { plain: transcriptPlain, width: separatorWidth });
        return h(Box, { flexDirection: "column", key: index, marginBottom: 1, marginTop: 1 },
          sep.length > 0 ? h(Text, { dimColor: true }, sep) : null,
          h(Box, sep.length > 0 ? { marginTop: 1 } : null,
            h(Text, { bold: true, color: "cyan" }, "› "),
            h(Text, { bold: true, color: "cyan" }, turn.text)));
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
    // On the HOME screen the banner lives in the (full-height) live region;
    // it only moves into scrollback once real turns exist, so it never renders
    // twice.
    items: isHome ? [] : [props.banner, ...turns]
  });

  // Teardown frame: leave only the transcript so the input box and its
  // in-box cursor don't collide with the shell prompt after exit.
  if (exiting) {
    return h(Box, { flexDirection: "column" }, transcript);
  }

  const inputBox = h(Box, { borderColor: busy ? "gray" : "cyan", borderStyle: "round", flexDirection: "column", paddingX: 1 },
    ...lines.map((ln, i) => h(Box, { key: i },
      h(Text, { color: "cyan" }, i === 0 ? "› " : "  "),
      inputState.value.length === 0
        ? h(Text, { dimColor: true }, placeholder)
        : h(Text, null, ln))));

  // At most one picker is open at a time (slash → agent → model, mutually
  // exclusive upstream); its height is reflected in `menuRows` for the cursor.
  const menuElement = slashMenu.length > 0
    ? h(Box, { flexDirection: "column", marginTop: 1, paddingLeft: 2 },
        ...slashMenu.map((command, i) => {
          const on = i === menuSel;
          return h(Box, { key: command.cmd },
            h(Text, { color: on ? "cyan" : "gray" }, `${on ? "▸ " : "  "}/${command.cmd}`),
            h(Text, { dimColor: !on }, `  — ${command.desc}`));
        }),
        h(Text, { dimColor: true }, "  ↑↓ select · Tab complete · ⏎ run"))
    : agentMenu.length > 0
      ? h(Box, { flexDirection: "column", marginTop: 1, paddingLeft: 2 },
          ...agentMenu.map((name, i) => {
            const on = i === menuSel;
            const def = props.agents.find((a) => a.name === name);
            return h(Box, { key: name },
              h(Text, { color: on ? "yellow" : "gray" }, `${on ? "▸ " : "  "}${name}`),
              h(Text, { dimColor: !on }, def ? `  — ${def.description}` : ""));
          }),
          h(Text, { dimColor: true }, "  ↑↓ select · Tab complete · ⏎ switch"))
      : modelMenu.length > 0
        ? h(Box, { flexDirection: "column", marginTop: 1, paddingLeft: 2 },
            ...modelMenu.slice(0, 8).map((name, i) => {
              const on = i === menuSel;
              return h(Box, { key: name },
                h(Text, { color: on ? "cyan" : "gray" }, `${on ? "▸ " : "  "}${name}`),
                name === currentModel ? h(Text, { color: "green" }, "  ✓ current") : null);
            }),
            h(Text, { dimColor: true }, "  ↑↓ select · Tab complete · ⏎ switch"))
        : null;

  // Command feedback (from a slash command), transient — cleared on next input.
  const noticeElement = commandNotice
    ? h(Box, { marginTop: 1, paddingLeft: 2 }, h(Text, { color: "cyan" }, commandNotice))
    : null;

  const hintElement = h(Box, { marginTop: 1 },
    ctrlCArmed
      ? h(Text, { color: "yellow" }, "Press ctrl-c again to quit")
      : busy
        ? h(Text, { dimColor: true }, "esc to stop · ctrl-c×2 quit")
        : h(Text, { dimColor: true }, "⏎ send · shift+⏎ newline · @file · /help · ctrl-c×2 quit"));

  // HUD: single-line status bar at the very bottom. Which segments show, and in
  // what order, is resolved from the environment (`MUSE_HUD_SEGMENTS` comma list
  // or a `MUSE_HUD` preset); unset ⇒ the full default order below. The render is
  // a pure map from segment id → the existing colored <Text>, joined with the
  // ` · ` separator, so nothing about the DEFAULT appearance changes.
  // Truthful locality: the ACTIVE model's provider decides local vs cloud (a
  // local Ollama model reads 🔒 local even with local-only off — the old code
  // false-alarmed ⚠ cloud on that). ⚠ only when data can egress.
  const locality = resolveHudLocality({
    baseUrl: props.modelBaseUrl,
    cloudKeyPresent: props.cloudKeyPresent ?? false,
    localOnly: props.localOnly,
    providerId: props.modelProviderId ?? providerIdFromModel(currentModel)
  });
  const hudSegment = (id: HudSegmentId): { readonly label: string; readonly value: React.ReactNode | null } | null => {
    switch (id) {
      case "model": return { label: "", value: h(Text, { color: "cyan", key: "hud-v-model" }, currentModel) };
      case "locality": return { label: "", value: h(Text, { color: locality.tone, key: "hud-v-loc" }, locality.text) };
      case "proactive": return { label: "proactive ", value: h(Text, { color: props.proactiveOn ? "green" : "gray", key: "hud-v-pro" }, props.proactiveOn ? "on" : "off") };
      case "agent": return { label: "agent ", value: h(Text, { color: activeAgent ? "yellow" : "gray", key: "hud-v-agent" }, activeAgent ? activeAgent.name : "default") };
      case "tools": return { label: "tools ", value: h(Text, { color: toolsOn ? "green" : "gray", key: "hud-v-tools" }, toolsOn ? "on" : "off") };
      case "skills": return { label: `skills ${props.skills.length.toString()}`, value: null };
      case "ctx": {
        const usage = formatContextUsage(lastContextTokens, props.contextWindow?.maxContextWindowTokens);
        return usage ? { label: usage, value: null } : null;
      }
      case "tokens": return sessionTokens > 0 ? { label: `${formatTokens(sessionTokens)} tok`, value: null } : null;
    }
  };
  const hudChildren: React.ReactNode[] = [h(Text, { color: "magenta", key: "hud-note" }, "♪ ")];
  let hudEmitted = 0;
  for (const id of resolveHudSegments(process.env)) {
    const seg = hudSegment(id);
    if (!seg) continue;
    const prefix = (hudEmitted === 0 ? "" : "  ·  ") + seg.label;
    if (prefix.length > 0) hudChildren.push(h(Text, { dimColor: true, key: `hud-l-${id}` }, prefix));
    if (seg.value !== null) hudChildren.push(seg.value);
    hudEmitted += 1;
  }
  const hudElement = h(Box, null, ...hudChildren);

  // HOME: full-height canvas with the input pinned near the bottom. The banner
  // and the flexGrow spacer sit above the input; nothing sits between the spacer
  // and the input, so `homeInputCursorY` counts only the fixed bottom stack.
  if (isHome) {
    // The animated bird lives INSIDE the flexGrow canvas (centered), above the
    // fixed bottom stack — so it never shifts the input row, and homeInputCursorY
    // (which counts only the bottom stack) stays exact. Static frame under
    // reduced-motion; nothing at all when color is off (NO_COLOR / non-TTY),
    // where the banner already falls back to a plain wordmark.
    const isTty = stdout?.isTTY === true;
    const birdArt = birdColorEnabled(process.env, isTty)
      ? toAnsi(FRAMES[birdIdleFrame(birdTick, birdAnimationEnabled(process.env, isTty))])
      : "";
    return h(Box, { flexDirection: "column", height: Math.max(1, rows - 1) },
      transcript,
      h(Box, { marginBottom: 1 }, h(Text, null, props.banner)),
      h(Box, { alignItems: "center", flexDirection: "column", flexGrow: 1, justifyContent: "center" },
        birdArt.length > 0 ? h(Text, null, birdArt) : null),
      inputBox,
      menuElement,
      noticeElement,
      hintElement,
      hudElement);
  }

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
    inputBox,
    menuElement,
    noticeElement,
    hintElement,
    hudElement);
}
