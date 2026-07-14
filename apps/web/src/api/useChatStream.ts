import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createApiClient } from "./client.js";
import { parseSseFrame, splitSseFrames } from "./sse-frames.js";
import { isRecord, parseJson, readOptionalString, readStringArray } from "./safe-json.js";

import type { ChatResponse, Citation, PendingApproval } from "./types.js";

export type { PendingApproval } from "./types.js";

export interface ChatTurn {
  readonly role: "user" | "assistant";
  text: string;
  citations?: readonly Citation[];
  tools?: readonly string[];
  pendingApprovals?: readonly PendingApproval[];
}

/** Confirm-endpoint result for a single approval. `ran:true` = the tool
 * executed and the approval is cleared; `ran:false` = the tool reported an
 * error (server keeps it pending). A 404/403/409 THROWS through the api
 * client instead of returning here. */
export interface ApproveOutcome {
  readonly ran: boolean;
  readonly tool: string;
  readonly result?: unknown;
}

const STORE_KEY = "muse.chat.transcript";
// S3b: the shared-conversation-store id this transcript continues. Kept as
// its own key (not folded into the transcript blob) so "clear" can drop it
// independent of any future transcript-shape change.
const CONVERSATION_ID_KEY = "muse.chat.conversationId";

function loadTranscript(): readonly ChatTurn[] {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    const parsed = raw ? parseJson(raw) : undefined;
    return Array.isArray(parsed)
      ? parsed.map(normalizeChatTurn).filter((turn): turn is ChatTurn => turn !== undefined)
      : [];
  } catch {
    return [];
  }
}

function loadConversationId(): string | undefined {
  try {
    return window.localStorage.getItem(CONVERSATION_ID_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/** The `/api/chat/stream` request body — carries the stored conversationId
 *  (round-tripped from a prior `done`/`grounding` frame) so the server
 *  continues the same conversation; omitted entirely on a fresh chat. */
export function chatStreamRequestBody(message: string, conversationId?: string): { readonly message: string; readonly conversationId?: string } {
  return { message, ...(conversationId ? { conversationId } : {}) };
}

function normalizeChatTurn(value: unknown): ChatTurn | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.role !== "user" && value.role !== "assistant") {
    return undefined;
  }
  if (typeof value.text !== "string") {
    return undefined;
  }
  const pendingApprovals = readPendingApprovals(value.pendingApprovals);
  const citations = readStringArray(value.citations);
  const tools = readStringArray(value.tools);
  const turn: ChatTurn = {
    role: value.role,
    text: value.text
  };
  if (pendingApprovals) {
    turn.pendingApprovals = pendingApprovals;
  }
  if (citations) {
    turn.citations = citations;
  }
  if (tools) {
    turn.tools = tools;
  }
  return turn;
}

function readPendingApprovals(value: unknown): readonly PendingApproval[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result: PendingApproval[] = [];
  for (const candidate of value) {
    if (isPendingApproval(candidate)) {
      result.push(candidate);
    }
  }
  return result;
}

function isPendingApproval(value: unknown): value is PendingApproval {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.id === "string" && typeof value.tool === "string" && typeof value.draft === "string";
}

function parseChatResponse(value: unknown): ChatResponse | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const response = readOptionalString(value.response);
  const content = readOptionalString(value.content);
  const runId = readOptionalString(value.runId);
  const model = readOptionalString(value.model);
  const conversationId = readOptionalString(value.conversationId);
  const pendingApprovals = readPendingApprovals(value.pendingApprovals);
  const citations = readStringArray(value.citations);
  const toolsUsed = readStringArray(value.toolsUsed);
  return {
    ...(response !== undefined ? { response } : {}),
    ...(content !== undefined ? { content } : {}),
    ...(runId !== undefined ? { runId } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(conversationId !== undefined ? { conversationId } : {}),
    ...(pendingApprovals !== undefined ? { pendingApprovals } : {}),
    ...(citations !== undefined ? { citations } : {}),
    ...(toolsUsed !== undefined ? { toolsUsed } : {})
  };
}

function parseCitations(value: unknown): readonly Citation[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result: Citation[] = [];
  for (const item of value) {
    if (isRecord(item) && typeof item.url === "string" && typeof item.title === "string") {
      result.push({ title: item.title, url: item.url });
    }
  }
  return result;
}

function parseGroundingText(value: unknown): { readonly answer?: string; readonly conversationId?: string } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const answer = readOptionalString(value.answer);
  const conversationId = readOptionalString(value.conversationId);
  if (answer === undefined && conversationId === undefined) {
    return undefined;
  }
  return {
    ...(answer !== undefined ? { answer } : {}),
    ...(conversationId !== undefined ? { conversationId } : {})
  };
}

function parseToolCall(value: unknown): { phase?: string; name?: string } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const phase = readOptionalString(value.phase);
  const name = readOptionalString(value.name);
  return {
    ...(phase !== undefined ? { phase } : {}),
    ...(name !== undefined ? { name } : {})
  };
}

