/**
 * Infrastructure helpers extracted from `program.ts`:
 *
 *   - HTTP wire: `apiRequest`, `friendlyFetchError`, SSE stream
 *     parsing (`readSseEvents`, `parseSseEvent`, `readSseField`).
 *   - Local config: `readConfigStore`, `writeConfigStore`,
 *     `setConfigValue`, `configPath`, `readApiOptions`.
 *   - Interactive auth: `resolveAuthToken`, `promptText`,
 *     `promptPassword`, `readPromptValue`.
 *   - Output shaping: `writeOutput`, `dropUndefined`.
 *   - Run-log persistence: `writeRunLog`, `readResponseRunId`,
 *     `renderActiveContext`.
 *   - Misc guards: `isNodeError`.
 *
 * Everything here is provider-neutral and chat-REPL-independent;
 * the chat REPL itself stays in program.ts (next decomp phase
 * will lift it into chat-repl.ts).
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { isCancel, password, text } from "@clack/prompts";
import { stripUntrustedTerminalChars, truncateErrorBody } from "@muse/shared";
import type { Command } from "commander";

import { closestCommandName } from "./closest-command.js";
import { isRecord, readStoredToken } from "./credential-store.js";
import { formatCitations } from "./human-formatters.js";
import type { ProgramIO } from "./program.js";

export interface ApiOptions {
  readonly baseUrl: string;
  readonly token?: string;
}

export interface MuseCliConfig {
  readonly apiUrl?: string;
  readonly defaultModel?: string;
}

export interface ReadApiOptionsOptions {
  readonly includeStoredToken?: boolean;
}

export interface SseEvent {
  readonly data: string;
  readonly event: string;
}

export interface RunLogInput {
  readonly apiUrl?: string;
  readonly message: string;
  readonly model?: string;
  readonly response: unknown;
  readonly source?: "cli.local" | "cli.remote" | "cli.remote.stream";
}

export interface AskRunLogParams {
  readonly query: string;
  readonly model?: string;
  readonly timings: Record<string, number>;
  /** summarizeTokenConfidence output (may be null); omitted from the entry when undefined. */
  readonly confidence?: unknown;
  /** The outcome label (askOutcomeLabel); an explicit null is a real label, kept distinct from absent. */
  readonly grounded: string | null;
  readonly response: string;
  readonly success: boolean;
  readonly toolsUsed: readonly string[];
  /** Present on a FAILED run — the seam #6 needs so a thrown ask leaves a success:false trace. */
  readonly errorMessage?: string;
  /**
   * Fan-out trust signals (decomposed runs only) — so a self-contradicting / incomplete /
   * truncated fan-out is NOT logged as a clean `success:true, grounded` row. Without this
   * the error-analysis flywheel sees a fan-out failure as a success and gets no fuel.
   */
  readonly decomposition?: {
    readonly subtaskCount: number;
    readonly truncated: boolean;
    readonly subtaskConflicts?: readonly string[];
    readonly synthesisIncomplete?: readonly string[];
  };
  /**
   * Source-check signals on a GROUNDED answer (grounded≠true): the answer rested
   * only on untrusted sources, or a citation was unsupported / a claim uncited.
   * Logged so the error-analysis flywheel doesn't see a grounded-but-untrusted
   * answer as a clean success — the same reason `decomposition` is logged.
   */
  readonly sourceCheck?: {
    readonly untrustedOnly: boolean;
    readonly citationUnsupported: boolean;
    readonly citationUncited: boolean;
  };
}

/**
 * Build the cli.local `muse ask` run-log entry. Single source of truth for the
 * SUCCESS path (today's inline payload) AND the FAILURE path (#6: a thrown run
 * must still leave a `success:false` trace for error-analysis, not vanish). The
 * caller's catch passes `success:false` + `errorMessage`; everything else mirrors
 * the success entry so both rows are shaped identically for the analyzer.
 */
