import { useCallback, useState } from "react";

import { parseSseFrame, splitSseFrames } from "./sse-frames.js";

import type { AskResult, AskRetrieval } from "./types.js";

export { parseSseFrame, splitSseFrames };

export interface AskState {
  readonly answer: string;
  readonly retrieval: AskRetrieval | null;
  readonly result: AskResult | null;
  readonly error: string | null;
}

export const INITIAL_ASK_STATE: AskState = { answer: "", error: null, result: null, retrieval: null };

/**
 * Pure reducer over one decoded SSE event — the whole `/api/ask` streaming
 * contract (`toAskSseStream` in ask-routes.ts): `retrieval` (JSON, arrives
 * first) → `delta` (raw answer text, repeats) → `result` (JSON, the
 * authoritative final answer — already citation-gate-filtered) | `error`
 * (raw message, ends the stream early). Unknown event names are ignored so
 * a future server event never crashes an older client.
 */
export function reduceAskEvent(state: AskState, eventName: string, data: string): AskState {
  if (eventName === "retrieval") {
    try {
      return { ...state, retrieval: JSON.parse(data) as AskRetrieval };
    } catch {
      return state;
    }
  }
  if (eventName === "delta") {
    return data.length > 0 ? { ...state, answer: state.answer + data } : state;
  }
  if (eventName === "result") {
    try {
      const result = JSON.parse(data) as AskResult;
      return { ...state, answer: result.answer, result };
    } catch {
      return state;
    }
  }
  if (eventName === "error") {
    return { ...state, error: data.length > 0 ? data : "request failed" };
  }
  return state;
}

/**
 * Streaming grounded recall against `POST /api/ask` (SSE). Mirrors
 * `useChatStream`'s fetch-and-parse shape, and falls back to the plain
 * buffered JSON body (`AskResult`) when the server answers
 * `application/json` instead of `text/event-stream` (same contract as the
 * chat hook — `Accept` is a preference, not a guarantee).
 */
export function useAskStream(baseUrl: string, token: string) {
  const [state, setState] = useState<AskState>(INITIAL_ASK_STATE);
  const [pending, setPending] = useState(false);

  const reset = useCallback(() => {
    setState(INITIAL_ASK_STATE);
  }, []);

  const ask = useCallback(
    async (question: string) => {
      const trimmed = question.trim();
      if (!trimmed || pending) {
        return;
      }
      setState(INITIAL_ASK_STATE);
      setPending(true);

      try {
        const res = await fetch(new URL("/api/ask", baseUrl).toString(), {
          body: JSON.stringify({ question: trimmed }),
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
          const body = (await res.json()) as AskResult;
          setState((prev) => ({ ...prev, answer: body.answer, result: body }));
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
            setState((prev) => reduceAskEvent(prev, eventName, data));
          }
        }
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : "request failed";
        setState((prev) => ({ ...prev, error: prev.error ?? detail }));
      } finally {
        setPending(false);
      }
    },
    [baseUrl, pending, token]
  );

  return { ...state, ask, pending, reset };
}
