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
import { Box, Static, Text, render, useApp, useCursor, useInput } from "ink";
import React, { useCallback, useRef, useState } from "react";

import { appendLastChatTurn, readLastChatHistory } from "./chat-history.js";
import {
  buildTurnMessages,
  displayWidth,
  editInputBuffer,
  parseSlashCommand,
  type ChatTurnMessage,
  type InkKeyEvent
} from "./chat-ink-core.js";
import { buildMusePersona, formatCurrentContextLine } from "./muse-persona.js";
import { resolvePersona } from "./program-helpers.js";
import { resolveDefaultUserKey } from "./user-id.js";

const h = React.createElement;

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

export function MuseChatApp(props: {
  readonly banner: string;
  readonly history: readonly ChatTurnMessage[];
  readonly personaPrompt: () => string | undefined;
  readonly stream: (messages: readonly ChatTurnMessage[]) => AsyncIterable<{ type: string; text?: string; error?: unknown }>;
  readonly onCommit: (user: string, assistant: string) => void;
}): React.ReactElement {
  const app = useApp();
  const { setCursorPosition } = useCursor();
  const [turns, setTurns] = useState<readonly DisplayTurn[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const historyRef = useRef<ChatTurnMessage[]>([...props.history]);

  const submit = useCallback(async (raw: string) => {
    const message = raw.trim();
    if (message.length === 0) return;

    const slash = parseSlashCommand(message);
    if (slash) {
      if (slash.cmd === "exit" || slash.cmd === "quit") { app.exit(); return; }
      if (slash.cmd === "clear") { setTurns([]); return; }
      if (slash.cmd === "help") {
        setTurns((prev) => [...prev, { role: "system", text: "commands: /help · /clear · /exit (ctrl-c). 그냥 입력하면 대화합니다." }]);
        return;
      }
      setTurns((prev) => [...prev, { role: "system", text: `unknown command: /${slash.cmd}` }]);
      return;
    }

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
    if (busy) return;
    if (key.ctrl && rawInput === "c") { app.exit(); return; }
    if (key.escape) { app.exit(); return; }
    if (key.return) { const line = input; setInput(""); void submit(line); return; }
    setInput((buf) => editInputBuffer(buf, rawInput, key));
  });

  // Place the REAL terminal cursor at the input column INSIDE the box so a
  // CJK IME composes there (same technique as the official Ink cursor-ime
  // example and claude-code). Called in the render body — `useCursor` stores
  // it in a ref and applies it during commit via useInsertionEffect, so a
  // post-commit useEffect would lag a frame and reset the cursor. Idle: the
  // box is the first dynamic block, input row at y=1. Busy: hide it.
  setCursorPosition(busy ? undefined : { x: INPUT_COL_OFFSET + displayWidth(input), y: 1 });

  const placeholder = "무엇이든 물어보세요";
  return h(Box, { flexDirection: "column" },
    h(Static, {
      children: (item: unknown, index: number) => {
        if (index === 0) return h(Text, { key: "banner" }, props.banner);
        const turn = item as DisplayTurn;
        const label = turn.role === "user" ? "you" : turn.role === "assistant" ? "muse" : "·";
        const color = turn.role === "user" ? "green" : turn.role === "assistant" ? "cyan" : "gray";
        return h(Box, { flexDirection: "column", key: index, marginBottom: 1 },
          h(Text, { bold: turn.role !== "system", color }, label),
          h(Text, { dimColor: turn.role === "system" }, turn.text));
      },
      items: [props.banner, ...turns]
    }),
    // While replying, show the streaming answer ABOVE the box.
    busy
      ? h(Box, { flexDirection: "column", marginBottom: 1 },
          h(Text, { bold: true, color: "cyan" }, "muse"),
          h(Text, null, streaming.length > 0 ? streaming : "…"))
      : null,
    // The input BOX. When idle it is the first dynamic block, so its
    // content row is y=1 — where useCursor placed the real cursor.
    h(Box, { borderColor: busy ? "gray" : "cyan", borderStyle: "round", paddingX: 1 },
      h(Text, { color: "cyan" }, "› "),
      input.length > 0 ? h(Text, null, input) : h(Text, { dimColor: true }, placeholder)),
    h(Text, { dimColor: true }, "⏎ 전송 · /help · ctrl-c 종료")
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

  const banner = `♪ ♫ ♬  Muse · ${model}\n새 대화를 시작하세요 — 이전 맥락은 기억하고 있어요.`;
  const instance = render(h(MuseChatApp, { banner, history, onCommit, personaPrompt, stream }));
  await instance.waitUntilExit();
}
