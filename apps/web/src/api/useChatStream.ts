import { useCallback, useEffect, useRef, useState } from "react";

import { parseSseFrame, splitSseFrames } from "./sse-frames.js";

import type { ChatResponse, Citation } from "./types.js";

export interface ChatTurn {
  readonly role: "user" | "assistant";
  text: string;
  citations?: readonly Citation[];
  tools?: readonly string[];
}

const STORE_KEY = "muse.chat.transcript";

function loadTranscript(): readonly ChatTurn[] {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    const parsed = raw ? (JSON.parse(raw) as ChatTurn[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
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
  const [pending, setPending] = useState(false);
  const [activeTool, setActiveTool] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const draftRef = useRef<ChatTurn | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(turns.slice(-50)));
    } catch {
      /* storage unavailable */
    }
  }, [turns]);

  const reset = useCallback(() => {
    setTurns([]);
    setError(null);
    setActiveTool("");
    try {
      window.localStorage.removeItem(STORE_KEY);
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
        setTurns((prev) => prev.map((t) => (t === d ? { ...d } : t)));
      };

      try {
        const res = await fetch(new URL("/api/chat", baseUrl).toString(), {
          body: JSON.stringify({ message: text }),
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
          });
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
            handleEvent(eventName, data, commit, setActiveTool);
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
        setPending(false);
        draftRef.current = null;
      }
    },
    [baseUrl, pending, token]
  );

  return { activeTool, error, pending, reset, send, turns };
}

function handleEvent(
  eventName: string,
  dataLine: string,
  commit: (mut: (t: ChatTurn) => void) => void,
  setActiveTool: (name: string) => void
): void {
  if (eventName === "done") {
    try {
      const payload = JSON.parse(dataLine) as ChatResponse;
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
