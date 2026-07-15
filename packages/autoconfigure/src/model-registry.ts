/**
 * R3-3 — `/model` switching, validated against what Ollama actually has
 * installed. The ONE shared implementation both surfaces that let a user
 * switch Muse's default model call: `muse model use <name>` (apps/cli) and
 * `/model <name>` (apps/api's inbound slash commands). Living here — a
 * package both apps already depend on — rather than in either app is what
 * makes it genuinely shared: apps/api cannot import apps/cli (a separate
 * app, not a workspace package), so any "one implementation, two surfaces"
 * piece has to sit in a package.
 *
 * Ground truth this module encodes (see the R3-3 handoff's scout section):
 *   - `resolveDefaultModel` (autoconfigure-model-provider.ts) reads ONLY
 *     `MUSE_MODEL` / `MUSE_DEFAULT_MODEL` from the process env — never the
 *     CLI config file — so an explicit env var always wins over whatever
 *     this module writes (`activeModelEnvOverride` surfaces that so callers
 *     can say so honestly instead of implying the switch always applies).
 *   - The API server's ONE `MuseRuntimeAssembly` (and therefore its
 *     `defaultModel` / `modelProvider`) is built ONCE at process boot
 *     (`apps/api/src/index.ts`'s top-level `createApiServerOptions()`) from
 *     that same process env, and NEVER reads the CLI config file — there is
 *     no hot-reload seam for the model (unlike `PERSONA.md`'s
 *     `PersonaHotReloadRegistry`). So writing the config file changes what
 *     the NEXT `muse chat` / `muse tui` CLI invocation uses; it does NOT
 *     change an already-running daemon/API server, even after a restart,
 *     unless the operator separately exports `MUSE_DEFAULT_MODEL` for that
 *     process. Both call sites must surface this caveat verbatim rather
 *     than imply the switch "just works" everywhere.
 */

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { classifyProviderLocality } from "@muse/model";
import { closestCommandName, isRecord, parseJson } from "@muse/shared";

import type { MuseEnvironment } from "./index.js";
import { mergeModelKeysFromFile } from "./personal-providers.js";

export interface InstalledOllamaModel {
  readonly name: string;
  readonly sizeBytes?: number;
  readonly modifiedAt?: string;
}

export type OllamaModelsResult =
  | { readonly ok: true; readonly models: readonly InstalledOllamaModel[] }
  | { readonly ok: false; readonly error: string };

/** Short — this must never block a chat reply or a CLI command waiting on an unreachable Ollama. */
const OLLAMA_TAGS_TIMEOUT_MS = 3_000;

/**
 * Hits Ollama's native `/api/tags` (not the OpenAI-compat `/v1/models`,
 * which drops size/modified — this feature needs both to render a useful
 * `muse model list`). `fetchImpl` is injected (defaults to the real
 * `globalThis.fetch`) so every test supplies a fake — never a real
 * network call from `pnpm test`.
 */
