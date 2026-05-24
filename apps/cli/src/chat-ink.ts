/**
 * Ink-based chat surface for a bare `muse` — a claude-style bordered
 * input box with a streaming transcript above it. Reuses the same
 * local runtime assembly as the readline REPL (`chat-repl.ts`); the
 * readline surface stays available as `muse repl` / `muse chat -i`.
 *
 * Render-free editing/slash/message logic lives in `chat-ink-core.ts`
 * so it stays unit-testable without an Ink harness.
 */

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import { Box, Static, Text, render, useApp, useInput } from "ink";
import React, { useCallback, useRef, useState } from "react";

import { appendLastChatTurn, readLastChatHistory } from "./chat-history.js";
import {
  buildTurnMessages,
  editInputBuffer,
  parseSlashCommand,
  type ChatTurnMessage,
  type InkKeyEvent
} from "./chat-ink-core.js";
import { buildMusePersona, formatCurrentContextLine } from "./muse-persona.js";
import { resolvePersona } from "./program-helpers.js";
import { resolveDefaultUserKey } from "./user-id.js";

const h = React.createElement;

export interface RunChatInkOptions {
  readonly model?: string;
  readonly continueHistory?: boolean;
  readonly userId?: string;
  readonly persona?: string;
}

interface DisplayTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
}

const HELP = [
  "commands: /help  /clear (wipe screen)  /exit (or ctrl-c)",
  "just type to chat — Muse remembers across turns."
].join("\n");

export function MuseChatApp(props: {
  readonly history: readonly ChatTurnMessage[];
  readonly model: string;
  readonly userId: string;
  readonly personaPrompt: () => string | undefined;
  readonly stream: (messages: readonly ChatTurnMessage[]) => AsyncIterable<{ type: string; text?: string; error?: unknown }>;
  readonly onCommit: (user: string, assistant: string) => void;
}): React.ReactElement {
  const app = useApp();
  // The visible transcript starts empty — like `claude`, opening a
  // session shows a clean screen, NOT a replay of prior turns. Prior
  // context still reaches the model via historyRef so Muse remembers.
  const [turns, setTurns] = useState<readonly DisplayTurn[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  const historyRef = useRef<ChatTurnMessage[]>([...props.history]);

  const submit = useCallback(async (raw: string) => {
    const message = raw.trim();
    if (message.length === 0) return;

    const slash = parseSlashCommand(message);
    if (slash) {
      if (slash.cmd === "exit" || slash.cmd === "quit") { app.exit(); return; }
      if (slash.cmd === "clear") { setTurns([]); setNotice(undefined); return; }
      if (slash.cmd === "help") { setNotice(HELP); return; }
      setNotice(`unknown command: /${slash.cmd}`);
      return;
    }

    setNotice(undefined);
    setTurns((prev) => [...prev, { role: "user", text: message }]);
    setBusy(true);
    setStreaming("");
    const messages = buildTurnMessages(props.personaPrompt() ?? formatCurrentContextLine(), historyRef.current, message);
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

  useInput((rawInput: string, key: InkKeyEvent) => {
    if (key.ctrl && rawInput === "c") { app.exit(); return; }
    if (key.escape) { app.exit(); return; }
    if (key.return) { const line = input; setInput(""); void submit(line); return; }
    setInput((buf) => editInputBuffer(buf, rawInput, key));
  });

  const placeholder = "무엇이든 물어보세요 — 예: 오늘 일정 정리해줘";
  const idle = turns.length === 0 && !busy && streaming.length === 0;
  return h(Box, { flexDirection: "column" },
    h(Static, {
      children: (item: unknown, index: number) => {
        const turn = item as DisplayTurn;
        return h(Box, { flexDirection: "column", key: index, marginBottom: 1 },
          h(Text, { bold: true, color: turn.role === "user" ? "green" : "cyan" }, turn.role === "user" ? "you" : "muse"),
          h(Text, null, turn.text));
      },
      items: [...turns]
    }),
    idle
      ? h(Box, { marginBottom: 1 }, h(Text, { dimColor: true }, "새 대화를 시작하세요 — 이전 맥락은 기억하고 있어요."))
      : null,
    busy || streaming.length > 0
      ? h(Box, { flexDirection: "column", marginBottom: 1 },
          h(Text, { bold: true, color: "cyan" }, "muse"),
          h(Text, null, streaming.length > 0 ? streaming : "…"))
      : null,
    notice ? h(Box, { marginBottom: 1 }, h(Text, { dimColor: true }, notice)) : null,
    h(Box, { borderColor: busy ? "gray" : "cyan", borderStyle: "round", paddingX: 1 },
      h(Text, null, "› "),
      h(Text, null, input),
      h(Text, { color: "cyan" }, "▌"),
      input.length === 0 ? h(Text, { dimColor: true }, ` ${placeholder}`) : null),
    h(Text, { dimColor: true }, "⏎ 전송 · /help · ctrl-c 종료")
  );
}

/**
 * Build the local runtime and drive the Ink chat to completion. Mirrors
 * `runChatRepl`'s setup (model env hints, persona/memory, seed history,
 * tools-off streaming) but renders through Ink instead of readline.
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

  // Load prior turns for MODEL memory only — they are not shown on
  // screen (the transcript opens clean). Cap to the most recent turns
  // so a long history never bloats the prompt.
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

  const instance = render(h(MuseChatApp, { history, model, onCommit, personaPrompt, stream, userId }));
  await instance.waitUntilExit();
}
