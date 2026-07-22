export interface OllamaModelDescriptor {
  readonly name: string;
  readonly size?: number;
}

export interface OllamaModelProbeResult {
  readonly reachable: boolean;
  readonly models: readonly OllamaModelDescriptor[];
  readonly status?: number;
}

export interface OllamaLoadedModelDescriptor extends OllamaModelDescriptor {
  readonly contextLength?: number;
  readonly expiresAt?: string;
  readonly sizeVram?: number;
}

export type OllamaLoadedModelProbeResult =
  | { readonly reachable: true; readonly models: readonly OllamaLoadedModelDescriptor[] }
  | { readonly reachable: false; readonly models: readonly []; readonly reason: "non-local-url" | "unreachable"; readonly status?: number };

const OLLAMA_TIMEOUT_MS = 3_000;

interface OllamaModelsResponse {
  readonly models?: readonly unknown[];
}

interface RawOllamaModel {
  readonly name?: unknown;
  readonly model?: unknown;
  readonly size?: unknown;
  readonly size_vram?: unknown;
  readonly context_length?: unknown;
  readonly expires_at?: unknown;
}

function toModelDescriptor(raw: unknown): OllamaModelDescriptor | undefined {
  if (raw === null || typeof raw !== "object") {
    return undefined;
  }

  const candidate = raw as RawOllamaModel;
  const rawName = candidate.name ?? candidate.model;
  if (typeof rawName !== "string") {
    return undefined;
  }

  const name = rawName.trim();
  if (name.length === 0) {
    return undefined;
  }

  const rawSize = candidate.size;
  const size = typeof rawSize === "number" && Number.isFinite(rawSize) ? rawSize : undefined;
  return { name, size };
}

function optionalNonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function toLoadedModelDescriptor(raw: unknown): OllamaLoadedModelDescriptor | undefined {
  const base = toModelDescriptor(raw);
  if (!base || raw === null || typeof raw !== "object") return undefined;
  const candidate = raw as RawOllamaModel;
  const sizeVram = optionalNonnegativeInteger(candidate.size_vram);
  const contextLength = optionalNonnegativeInteger(candidate.context_length);
  const expiresAt = typeof candidate.expires_at === "string" && Number.isFinite(Date.parse(candidate.expires_at))
    ? candidate.expires_at
    : undefined;
  return {
    ...base,
    ...(contextLength !== undefined ? { contextLength } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(sizeVram !== undefined ? { sizeVram } : {})
  };
}

function isLoopbackBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return (url.protocol === "http:" || url.protocol === "https:")
      && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  } catch { return false; }
}

/** Read Ollama's loaded-model table only; this endpoint never loads or generates. */
export async function probeOllamaLoadedModels(
  baseUrl: string,
  options?: { readonly fetchImpl?: typeof globalThis.fetch; readonly timeoutMs?: number }
): Promise<OllamaLoadedModelProbeResult> {
  if (!isLoopbackBaseUrl(baseUrl)) return { models: [], reachable: false, reason: "non-local-url" };
  const timeoutMs = options?.timeoutMs ?? OLLAMA_TIMEOUT_MS;
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  try {
    const response = await fetchImpl(`${baseUrl}/api/ps`, {
      method: "GET",
      signal: timeoutMs > 0 && Number.isFinite(timeoutMs) ? AbortSignal.timeout(timeoutMs) : undefined
    });
    if (!response.ok) return { models: [], reachable: false, reason: "unreachable", status: response.status };
    const body = await response.json() as OllamaModelsResponse;
    const models = Array.isArray(body.models)
      ? body.models.map(toLoadedModelDescriptor).filter((entry): entry is OllamaLoadedModelDescriptor => entry !== undefined)
      : [];
    return { models, reachable: true };
  } catch { return { models: [], reachable: false, reason: "unreachable" }; }
}

export async function probeOllamaModels(
  baseUrl: string,
  options?: {
    readonly fetchImpl?: typeof globalThis.fetch;
    readonly timeoutMs?: number;
  }
): Promise<OllamaModelProbeResult> {
  const timeoutMs = options?.timeoutMs ?? OLLAMA_TIMEOUT_MS;
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;

  try {
    const response = await fetchImpl(`${baseUrl}/api/tags`, {
      signal: timeoutMs > 0 && Number.isFinite(timeoutMs) ? AbortSignal.timeout(timeoutMs) : undefined
    });

    if (!response.ok) {
      return { models: [], reachable: false, status: response.status };
    }

    const body = await response.json() as OllamaModelsResponse;
    const models = Array.isArray(body.models)
      ? body.models
        .map(toModelDescriptor)
        .filter((entry): entry is OllamaModelDescriptor => entry !== undefined)
      : [];
    return { models, reachable: true };
  } catch {
    return { models: [], reachable: false };
  }
}