export function buildAskRunLog(params: AskRunLogParams): RunLogInput {
  return {
    message: params.query,
    ...(params.model !== undefined ? { model: params.model } : {}),
    response: {
      timings: params.timings,
      ...(params.confidence !== undefined ? { confidence: params.confidence } : {}),
      grounded: params.grounded,
      response: params.response,
      success: params.success,
      toolsUsed: params.toolsUsed,
      ...(params.decomposition !== undefined ? { decomposition: params.decomposition } : {}),
      ...(params.sourceCheck !== undefined ? { sourceCheck: params.sourceCheck } : {}),
      ...(params.errorMessage !== undefined ? { error: params.errorMessage } : {})
    },
    source: "cli.local"
  };
}

export function defaultConfigPath(home?: string): string {
  const explicit = typeof home === "string" ? home.trim() : "";
  if (explicit.length > 0) return path.join(explicit, ".config", "muse", "config.json");
  const envHome = process.env.HOME?.trim();
  if (envHome && envHome.length > 0) return path.join(envHome, ".config", "muse", "config.json");
  const sysHome = homedir().trim();
  if (sysHome.length > 0) return path.join(sysHome, ".config", "muse", "config.json");
  throw new Error("Cannot resolve home directory for config.json — HOME is empty and os.homedir() returned no value");
}

/**
 * Resolve a persona slot: explicit option > `MUSE_PERSONA` env > none.
 *
 * Centralises persona precedence so every subcommand (chat REPL,
 * brief, remember, ask, trust, approval, jobs) honours the same
 * env fallback. Setting `export MUSE_PERSONA=work` in a shell-rc
 * lets the user skip `--persona` on every invocation while keeping
 * the in-session `/persona` switch and explicit `--persona` flag
 * operational. P1 from `docs/agent-capability-audit.md`.
 */
