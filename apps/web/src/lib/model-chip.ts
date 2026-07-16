/**
 * Local-vs-cloud is Muse's trust floor, so the CURRENT model is chrome, not
 * a settings detail. This classifies a `provider/model` target for the
 * persistent composer chip. Client-side mirror of the id-based half of
 * `classifyProviderLocality` (packages/model/local-only-policy.ts); the
 * URL-locality half (a REMOTE ollama host counts as cloud) is not knowable
 * here, so unknown providers render with no locality claim rather than a
 * guessed one.
 */

export type ChipLocality = "local" | "cloud" | "unknown";

const LOCAL_PROVIDER_IDS = new Set(["ollama", "lmstudio", "diagnostic"]);
const CLOUD_PROVIDER_IDS = new Set(["openai", "anthropic", "gemini", "openrouter"]);

export interface ModelChip {
  /** Short display name — the model id without the provider prefix. */
  readonly name: string;
  readonly locality: ChipLocality;
}

export function modelChip(defaultModel: string | undefined): ModelChip | undefined {
  const target = defaultModel?.trim();
  if (!target) {
    return undefined;
  }
  const slash = target.indexOf("/");
  if (slash <= 0 || slash === target.length - 1) {
    return { locality: "unknown", name: target };
  }
  const provider = target.slice(0, slash).toLowerCase();
  const name = target.slice(slash + 1);
  const locality: ChipLocality = LOCAL_PROVIDER_IDS.has(provider)
    ? "local"
    : CLOUD_PROVIDER_IDS.has(provider)
      ? "cloud"
      : "unknown";
  return { locality, name };
}
