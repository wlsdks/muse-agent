/**
 * `muse setup local` — wire Muse to a locally-running open-source LLM
 * (Ollama by default).
 *
 * The flow is deliberately minimal:
 *   1. Probe Ollama at $OLLAMA_BASE_URL (default 127.0.0.1:11434).
 *   2. List installed models, classify each as low-spec / high-spec
 *      using `LOCAL_MODEL_PRESETS` below.
 *   3. Pick a default — `--model` if given, else the highest-tier
 *      installed Qwen, else fall back with a helpful pull command.
 *   4. Write `defaultModel = ollama/<model>` to the CLI config so
 *      `muse chat` picks it up next invocation.
 *
 * Non-interactive on purpose. The whole point of this command is to
 * make local-LLM onboarding a single line for a user who is following
 * the README.
 */

import { totalmem } from "node:os";

import { LOCAL_FIRST_DEFAULT_MODEL } from "@muse/autoconfigure";
import type { Command } from "commander";
import { isRecord } from "@muse/shared";

import type { ConfigCommandHelpers } from "./commands-config.js";
import { DEFAULT_EMBED_MODEL } from "./commands-notes-rag.js";
import type { ProgramIO } from "./program.js";

/**
 * Muse's pinned zero-config local model (the bare Ollama tag of
 * `LOCAL_FIRST_DEFAULT_MODEL`). When it is already pulled, `muse setup local`
 * credits it as the ready recommendation instead of pushing a multi-GB
 * power-tier download — kept in sync with the runtime default it mirrors.
 */
export const DOCUMENTED_DEFAULT_TAG = LOCAL_FIRST_DEFAULT_MODEL.replace(/^ollama\//u, "");

const DOCUMENTED_DEFAULT_PRESET: LocalModelPreset = {
  approxSizeGb: 8.1,
  minRamGb: 16,
  note: "default; Muse's pinned zero-config local model — already pulled, balanced quality (no download needed)",
  tag: DOCUMENTED_DEFAULT_TAG,
  tier: "high"
};

export interface LocalModelPreset {
  readonly tier: "low" | "mid" | "high" | "power";
  readonly tag: string;
  readonly approxSizeGb: number;
  readonly minRamGb: number;
  readonly note: string;
}

/**
 * Recommended models, ordered low → power. Qwen 3.5 (Feb–Apr 2026)
 * is the current default family — improved tool calling, native
 * multilingual including Korean, smaller-on-disk than the 2.5 line.
 * Qwen 3.6:27b (Apr 2026) is the open-weight agentic-coding tier
 * for users with ≥ 32 GB RAM.
 *
 * The CLI's default picker walks this list and prefers the highest
 * tier that is *already pulled*; the user always wins by passing
 * `--model <tag>` explicitly. License notes live in
 * `docs/setup-local-llm.md`.
 */
export const LOCAL_MODEL_PRESETS: readonly LocalModelPreset[] = [
  {
    approxSizeGb: 1.9,
    minRamGb: 6,
    note: "low; Qwen 3.5 (Apr 2026), proven 159 ms first-token via OllamaProvider think:false",
    tag: "qwen3.5:2b-q4_K_M",
    tier: "low"
  },
  {
    approxSizeGb: 4.7,
    minRamGb: 8,
    note: "mid; Qwen 2.5 baseline, proven 201 ms first-token + 27 tok/s",
    tag: "qwen2.5:7b-instruct",
    tier: "mid"
  },
  {
    approxSizeGb: 6.6,
    minRamGb: 12,
    note: "high; Qwen 3.5 9b — better reply quality, slightly slower first-token",
    tag: "qwen3.5:9b-q4_K_M",
    tier: "high"
  },
  {
    approxSizeGb: 17.0,
    minRamGb: 32,
    note: "power; Apr 2026 open-weight agentic-coding model, M-Pro 32 GB+",
    tag: "qwen3.6:27b",
    tier: "power"
  }
];

/**
 * Tier ordering rationale (updated after the think:false fix):
 *
 * `OllamaProvider` overrides generate/stream to call Ollama's native
 * `/api/chat` with `think: false`. This kills the chain-of-thought
 * tokens Qwen 3.5+ thinking models emit by default. Before the fix,
 * dogfood saw 134 s first-token for qwen3.5:2b (Q8) / 39 s for Q4 /
 * 5-min timeout for 0.8b. After the fix:
 *
 *   qwen3.5:2b-q4_K_M  : 159 ms first-token  ← new default low tier
 *   qwen2.5:7b-instruct: 201 ms first-token  ← mid (newer 3.5:4b
 *                                              landed but 2.5:7b is
 *                                              the proven safe baseline)
 *   qwen3.5:9b-q4_K_M  : higher quality, ~300-500 ms first-token
 *   qwen3.6:27b        : agentic-coding flagship, ~1-2 s first-token
 *
 * Qwen 3.5 wins the bottom of the table when reasoning is off; the
 * 2.5 family stays as the proven mid-tier baseline. 3.6 has no
 * sub-27 B variant published, so it's power-tier only.
 */

export interface SetupLocalHelpers {
  readonly readConfigStore: ConfigCommandHelpers["readConfigStore"];
  readonly writeConfigStore: ConfigCommandHelpers["writeConfigStore"];
}

interface OllamaTag {
  readonly name: string;
  readonly size?: number;
}

function isOllamaTag(value: unknown): value is OllamaTag {
  if (!isRecord(value)) return false;
  if (typeof value.name !== "string" || value.name.trim().length === 0) return false;
  if (value.size === undefined) return true;
  return typeof value.size === "number" && Number.isFinite(value.size);
}

async function fetchOllamaTags(baseUrl: string): Promise<readonly OllamaTag[] | undefined> {
  try {
    const resp = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!resp.ok) return undefined;
    const body = await resp.json();
    const models = isRecord(body) && Array.isArray(body.models) ? body.models : [];
    return models.filter(isOllamaTag);
  } catch {
    return undefined;
  }
}