export async function fetchInstalledOllamaModels(
  baseUrl: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  timeoutMs = OLLAMA_TAGS_TIMEOUT_MS
): Promise<OllamaModelsResult> {
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/u, "")}/api/tags`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
      return { error: `Ollama responded ${response.status.toString()} at ${baseUrl}`, ok: false };
    }
    const body = (await response.json()) as {
      readonly models?: readonly { readonly name?: unknown; readonly size?: unknown; readonly modified_at?: unknown }[];
    };
    const models = (body.models ?? [])
      .filter((m): m is { readonly name: string; readonly size?: unknown; readonly modified_at?: unknown } =>
        typeof m.name === "string" && m.name.length > 0)
      .map((m) => ({
        name: m.name,
        ...(typeof m.size === "number" ? { sizeBytes: m.size } : {}),
        ...(typeof m.modified_at === "string" ? { modifiedAt: m.modified_at } : {})
      }));
    return { models, ok: true };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), ok: false };
  }
}

/** Same merge `@muse/autoconfigure` runs for the agent runtime (env, then
 * `~/.muse/models.json`) — kept consistent so a remote Ollama host works on
 * every surface that lists/switches models, not just chat. */
export function resolveOllamaBaseUrl(env: MuseEnvironment): string {
  const merged = mergeModelKeysFromFile(env);
  const raw = merged.OLLAMA_BASE_URL?.trim();
  const base = raw && raw.length > 0 ? raw : "http://127.0.0.1:11434";
  return base.replace(/\/+$/u, "");
}

export interface ModelEnvOverride {
  readonly key: "MUSE_MODEL" | "MUSE_DEFAULT_MODEL";
  readonly value: string;
}

/**
 * Mirrors `resolveDefaultModel`'s own env precedence (`MUSE_MODEL`, then the
 * legacy `MUSE_DEFAULT_MODEL`) so a caller can tell the user honestly
 * whether an env var — not the config file a switch is about to write —
 * is what actually wins for THIS process.
 */
export function activeModelEnvOverride(env: MuseEnvironment): ModelEnvOverride | undefined {
  const model = env.MUSE_MODEL?.trim();
  if (model) {
    return { key: "MUSE_MODEL", value: model };
  }
  const legacy = env.MUSE_DEFAULT_MODEL?.trim();
  if (legacy) {
    return { key: "MUSE_DEFAULT_MODEL", value: legacy };
  }
  return undefined;
}

export type ModelSwitchResolution =
  | { readonly ok: true; readonly tag: string; readonly modelId: string }
  | { readonly ok: false; readonly reason: "unreachable"; readonly message: string }
  | { readonly ok: false; readonly reason: "cloud-refused"; readonly message: string }
  | {
      readonly ok: false;
      readonly reason: "unknown";
      readonly message: string;
      readonly suggestion?: string;
      readonly installedSample: readonly string[];
    };

function bareOllamaTagOf(requested: string): string {
  return requested.trim().replace(/^ollama\//iu, "");
}

/**
 * The ONE validation both `muse model use <name>` and `/model <name>` call
 * — so a name one surface accepts, the other can never reject (or vice
 * versa). Ollama-only for now (R3-3 scope, see the handoff's "out of
 * scope"): a bare tag or an `ollama/<tag>` spec is checked against what
 * `fetchInstalledOllamaModels` reports actually pulled.
 *
 * A cloud provider spec (`gemini/…`, `anthropic/…`, `openai/…`, …) is
 * refused BEFORE any network probe when `localOnly` is set, via the SAME
 * deterministic classifier `createModelProvider` itself enforces
 * (`classifyProviderLocality`) — never a generic "not installed" that
 * would misleadingly nudge the user toward trying a different Ollama tag
 * name instead of telling them why it's actually refused.
 */
export async function resolveModelSwitchTarget(params: {
  readonly requestedModel: string;
  readonly baseUrl: string;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly localOnly?: boolean;
}): Promise<ModelSwitchResolution> {
  const requested = params.requestedModel.trim();
  const bareTag = bareOllamaTagOf(requested);

  if (params.localOnly) {
    const providerId = requested.includes("/") && !requested.toLowerCase().startsWith("ollama/")
      ? requested.split("/")[0]!.toLowerCase()
      : "ollama";
    if (classifyProviderLocality(providerId, undefined) !== "local") {
      return {
        message:
          `Refused: MUSE_LOCAL_ONLY is on and '${requested}' resolves to the cloud provider ` +
          `'${providerId}' — switch to a local Ollama model instead, or unset MUSE_LOCAL_ONLY.`,
        ok: false,
        reason: "cloud-refused"
      };
    }
  }

  const fetched = await fetchInstalledOllamaModels(params.baseUrl, params.fetchImpl ?? globalThis.fetch);
  if (!fetched.ok) {
    return {
      message: `Ollama is not reachable at ${params.baseUrl} — no model was changed (${fetched.error}).`,
      ok: false,
      reason: "unreachable"
    };
  }

  const names = fetched.models.map((m) => m.name);
  const nameSet = new Set(names);
  // Ollama's implicit `:latest` tag — accept either spelling on either side.
  const matched = nameSet.has(bareTag)
    ? bareTag
    : nameSet.has(`${bareTag}:latest`)
      ? `${bareTag}:latest`
      : bareTag.endsWith(":latest") && nameSet.has(bareTag.slice(0, -":latest".length))
        ? bareTag.slice(0, -":latest".length)
        : undefined;

  if (matched) {
    return { modelId: `ollama/${matched}`, ok: true, tag: matched };
  }

  const suggestion = closestCommandName(bareTag, names);
  return {
    ...(suggestion ? { suggestion } : {}),
    installedSample: names.slice(0, 10),
    message: names.length === 0
      ? `No models are installed in Ollama at ${params.baseUrl} — run \`ollama pull ${bareTag}\` first.`
      : `'${requested}' is not installed in Ollama at ${params.baseUrl}.`,
    ok: false,
    reason: "unknown"
  };
}

export interface MuseCliDefaultModelConfig {
  readonly apiUrl?: string;
  readonly defaultModel?: string;
}

function isNodeErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

/**
 * Reads `~/.config/muse/config.json` — the same shape `apps/cli/src/
 * program-config.ts`'s `readConfigStore` reads, reimplemented here (rather
 * than imported) because apps/api cannot depend on apps/cli. An absent file
 * is `{}` (fresh install), matching `readConfigStore`'s ENOENT handling.
 */
export async function readMuseCliConfigFile(filePath: string): Promise<MuseCliDefaultModelConfig> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = parseJson(raw);
    if (parsed === undefined) {
      throw new Error(`config file is not valid JSON: ${filePath} — fix or delete it`);
    }
    if (!isRecord(parsed)) {
      throw new Error(`config file is not a JSON object: ${filePath} — fix or delete it`);
    }
    return {
      ...(typeof parsed.apiUrl === "string" && parsed.apiUrl.trim().length > 0 ? { apiUrl: parsed.apiUrl } : {}),
      ...(typeof parsed.defaultModel === "string" && parsed.defaultModel.trim().length > 0
        ? { defaultModel: parsed.defaultModel }
        : {})
    };
  } catch (error) {
    if (isNodeErrnoException(error) && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

/**
 * Atomic read-merge-write of ONLY `defaultModel` — preserves `apiUrl` (or
 * any other key a future version adds) untouched. Same tmp+rename+chmod
 * 0600 pattern as `program-config.ts`'s `writeConfigStore` (crash-safe: a
 * crash mid-write never truncates the user's config.json). The ONE write
 * implementation `muse model use` and `/model <name>` both call.
 */
export async function writeMuseCliDefaultModel(filePath: string, defaultModel: string): Promise<MuseCliDefaultModelConfig> {
  const current = await readMuseCliConfigFile(filePath);
  const next: MuseCliDefaultModelConfig = { ...current, defaultModel };
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid.toString()}-${randomBytes(8).toString("hex")}`;
  try {
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, filePath);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  await chmod(filePath, 0o600).catch(() => undefined);
  return next;
}
