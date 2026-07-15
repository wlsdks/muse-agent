/**
 * HTTP wire to the Muse API, extracted from `program-helpers.ts`:
 * request/response plumbing (`apiRequest`, `formatApiErrorResponse`,
 * `friendlyFetchError`), SSE stream parsing (`readSseEvents`,
 * `parseSseEvent`, `readSseField`), the local-fallback wrapper
 * (`withApiLocalFallback`, `isApiUnreachable`), and the one
 * chat-specific streaming call (`streamRemoteChat`) that stays here
 * because it's built entirely out of this module's own pieces.
 *
 * Depends on `program-config.ts` (to resolve where/how to call the
 * API) and `program-output.ts` (`dropUndefined` for request bodies) —
 * never the reverse.
 */

import type { Command } from "commander";

import { stripUntrustedTerminalChars, truncateErrorBody } from "@muse/shared";

import { isRecord } from "./credential-store.js";
import { formatCitations } from "./human-formatters.js";
import { readApiOptions } from "./program-config.js";
import { dropUndefined } from "./program-output.js";
import type { ProgramIO } from "./program.js";

export interface SseEvent {
  readonly data: string;
  readonly event: string;
}

export async function apiRequest(
  io: ProgramIO,
  command: Command,
  reqPath: string,
  body?: Record<string, unknown>,
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
) {
  const { baseUrl, token } = await readApiOptions(io, command);
  let response: Response;
  try {
    response = await (io.fetch ?? globalThis.fetch)(new URL(reqPath, baseUrl).toString(), {
      body: body ? JSON.stringify(dropUndefined(body)) : undefined,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      method: method ?? (body ? "POST" : "GET")
    });
  } catch (error) {
    throw friendlyFetchError(baseUrl, error);
  }
  const responseText = await response.text();

  if (!response.ok) {
    throw formatApiErrorResponse(response, responseText, baseUrl);
  }

  return responseText.length > 0 ? JSON.parse(responseText) : undefined;
}

/**
 * Build a one-line Error from a non-OK API response. Caps large
 * bodies + special-cases HTML responses — a common dogfood
 * failure mode is `--api-url` pointing at a different web server
 * (a stray Next.js dev or another local app) instead of the Muse
 * API, in which case the upstream returns a multi-kilobyte HTML
 * 404 page. Dumping the raw HTML into the terminal hid the actual
 * problem. The Muse API itself defaults to port 3030 (moved off
 * 3000 to avoid the canonical Next.js port).
 */
export function formatApiErrorResponse(
  response: { readonly status: number; readonly statusText: string; readonly headers: { get(name: string): string | null } },
  body: string,
  baseUrl: string
): Error {
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("text/html")) {
    return new Error(
      `Muse API ${response.status} at ${baseUrl}: response was HTML, not JSON. ` +
      `The URL probably points at a web server instead of the Muse API — ` +
      `start the API with \`pnpm --filter @muse/api dev\` or pass --api-url <correct url>.`
    );
  }
  const trimmed = body.trim();
  // The Muse API error envelope is a JSON object carrying a
  // human-readable `errorMessage` (already credential-scrubbed
  // server-side) plus an `errorCode`. Surfacing those
  // beats dumping `{"blockReason":null,"content":null,…}`
  // truncated mid-object into the user's terminal.
  const structured = extractApiErrorEnvelope(trimmed);
  if (structured) {
    const code = structured.code ? ` (${structured.code})` : "";
    const msg = structured.message.length > 240
      ? `${structured.message.slice(0, 240)}…`
      : structured.message;
    return new Error(`Muse API ${response.status}${code}: ${msg}`);
  }
  const preview = trimmed.length > 240 ? `${trimmed.slice(0, 240)}…` : trimmed;
  return new Error(`Muse API ${response.status}: ${preview || response.statusText}`);
}

