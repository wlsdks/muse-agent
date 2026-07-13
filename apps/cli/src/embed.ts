/**
 * CLI binding of `@muse/recall`'s embedding helper: every CLI embed call
 * resolves the Ollama host through `resolveOllamaUrl` (env merged with
 * `muse setup model`'s `~/.muse/models.json`), which the package cannot do
 * itself (it must not depend on `@muse/autoconfigure` — that would cycle).
 */

import { embed as embedCore, type EmbedOptions } from "@muse/recall";
import { isLocalOnlyEnabled } from "@muse/model";
import type { MuseEnvironment } from "@muse/autoconfigure";

import { resolveOllamaUrl } from "./ollama-url.js";

export { cosineSimilarity, DEFAULT_EMBED_TIMEOUT_MS, type EmbedOptions } from "@muse/recall";

export async function embed(
  text: string,
  model: string,
  options: EmbedOptions = {},
  env: MuseEnvironment = process.env
): Promise<number[]> {
  // Never let an injected false option weaken a process-level local-only
  // posture. The supplied env is also authoritative for the URL resolver so
  // an MCP composition does not drift back to ambient process.env.
  const requireLocalOnly = isLocalOnlyEnabled(process.env)
    || isLocalOnlyEnabled(env)
    || options.requireLocalOnly === true;
  return embedCore(text, model, {
    baseUrlResolver: () => resolveOllamaUrl(env),
    ...options,
    ...(requireLocalOnly ? { requireLocalOnly: true } : {})
  });
}