function parseDeltaChunk(value: unknown): string {
  if (!isRecord(value)) {
    return "";
  }
  const delta = readOptionalString(value.delta);
  const content = readOptionalString(value.content);
  return delta ?? content ?? "";
}

function approvePath(id: string): string {
  return `/api/chat/approvals/${encodeURIComponent(id)}/approve`;
}

/** Reads the `pendingApprovals` array off a non-streaming JSON chat body,
 * dropping a malformed/absent value to `undefined`. */
export function readPendingApprovals(body: ChatResponse): readonly PendingApproval[] | undefined {
  return Array.isArray(body.pendingApprovals) ? body.pendingApprovals : undefined;
}

/** Pure transition for a SUCCESSFUL run (`ran:true`): on the turn that owns
 * `id`, drop that approval (its button vanishes) and append the ran note.
 * Every other turn is returned untouched by identity. A `ran:false` result is
 * NOT applied here — the server left that entry pending, so the card must stay
 * for a retry (see `applyApprove`). */
export function applyApproveOutcome(
  turns: readonly ChatTurn[],
  id: string,
  outcome: ApproveOutcome
): readonly ChatTurn[] {
  return turns.map((turn) => {
    const list = turn.pendingApprovals;
    if (!list?.some((a) => a.id === id)) {
      return turn;
    }
    return {
      ...turn,
      pendingApprovals: list.filter((a) => a.id !== id),
      text: `${turn.text}\n\n✅ Ran ${outcome.tool}.`
    };
  });
}

/** The whole approve flow behind one injectable seam: POST the confirm
 * endpoint through `post`. A `ran:true` result clears the card; a `ran:false`
 * result (the tool errored, server KEPT it pending) leaves the card and reports
 * it, so the retry affordance stays in sync with the server; a throw
 * (404/403/409/network) does the same. The hook wires real `client.post` +
 * setters into it; tests drive it with fakes. */
export async function applyApprove(
  post: <T>(path: string) => Promise<T>,
  id: string,
  setTurns: (update: (prev: readonly ChatTurn[]) => readonly ChatTurn[]) => void,
  setError: (message: string) => void
): Promise<void> {
  try {
    const outcome = await post<ApproveOutcome>(approvePath(id));
    if (outcome.ran) {
      setTurns((prev) => applyApproveOutcome(prev, id, outcome));
    } else {
      setError(`${outcome.tool} did not run — it's still pending. Try again.`);
    }
  } catch (cause) {
    setError(cause instanceof Error ? cause.message : "approval failed");
  }
}

/**
 * Streaming chat against `POST /api/chat` (SSE). Parses the server's
 * `delta` / `message` / `tool_call` / `tool_start` / `tool_end` /
 * `citations` / `done` events, and falls back to a plain JSON body when
 * the server answers `application/json` instead of `text/event-stream`.
 * Keeps a running transcript so the UI renders a real conversation.
 */
