import { useCallback, useEffect, useRef, useState } from "react";

import { isRecord, parseJson } from "./parse-json.js";
import { parseSseFrame, splitSseFrames } from "./sse-frames.js";
import { createStreamRequestLifecycle } from "./stream-request-lifecycle.js";
import { errorMessage } from "@muse/shared/browser";

import type { AskResult, AskRetrieval, AskVerdict } from "./types.js";

export { parseSseFrame, splitSseFrames };
export { createStreamRequestLifecycle as createAskStreamRequestLifecycle } from "./stream-request-lifecycle.js";

export interface AskState {
  readonly answer: string;
  readonly retrieval: AskRetrieval | null;
  readonly result: AskResult | null;
  readonly error: string | null;
}

export const INITIAL_ASK_STATE: AskState = { answer: "", error: null, result: null, retrieval: null };

function isAskVerdict(value: unknown): value is AskVerdict {
  return value === "confident" || value === "ambiguous" || value === "none";
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function asAskRetrieval(data: unknown): AskRetrieval | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  const groundedChunkCount = data.groundedChunkCount;
  const notesUnavailable = data.notesUnavailable;
  const verdict = data.verdict;
  if (typeof groundedChunkCount !== "number" || typeof notesUnavailable !== "boolean" || !isAskVerdict(verdict)) {
    return undefined;
  }
  return { groundedChunkCount, notesUnavailable, verdict };
}

function asAskResult(data: unknown): AskResult | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  const answer = data.answer;
  const verdict = data.verdict;
  const citations = data.citations;
  const strippedCitations = data.strippedCitations;
  const refusal = data.refusal;
  const notesUnavailable = data.notesUnavailable;
  const groundedChunkCount = data.groundedChunkCount;
  if (
    typeof answer !== "string" ||
    !isAskVerdict(verdict) ||
    !isStringArray(citations) ||
    !isStringArray(strippedCitations) ||
    typeof refusal !== "boolean" ||
    typeof notesUnavailable !== "boolean" ||
    typeof groundedChunkCount !== "number"
  ) {
    return undefined;
  }
  const receipts = typeof data.receipts === "string" ? data.receipts : undefined;
  return {
    answer,
    verdict,
    citations,
    strippedCitations,
    refusal,
    notesUnavailable,
    groundedChunkCount,
    ...(receipts ? { receipts } : {})
  };
}

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
    const retrieval = asAskRetrieval(parseJson(data));
    if (!retrieval) {
      return state;
    }
    return { ...state, retrieval };
  }
  if (eventName === "delta") {
    return data.length > 0 ? { ...state, answer: state.answer + data } : state;
  }
  if (eventName === "result") {
    const result = asAskResult(parseJson(data));
    if (!result) {
      return state;
    }
    return { ...state, answer: result.answer, result };
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
  const lifecycleRef = useRef<ReturnType<typeof createStreamRequestLifecycle> | null>(null);
  if (!lifecycleRef.current) {
    lifecycleRef.current = createStreamRequestLifecycle();
  }
  const lifecycle = lifecycleRef.current;

  useEffect(() => () => lifecycle.abort(), [lifecycle]);

  const reset = useCallback(() => {
    lifecycle.abort();
    setState(INITIAL_ASK_STATE);
    setPending(false);
  }, [lifecycle]);

  const ask = useCallback(
    async (question: string) => {
      const trimmed = question.trim();
      if (!trimmed) {
        return;
      }
      const request = lifecycle.start();
      if (!request) {
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
          method: "POST",
          signal: request.controller.signal
        });
        if (!res.ok) {
          throw new Error(`${res.status} ${res.statusText}`.trim());
        }

        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("text/event-stream")) {
          const body = asAskResult(await res.json());
          if (!body) {
            throw new Error("Malformed non-stream response");
          }
          if (lifecycle.isCurrent(request)) {
            setState((prev) => ({ ...prev, answer: body.answer, result: body }));
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
          if (!lifecycle.isCurrent(request)) {
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          const { frames, rest } = splitSseFrames(buffer);
          buffer = rest;
          for (const frame of frames) {
            const { data, eventName } = parseSseFrame(frame);
            if (lifecycle.isCurrent(request)) {
              setState((prev) => reduceAskEvent(prev, eventName, data));
            }
          }
        }
      } catch (cause) {
        if (lifecycle.isCurrent(request) && !request.controller.signal.aborted) {
          const detail = errorMessage(cause, "request failed");
          setState((prev) => ({ ...prev, error: prev.error ?? detail }));
        }
      } finally {
        if (lifecycle.finish(request)) {
          setPending(false);
        }
      }
    },
    [baseUrl, lifecycle, token]
  );

  return { ...state, ask, pending, reset };
}