export function resolvePersona(personaOption: string | undefined): string | undefined {
  const explicit = personaOption?.trim();
  if (explicit && explicit.length > 0) {
    return explicit;
  }
  const fromEnv = process.env.MUSE_PERSONA?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

export function configPath(io: ProgramIO): string {
  return io.configDir ? path.join(io.configDir, "config.json") : defaultConfigPath();
}

export async function resolveAuthToken(io: ProgramIO, token: string | undefined): Promise<string> {
  const trimmed = token?.trim();

  if (trimmed && trimmed.length > 0) {
    return trimmed;
  }

  return promptPassword(io, { message: "Muse API token" });
}

export async function promptText(
  io: ProgramIO,
  options: { readonly message: string; readonly placeholder?: string }
): Promise<string> {
  const value = io.prompts
    ? await io.prompts.text(options)
    : await text(options);

  return readPromptValue(value, "Prompt was cancelled");
}

async function promptPassword(io: ProgramIO, options: { readonly message: string }): Promise<string> {
  const value = io.prompts
    ? await io.prompts.password(options)
    : await password(options);

  return readPromptValue(value, "Authentication was cancelled");
}

function readPromptValue(value: unknown, cancelMessage: string): string {
  if (isCancel(value)) {
    throw new Error(cancelMessage);
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Interactive input must not be empty");
  }

  return value.trim();
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

  return responseText.length > 0 ? JSON.parse(responseText) as unknown : undefined;
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
 * personal-mode CLI is the most common state.
 */
function friendlyFetchError(baseUrl: string, error: unknown): Error {
  const cause = isRecord(error) && isRecord(error.cause) ? error.cause : undefined;
  const code = cause && typeof cause.code === "string" ? cause.code : undefined;
  if (code === "ECONNREFUSED") {
    return new Error(
      `Muse API not reachable at ${baseUrl}. Re-run with --local to run on your machine ` +
      `(no server needed — most commands support it), or start the Muse API server, or set --api-url.`
    );
  }
  if (code === "ENOTFOUND") {
    return new Error(`Muse API host unresolved (${baseUrl}). Check --api-url.`);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Muse API request failed: ${message}`);
}

export function firstNonEmpty(...candidates: ReadonlyArray<string | undefined>): string | undefined {
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const trimmed = c.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

export async function readApiOptions(
  io: ProgramIO,
  command: Command,
  readOptions: ReadApiOptionsOptions = {}
): Promise<ApiOptions> {
  const globalOptions = command.optsWithGlobals() as { readonly apiUrl?: string; readonly token?: string };
  const config = await readConfigStore(io);
  const baseUrl = firstNonEmpty(globalOptions.apiUrl, process.env.MUSE_API_URL, config.apiUrl) ?? "http://127.0.0.1:3030";
  const explicitToken = firstNonEmpty(globalOptions.token, process.env.MUSE_API_TOKEN);

  return {
    baseUrl,
    token: explicitToken ?? (readOptions.includeStoredToken === false ? undefined : await readStoredToken(io, baseUrl))
  };
}

export async function readConfigStore(io: ProgramIO): Promise<MuseCliConfig> {
  try {
    const raw = await readFile(configPath(io), "utf8");
    const parsed = JSON.parse(raw) as unknown;

    if (!isRecord(parsed)) {
      throw new Error("Invalid Muse config format");
    }

    return {
      ...(typeof parsed.apiUrl === "string" && parsed.apiUrl.trim().length > 0 ? { apiUrl: parsed.apiUrl } : {}),
      ...(typeof parsed.defaultModel === "string" && parsed.defaultModel.trim().length > 0
        ? { defaultModel: parsed.defaultModel }
        : {})
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

export async function writeConfigStore(io: ProgramIO, config: MuseCliConfig): Promise<void> {
  const filePath = configPath(io);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600);
}

const SUPPORTED_CONFIG_KEYS = ["apiUrl", "defaultModel"] as const;

export function setConfigValue(config: MuseCliConfig, key: string, value: string): MuseCliConfig {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new Error("Config value must not be empty");
  }

  if (key === "apiUrl") {
    return { ...config, apiUrl: trimmed };
  }

  if (key === "defaultModel") {
    return { ...config, defaultModel: trimmed };
  }

  const suggestion = closestCommandName(key, SUPPORTED_CONFIG_KEYS);
  const hint = suggestion ? ` — did you mean '${suggestion}'?` : "";
  throw new Error(`Unsupported config key '${key}' (expected one of: ${SUPPORTED_CONFIG_KEYS.join(", ")})${hint}`);
}

/**
 * Clear a config key so it reverts to the built-in default (e.g. drop
 * a wrong `apiUrl` to fall back to the local server) — `set`'s missing
 * inverse, without hand-editing the JSON. Same key validation as
 * `setConfigValue`; `wasSet` lets the caller distinguish a real clear
 * from a no-op so it can say "x was not set" instead of a false
 * "cleared".
 */
export function unsetConfigValue(
  config: MuseCliConfig,
  key: string
): { readonly config: MuseCliConfig; readonly wasSet: boolean } {
  if (key !== "apiUrl" && key !== "defaultModel") {
    const suggestion = closestCommandName(key, SUPPORTED_CONFIG_KEYS);
    const hint = suggestion ? ` — did you mean '${suggestion}'?` : "";
    throw new Error(`Unsupported config key '${key}' (expected one of: ${SUPPORTED_CONFIG_KEYS.join(", ")})${hint}`);
  }
  const wasSet = config[key] !== undefined;
  const { [key]: _removed, ...rest } = config;
  return { config: rest, wasSet };
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
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
  return error.message.includes("Muse API not reachable") || error.message.includes("Muse API host unresolved");
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

export function writeOutput(io: ProgramIO, value: unknown, textField?: string): void {
  if (textField && isRecord(value) && typeof value[textField] === "string") {
    io.stdout(`${value[textField]}\n`);
    return;
  }

  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

export function dropUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined));
}

export function renderActiveContext(snapshot: Record<string, unknown>): string {
  // Pretty-print the same fields the agent loop renders into the
  // `[Active Context]` system section. Layout mirrors
  // `renderActiveContextSection` from @muse/agent-core so the CLI
  // operator sees what the prompt will contain — without committing
  // to a structural import that drags agent-core into the CLI tree.
  const lines: string[] = [];
  const nowIso = typeof snapshot.nowIso === "string" ? snapshot.nowIso : undefined;
  const weekday = typeof snapshot.weekday === "string" ? snapshot.weekday : "?";
  const timezone = typeof snapshot.timezone === "string" ? snapshot.timezone : "?";
  lines.push(`now=${nowIso ?? "?"} (${weekday}, ${timezone})`);
  const workingHours = isRecord(snapshot.workingHours)
    ? snapshot.workingHours as { start?: number; end?: number }
    : undefined;
  if (workingHours && typeof workingHours.start === "number" && typeof workingHours.end === "number") {
    const inWindow = snapshot.isWorkingHours === undefined
      ? "unknown"
      : snapshot.isWorkingHours ? "yes" : "no";
    lines.push(`working_hours=${workingHours.start.toString()}-${workingHours.end.toString()} (in_window=${inWindow})`);
  }
  if (typeof snapshot.currentFocus === "string" && snapshot.currentFocus.trim()) {
    lines.push(`current_focus: ${snapshot.currentFocus}`);
  }
  const activeTask = isRecord(snapshot.activeTask) ? snapshot.activeTask : undefined;
  if (activeTask && typeof activeTask.title === "string") {
    const parts = [activeTask.title];
    if (typeof activeTask.id === "string") { parts.push(`id=${activeTask.id}`); }
    if (typeof activeTask.dueIso === "string") { parts.push(`due=${activeTask.dueIso}`); }
    lines.push(`active_task: ${parts.join(" · ")}`);
  }
  const events = Array.isArray(snapshot.todaysEvents) ? snapshot.todaysEvents : [];
  if (events.length > 0) {
    lines.push("today_events:");
    for (const eventValue of events.slice(0, 8)) {
      if (!isRecord(eventValue)) { continue; }
      const title = typeof eventValue.title === "string" ? eventValue.title : "(untitled)";
      const startIso = typeof eventValue.startIso === "string" ? eventValue.startIso : "?";
      const allDay = eventValue.allDay === true;
      const locationPart = typeof eventValue.location === "string" ? ` @ ${eventValue.location}` : "";
      lines.push(`  · ${allDay ? "(all day)" : startIso} ${title}${locationPart}`);
    }
  }
  return lines.join("\n");
}

export async function writeRunLog(workspaceDir: string, input: RunLogInput, now = new Date()): Promise<string> {
  const runDir = path.join(workspaceDir, ".muse", "runs");
  const runId = readResponseRunId(input.response) ?? `cli-${now.getTime().toString()}`;
  const filePath = path.join(runDir, `${runId}.jsonl`);
  const event = {
    apiUrl: input.apiUrl ?? process.env.MUSE_API_URL ?? "http://127.0.0.1:3030",
    // Outcome labels lifted to the TOP LEVEL so a trace is greppable for error-analysis
    // without descending into `response`. cli.remote responses carry these; cli.local
    // responses do not yet (populating them in the local ask path is the next sub-slice),
    // so they are null there for now — but the schema error-analysis will read is fixed here.
    grounded: readResponseGrounded(input.response) ?? null,
    message: input.message,
    model: input.model ?? null,
    recordedAt: now.toISOString(),
    response: input.response,
    source: input.source ?? "cli.remote",
    success: readResponseSuccess(input.response) ?? null,
    type: "chat.completed"
  };

  await mkdir(runDir, { recursive: true });
  await writeFile(filePath, `${JSON.stringify(event)}\n`, { flag: "a" });
  return filePath;
}

function readResponseRunId(value: unknown): string | undefined {
  if (isRecord(value) && typeof value.runId === "string" && value.runId.trim().length > 0) {
    return value.runId;
  }

  return undefined;
}

/** Lift a boolean `success` outcome from a response, if it carries one (cli.remote does). */
export function readResponseSuccess(value: unknown): boolean | undefined {
  if (isRecord(value) && typeof value.success === "boolean") {
    return value.success;
  }
  return undefined;
}

/** Lift the `grounded` verdict from a response, if present (may be an object or explicit null). */
export function readResponseGrounded(value: unknown): unknown {
  if (isRecord(value) && "grounded" in value) {
    return value.grounded;
  }
  return undefined;
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
  systemPrompt?: string
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
        const parsed = JSON.parse(event.data) as unknown;
        if (Array.isArray(parsed)) {
          streamCitations = parsed as Array<{ url: string; title: string }>;
        }
      } catch {
        // Malformed citations event — ignore and continue.
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
    response: output,
    streamed: true
  };
}