export function useChatStream(baseUrl: string, token: string) {
  const [turns, setTurns] = useState<readonly ChatTurn[]>(() => loadTranscript());
  const [conversationId, setConversationId] = useState<string | undefined>(() => loadConversationId());
  const [pending, setPending] = useState(false);
  const [activeTool, setActiveTool] = useState<string>("");
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState<readonly string[]>([]);
  const draftRef = useRef<ChatTurn | null>(null);
  const client = useMemo(() => createApiClient(baseUrl, token), [baseUrl, token]);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(turns.slice(-50)));
    } catch {
      /* storage unavailable */
    }
  }, [turns]);

  useEffect(() => {
    try {
      if (conversationId) {
        window.localStorage.setItem(CONVERSATION_ID_KEY, conversationId);
      } else {
        window.localStorage.removeItem(CONVERSATION_ID_KEY);
      }
    } catch {
      /* storage unavailable */
    }
  }, [conversationId]);

  const reset = useCallback(() => {
    setTurns([]);
    setError(null);
    setActiveTool("");
    setConversationId(undefined);
    try {
      window.localStorage.removeItem(STORE_KEY);
      window.localStorage.removeItem(CONVERSATION_ID_KEY);
    } catch {
      /* storage unavailable */
    }
  }, []);

  const send = useCallback(
    async (message: string) => {
      const text = message.trim();
      if (!text || pending) {
        return;
      }
      setError(null);
      setPending(true);
      setActiveTool("");
      setThinking(false);

      const userTurn: ChatTurn = { role: "user", text };
      const draft: ChatTurn = { citations: [], role: "assistant", text: "", tools: [] };
      draftRef.current = draft;
      setTurns((prev) => [...prev, userTurn, draft]);

      const commit = (mut: (t: ChatTurn) => void) => {
        const d = draftRef.current;
        if (!d) {
          return;
        }
        mut(d);
        // Replace by POSITION, not identity: the first commit swaps the draft
        // for a clone in the array, so a `t === d` match goes dead after one
        // update — under real token streaming that froze the bubble on the
        // first delta. The draft is always the last turn while pending
        // (send() rejects re-entry), so the tail slot is the draft's slot.
        setTurns((prev) => prev.map((t, i) => (i === prev.length - 1 ? { ...d } : t)));
      };

      try {
        const res = await fetch(new URL("/api/chat/stream", baseUrl).toString(), {
          body: JSON.stringify(chatStreamRequestBody(text, conversationId)),
          headers: {
            accept: "text/event-stream",
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {})
          },
          method: "POST"
        });
        if (!res.ok) {
          throw new Error(`${res.status} ${res.statusText}`.trim());
        }

        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("text/event-stream")) {
          const raw = await res.text();
          const parsed = parseChatResponse(parseJson(raw));
          if (parsed) {
            commit((t) => {
              t.text = parsed.response ?? parsed.content ?? "";
              t.citations = parsed.citations ?? [];
              t.tools = parsed.toolsUsed ?? [];
              t.pendingApprovals = parsed.pendingApprovals;
            });
            if (parsed.conversationId) {
              setConversationId(parsed.conversationId);
            }
          }
          }
          return;
        }

        const reader = res.body?.getReader();
        if (!reader) {
          throw new Error("No readable stream on response");
        }
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const { frames, rest } = splitSseFrames(buffer);
          buffer = rest;

          for (const frame of frames) {
            const { data, eventName } = parseSseFrame(frame);
            if (!data) {
              continue;
            }
            handleEvent(eventName, data, commit, setActiveTool, setThinking, setConversationId);
          }
        }
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : "request failed";
        setError(detail);
        commit((t) => {
          if (!t.text) {
            t.text = `⚠ ${detail}`;
          }
        });
      } finally {
        setActiveTool("");
        setThinking(false);
        setPending(false);
        draftRef.current = null;
      }
    },
    [baseUrl, conversationId, pending, token]
  );

  const approve = useCallback(
    async (id: string) => {
      if (approving.includes(id)) {
        return;
      }
      setError(null);
      setApproving((ids) => [...ids, id]);
      try {
        await applyApprove(client.post, id, setTurns, setError);
      } finally {
        setApproving((ids) => ids.filter((x) => x !== id));
      }
    },
    [approving, client]
  );

  return { activeTool, approve, approving, conversationId, error, pending, reset, send, thinking, turns };
}

export function handleEvent(
  eventName: string,
  dataLine: string,
  commit: (mut: (t: ChatTurn) => void) => void,
  setActiveTool: (name: string) => void,
  setThinking: (on: boolean) => void,
  onConversationId?: (id: string) => void
): void {
  if (eventName === "stage") {
    setThinking(true);
    return;
  }

  if (eventName === "pending-approvals") {
    const payload = parsePendingApprovalsPayload(dataLine);
    if (payload.length > 0) {
        commit((t) => {
          t.pendingApprovals = payload;
        });
    }
    return;
  }

  // The gated answer is AUTHORITATIVE: the grounding gate may have replaced
  // a fabricated/uncited claim after the raw tokens streamed by.
  if (eventName === "grounding") {
    const grounding = parseGroundingText(parseJson(dataLine));
    if (grounding?.answer !== undefined && grounding.answer.length > 0) {
      commit((t) => {
        t.text = grounding.answer;
      });
    }
    if (grounding?.conversationId) {
      onConversationId?.(grounding.conversationId);
    }
    setThinking(false);
    return;
  }

  if (eventName === "done") {
    setThinking(false);
    const payload = parseChatResponse(parseJson(dataLine));
    if (payload) {
      commit((t) => {
        const finalText = payload.response ?? payload.content;
        if (finalText) {
          t.text = finalText;
        }
        if (payload.citations?.length) {
          t.citations = payload.citations;
        }
        if (payload.toolsUsed?.length) {
          t.tools = payload.toolsUsed;
        }
      });
      if (payload.conversationId) {
        onConversationId?.(payload.conversationId);
      }
    }
    return;
  }

  if (eventName === "delta" || eventName === "message") {
    setThinking(false);
    const chunk = parseDeltaChunk(parseJson(dataLine)) || dataLine;
    if (chunk) {
      commit((t) => {
        t.text += chunk;
      });
    }
    return;
  }

  if (eventName === "tool_start") {
    const name = dataLine.replace(/^"|"$/g, "").trim();
    setActiveTool(name);
    commit((t) => {
      t.tools = [...(t.tools ?? []), name];
    });
    return;
  }

  if (eventName === "tool_end") {
    setActiveTool("");
    return;
  }

  if (eventName === "tool_call") {
    const payload = parseToolCall(parseJson(dataLine));
    if (payload) {
      setActiveTool(payload.phase === "started" ? payload.name ?? "working" : "");
    }
    return;
  }

  if (eventName === "citations") {
    const payload = parseCitations(parseJson(dataLine));
    if (Array.isArray(payload) && payload.length > 0) {
        commit((t) => {
          t.citations = payload;
        });
    }
  }
}

function parsePendingApprovalsPayload(line: string): readonly PendingApproval[] {
  return readPendingApprovals(parseJson(line)) ?? [];
}
