import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createApiClient } from "./client.js";
import { parseSseFrame, splitSseFrames } from "./sse-frames.js";

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
    const parsed = raw ? (JSON.parse(raw) as ChatTurn[]) : [];
    return Array.isArray(parsed) ? parsed : [];
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
          const body = (await res.json()) as ChatResponse;
          commit((t) => {
            t.text = body.response ?? body.content ?? "";
            t.citations = body.citations ?? [];
            t.tools = body.toolsUsed ?? [];
            t.pendingApprovals = readPendingApprovals(body);
          });
          if (body.conversationId) {
            setConversationId(body.conversationId);
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
    try {
      const payload = JSON.parse(dataLine) as { pendingApprovals?: readonly PendingApproval[] };
      if (Array.isArray(payload.pendingApprovals) && payload.pendingApprovals.length > 0) {
        commit((t) => {
          t.pendingApprovals = payload.pendingApprovals;
        });
      }
    } catch {
      /* ignore malformed pending-approvals frame */
    }
    return;
  }

  // The gated answer is AUTHORITATIVE: the grounding gate may have replaced
  // a fabricated/uncited claim after the raw tokens streamed by.
  if (eventName === "grounding") {
    try {
      const payload = JSON.parse(dataLine) as { answer?: string; conversationId?: string };
      if (typeof payload.answer === "string" && payload.answer.length > 0) {
        commit((t) => {
          t.text = payload.answer!;
        });
      }
      if (typeof payload.conversationId === "string" && payload.conversationId.length > 0) {
        onConversationId?.(payload.conversationId);
      }
    } catch {
      /* ignore malformed grounding frame */
    }
    setThinking(false);
    return;
  }

  if (eventName === "done") {
    setThinking(false);
    try {
      const payload = JSON.parse(dataLine) as ChatResponse;
      if (payload.conversationId) {
        onConversationId?.(payload.conversationId);
      }
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
    } catch {
      /* ignore non-JSON done payload */
    }
    return;
  }

  if (eventName === "delta" || eventName === "message") {
    setThinking(false);
    let chunk = dataLine;
    try {
      const payload = JSON.parse(dataLine) as { delta?: string; content?: string };
      chunk = payload.delta ?? payload.content ?? "";
    } catch {
      /* plain-text delta */
    }
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
    try {
      const payload = JSON.parse(dataLine) as { phase?: string; name?: string };
      setActiveTool(payload.phase === "started" ? payload.name ?? "working" : "");
    } catch {
      /* ignore */
    }
    return;
  }

  if (eventName === "citations") {
    try {
      const payload = JSON.parse(dataLine) as readonly Citation[];
      if (Array.isArray(payload) && payload.length > 0) {
        commit((t) => {
          t.citations = payload;
        });
      }
    } catch {
      /* ignore */
    }
  }
}