export function pickPreset(installed: ReadonlySet<string>, override?: string): LocalModelPreset | undefined {
  if (override && override.length > 0) {
    const stripped = override.replace(/^ollama\//, "");
    const known = LOCAL_MODEL_PRESETS.find((preset) => preset.tag === stripped);
    if (known) return known;
    // Unknown but user-specified tag: trust the user, surface as a
    // synthesized "custom" preset so the install check still runs.
    return {
      approxSizeGb: 0,
      minRamGb: 0,
      note: "user-specified, not in preset list",
      tag: stripped,
      tier: "mid"
    };
  }
  // Credit Muse's pinned local default first: if it is already pulled, that IS
  // the recommendation — never push a multi-GB power-tier download onto a box
  // that already has the zero-config default working.
  if (installed.has(DOCUMENTED_DEFAULT_TAG)) {
    return DOCUMENTED_DEFAULT_PRESET;
  }
  // Otherwise: highest tier already pulled, else highest tier overall so the
  // user sees the "you should pull this" hint.
  const reversed = [...LOCAL_MODEL_PRESETS].reverse();
  for (const preset of reversed) {
    if (installed.has(preset.tag)) {
      return preset;
    }
  }
  return reversed[0];
}

function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return "?";
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * JARVIS-style pre-flight check. Compare available machine RAM
 * against the chosen preset's stated minimum and
 * return a one-liner the action can print before writing config
 * (or pulling a 17 GB model onto an 8 GB laptop).
 *
 * Returns:
 *   - `undefined` when the rig clears the bar (≥ minRamGb).
 *   - `{ severity: "warn", message }` when the rig is below the
 *     stated minimum but the preset is otherwise valid.
 *
 * `machineRamGb` is split out as a parameter so the unit test
 * doesn't need to mock `os.totalmem()`. Caller passes
 * `totalmem() / 1024 ** 3` at runtime.
 */
export function checkPresetRam(
  machineRamGb: number,
  preset: LocalModelPreset
): { readonly severity: "warn"; readonly message: string } | undefined {
  // `minRamGb: 0` means "unknown / custom preset" — skip the
  // check rather than produce a misleading "below 0 GB" warning.
  if (!Number.isFinite(machineRamGb) || machineRamGb <= 0) return undefined;
  if (preset.minRamGb <= 0) return undefined;
  if (machineRamGb >= preset.minRamGb) return undefined;
  return {
    severity: "warn",
    message:
      `Heads up: this machine reports ${machineRamGb.toFixed(1)} GB RAM, ` +
      `but ${preset.tag} wants ≥ ${preset.minRamGb.toString()} GB. ` +
      `Expect slow first-tokens / occasional OOM kills. ` +
      `Drop to a smaller tier (\`muse setup local --model qwen3.5:2b-q4_K_M\`) ` +
      `or close memory-heavy apps before pulling.`
  };
}

/**
 * True when the notes-RAG embedding model is among the pulled
 * Ollama tags. Treats `<model>` and `<model>:latest` as the same
 * identity (Ollama's implicit default tag).
 */
export function isEmbedModelPulled(installedNames: ReadonlySet<string>): boolean {
  return [...installedNames].some(
    (name) => name === DEFAULT_EMBED_MODEL || name === `${DEFAULT_EMBED_MODEL}:latest`
  );
}

export function registerSetupLocalCommand(
  program: Command,
  io: ProgramIO,
  helpers: SetupLocalHelpers
): void {
  const setupRoot = program.commands.find((cmd) => cmd.name() === "setup");
  if (!setupRoot) {
    throw new Error("registerSetupLocalCommand: 'setup' command group must be registered first.");
  }
  setupRoot
    .command("local")
    .description("Wire Muse to a local open-source LLM via Ollama (no API key required)")
    .option("--model <tag>", "Ollama model tag (e.g. qwen2.5:7b-instruct). Default: highest-tier preset already pulled.")
    .option("--base-url <url>", "Ollama endpoint", "http://127.0.0.1:11434")
    .option("--check", "Probe and report only; do not write config")
    .action(async (options: {
      readonly model?: string;
      readonly baseUrl: string;
      readonly check?: boolean;
    }) => {
      const baseUrl = options.baseUrl.replace(/\/+$/, "");
      io.stdout(`Probing Ollama at ${baseUrl}…\n`);

      const tags = await fetchOllamaTags(baseUrl);
      if (!tags) {
        io.stderr("Ollama daemon not reachable.\n");
        io.stderr("\n");
        io.stderr("Install Ollama:\n");
        io.stderr("  macOS:   brew install ollama && ollama serve &\n");
        io.stderr("  Linux:   curl -fsSL https://ollama.com/install.sh | sh\n");
        io.stderr("  Windows: download from https://ollama.com/download\n");
        io.stderr("\n");
        io.stderr("Then re-run: muse setup local\n");
        process.exitCode = 2;
        return;
      }

      const installedNames = new Set(tags.map((tag) => tag.name));
      if (tags.length === 0) {
        io.stdout("  no models installed yet.\n");
      } else {
        io.stdout(`  ${tags.length.toString()} model(s) installed:\n`);
        for (const tag of tags) {
          io.stdout(`    - ${tag.name} (${formatBytes(tag.size)})\n`);
        }
      }

      const chosen = pickPreset(installedNames, options.model);
      if (!chosen) {
        io.stderr("No preset available. Pass --model <tag> explicitly.\n");
        process.exitCode = 2;
        return;
      }

      const alreadyPulled = installedNames.has(chosen.tag);
      io.stdout(`\n`);
      io.stdout(`Recommended: ollama/${chosen.tag}\n`);
      io.stdout(`  tier: ${chosen.tier}  approx ${chosen.approxSizeGb.toFixed(1)} GB on disk, ≥ ${chosen.minRamGb.toString()} GB RAM\n`);
      io.stdout(`  note: ${chosen.note}\n`);

      // Pre-flight RAM check so an 8 GB laptop isn't sent to pull
      // a 17 GB power-tier model.
      const ramWarning = checkPresetRam(totalmem() / (1024 ** 3), chosen);
      if (ramWarning) {
        io.stdout(`  warn: ${ramWarning.message}\n`);
      }

      // The chat model alone leaves `muse ask` / `muse recall`
      // (notes RAG) broken — they need a separate embedding model.
      // Surface it proactively at setup instead of letting the user
      // discover it only when ask silently degrades.
      if (!isEmbedModelPulled(installedNames)) {
        io.stdout(`\n  RAG note: notes/recall grounding needs an embedding model — not pulled.\n`);
        io.stdout(`    ollama pull ${DEFAULT_EMBED_MODEL}\n`);
      }

      if (!alreadyPulled) {
        io.stdout(`\n  not pulled yet. Run:\n`);
        io.stdout(`    ollama pull ${chosen.tag}\n`);
        io.stdout(`  then re-run: muse setup local\n`);
        return;
      }

      if (options.check) {
        io.stdout(`\n  --check mode: not writing config.\n`);
        return;
      }

      const config = await helpers.readConfigStore(io);
      const next = { ...config, defaultModel: `ollama/${chosen.tag}` };
      await helpers.writeConfigStore(io, next);
      io.stdout(`\n`);
      io.stdout(`Wrote defaultModel=ollama/${chosen.tag} to CLI config.\n`);
      io.stdout(`\n`);
      io.stdout(`Next:\n`);
      io.stdout(`  export MUSE_MODEL=ollama/${chosen.tag}   # so the API server picks it up\n`);
      io.stdout(`  muse chat "안녕"\n`);
    });
}
