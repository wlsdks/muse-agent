export interface OllamaModelDescriptor {
  readonly name: string;
  readonly size?: number;
}

export interface OllamaModelProbeResult {
  readonly reachable: boolean;
  readonly models: readonly OllamaModelDescriptor[];
  readonly status?: number;
}

const OLLAMA_TIMEOUT_MS = 3_000;

interface OllamaModelsResponse {
  readonly models?: readonly unknown[];
}

interface RawOllamaModel {
  readonly name?: unknown;
  readonly model?: unknown;
  readonly size?: unknown;
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