function extractApiErrorEnvelope(
  body: string
): { readonly message: string; readonly code?: string } | undefined {
  if (body.length === 0 || (body[0] !== "{" && body[0] !== "[")) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  const message = typeof parsed.errorMessage === "string" ? parsed.errorMessage.trim() : "";
  if (message.length === 0) {
    return undefined;
  }
  const code = typeof parsed.errorCode === "string" && parsed.errorCode.trim().length > 0
    ? parsed.errorCode.trim()
    : undefined;
  return code ? { code, message } : { message };
}

/**
 * Translate node-fetch / undici network errors into a single-line message
 * the user can act on. Without this, `ECONNREFUSED` surfaces as a raw
 * undici stack trace whenever the API server isn't running — which for a
 * personal-mode CLI is the most common state. A handful of admin-only
 * commands (cost/traces/telemetry/analytics/tools stats/mcp list/settings/
 * scheduler list) have NO local mode at all, so the previous wording ("most
 * commands support --local") actively misled exactly those users into
 * trying a flag their command doesn't have; this version never claims a
 * command-specific fallback exists and instead gives the one thing that's
 * ALWAYS true — how to start the server, or point at a different one.
 */
function friendlyFetchError(baseUrl: string, error: unknown): Error {
  const cause = isRecord(error) && isRecord(error.cause) ? error.cause : undefined;
  const code = cause && typeof cause.code === "string" ? cause.code : undefined;
  if (code === "ECONNREFUSED") {
    return new Error(
      `Muse API server is not running (tried ${baseUrl}) — this command needs it. ` +
      `Start it with \`pnpm --filter @muse/api dev\`, point at a running one with --api-url, ` +
      `or check \`--help\` for this command in case it has a --local (no-server) mode.`
    );
  }
  if (code === "ENOTFOUND") {
    return new Error(`Muse API host unresolved (${baseUrl}). Check --api-url.`);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Muse API request failed: ${message}`);
}

/**
 * True when an apiRequest failure means the local API daemon isn't up
 * (so a read command can fall back to the on-disk stores instead of
 * hard-failing). Matches the friendly messages `friendlyFetchError`
 * raises for ECONNREFUSED / ENOTFOUND.
 */
export function isApiUnreachable(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("Muse API server is not running") || error.message.includes("Muse API host unresolved");
}

/**
 * Local-first reliability for an actuator subcommand: run `api()`, but when the
 * Muse API server isn't running, transparently fall back to `local()` — the
 * local store is the source of truth on the default (server-less) setup. `--local`
 * skips the API entirely; ONLY a genuine "unreachable" (connection refused)
 * degrades — a real 4xx/5xx still throws, so the fallback never masks a server
 * error. Shared by `muse remind` / `muse tasks` so a WRITE behaves like a READ
 * (`list` already degraded gracefully; the write commands hard-errored).
 */
export async function withApiLocalFallback<T>(
  io: ProgramIO,
  useLocal: boolean,
  local: () => Promise<T>,
  api: () => Promise<T>,
  storeLabel: string
): Promise<T> {
  if (useLocal) {
    return local();
  }
  try {
    return await api();
  } catch (cause) {
    if (!isApiUnreachable(cause)) {
      throw cause;
    }
    io.stderr(`muse: API not reachable — using the local ${storeLabel} store.\n`);
    return local();
  }
}

export async function* readSseEvents(response: Response): AsyncIterable<SseEvent> {
  let buffer = "";

  for await (const chunk of readResponseChunks(response)) {
    buffer += chunk;
    const parts = buffer.split(/\r?\n\r?\n/u);
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const event = parseSseEvent(part);
      if (event) {
        yield event;
      }
    }
  }

  const event = parseSseEvent(buffer);
  if (event) {
    yield event;
  }
}

async function* readResponseChunks(response: Response): AsyncIterable<string> {
  if (!response.body) {
    yield await response.text();
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      yield decoder.decode(value, { stream: true });
    }

    const tail = decoder.decode();
    if (tail.length > 0) {
      yield tail;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseEvent(value: string): SseEvent | undefined {
  if (value.trim().length === 0) {
    return undefined;
  }

  let event = "message";
  const data: string[] = [];

  for (const line of value.split(/\r?\n/u)) {
    if (line.startsWith("event:")) {
      event = readSseField(line);
      continue;
    }

    if (line.startsWith("data:")) {
      data.push(readSseField(line));
    }
  }

  return {
    data: data.join("\n"),
    event
  };
}

function readSseField(line: string): string {
  const value = line.slice(line.indexOf(":") + 1);
  return value.startsWith(" ") ? value.slice(1) : value;
}

/**
 * The streamRemoteChat helper relies on `readSseEvents` + `formatCitations`
 * — kept here so the SSE stream-reader and the citation renderer stay
 * close, but it imports the chat-specific types from program.ts.
 */
export async function streamRemoteChat(
  io: ProgramIO,
  command: Command,
  message: string,
  model: string | undefined,
  jsonMode: boolean,
  agentMode: string | undefined,
  disableWebSearch?: boolean,
  systemPrompt?: string,
  conversationId?: string
) {
  const { baseUrl, token } = await readApiOptions(io, command);
  const metadataTools = disableWebSearch ? { web_search: false } : undefined;
  const metadata =
    agentMode || metadataTools
      ? { ...(agentMode ? { agentMode } : {}), ...(metadataTools ? { tools: metadataTools } : {}) }
      : undefined;
  const response = await (io.fetch ?? globalThis.fetch)(new URL("/api/chat/stream", baseUrl).toString(), {
    body: JSON.stringify(dropUndefined({
      message,
      model,
      metadata,
      conversationId,
      systemPrompt: systemPrompt && systemPrompt.trim().length > 0 ? systemPrompt.trim() : undefined
    })),
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    method: "POST"
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw formatApiErrorResponse(response, errorText, baseUrl);
  }

  let output = "";
  let streamCitations: Array<{ url: string; title: string }> | undefined;
  let responseConversationId: string | undefined;

  for await (const event of readSseEvents(response)) {
    if (event.event === "error") {
      throw new Error(`Muse API stream error: ${truncateErrorBody(event.data)}`);
    }

    if (event.event === "message") {
      // event.data here carries model output that may have echoed
      // untrusted upstream tool result text. Strip control bytes
      // (ANSI escape, BEL, NUL, etc.) before stdout — keep the
      // accumulated `output` in sync so callers see the same safe
      // string the user did.
      const safe = stripUntrustedTerminalChars(event.data);
      output += safe;
      if (!jsonMode) {
        io.stdout(safe);
      }
      continue;
    }

    if (event.event === "citations") {
      try {
        const parsed = JSON.parse(event.data);
        if (Array.isArray(parsed)) {
          streamCitations = parsed as Array<{ url: string; title: string }>;
        }
      } catch {
        // Malformed citations event — ignore and continue.
      }
      continue;
    }

        // AC1/AC4: the `grounding` frame carries `conversationId` on BOTH compat
        // and extended modes — the CLI's remote stream always runs compat, so
        // this (not `done`, which stays empty in compat) is where the id lands.
        if (event.event === "grounding") {
          try {
            const parsed = JSON.parse(event.data);
            if (isRecord(parsed)) {
              const conversationId = parsed.conversationId;
              if (typeof conversationId === "string" && conversationId.length > 0) {
                responseConversationId = conversationId;
              }
            }
          } catch {
            // Malformed grounding event — ignore and continue.
          }
      continue;
    }

    if (event.event === "done") {
      break;
    }
  }

  if (!jsonMode && !output.endsWith("\n")) {
    io.stdout("\n");
  }

  if (!jsonMode && streamCitations) {
    const citationsText = formatCitations(streamCitations);
    if (citationsText) {
      io.stdout(`${citationsText}\n`);
    }
  }

  return {
    citations: streamCitations,
    conversationId: responseConversationId,
    response: output,
    streamed: true
  };
}
