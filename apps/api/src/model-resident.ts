/**
 * Model-already-resident guard for the background self-learning brake.
 *
 * The unattended LLM merge must NEVER trigger a multi-GB COLD load of the
 * model in the background — that spikes disk + memory exactly when we're
 * trying to stay invisible. Only run when the model is ALREADY loaded in
 * Ollama (a foreground call warmed it); otherwise defer. Ollama's `/api/ps`
 * lists the currently-resident models. FAIL-CLOSED: any fetch/parse error (or
 * Ollama down) ⇒ treat the model as NOT resident, so we never cold-load
 * unattended.
 */

/** The bit of Ollama's `/api/ps` payload we care about. */
interface OllamaPsResponse {
  readonly models?: ReadonlyArray<{ readonly name?: string; readonly model?: string }>;
}

/** Last path segment, with any `provider/` prefix dropped (`ollama/qwen3:8b` → `qwen3:8b`). */
function normalizeModel(name: string): string {
  const trimmed = name.trim();
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/** Resident model names from a parsed `/api/ps` body. Tolerant of shape drift. */
export function parseResidentModels(body: unknown): string[] {
  const models = (body as OllamaPsResponse | null)?.models;
  if (!Array.isArray(models)) {
    return [];
  }
  const names = new Set<string>();
  for (const m of models) {
    if (typeof m?.name === "string" && m.name.length > 0) names.add(m.name);
    if (typeof m?.model === "string" && m.model.length > 0) names.add(m.model);
  }
  return [...names];
}

/** True iff `model` (any `provider/` prefix ignored) is among the resident names. */
export function isModelResident(model: string, residentNames: readonly string[]): boolean {
  const want = normalizeModel(model);
  return residentNames.some((n) => normalizeModel(n) === want);
}

/** `/api/ps` base — strips a trailing `/v1` (the OpenAI-compat suffix). */
function psUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/u, "").replace(/\/v1$/u, "")}/api/ps`;
}

/**
 * Whether `model` is currently resident in Ollama at `baseUrl`. FAIL-CLOSED:
 * returns false on any fetch/parse error or non-OK response, so the daemon
 * never cold-loads the model unattended. The `fetchImpl` seam lets tests
 * inject a response without a live server.
 */
export async function isModelResidentLive(
  model: string,
  baseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
  fetchImpl: typeof globalThis.fetch = globalThis.fetch
): Promise<boolean> {
  try {
    const res = await fetchImpl(psUrl(baseUrl));
    if (!res.ok) {
      return false;
    }
    return isModelResident(model, parseResidentModels(await res.json()));
  } catch {
    return false;
  }
}
