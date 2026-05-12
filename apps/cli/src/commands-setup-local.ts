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

import type { Command } from "commander";

import type { ConfigCommandHelpers } from "./commands-config.js";
import type { ProgramIO } from "./program.js";

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
    approxSizeGb: 1.0,
    minRamGb: 4,
    note: "lowest; proven JARVIS-fit (90 ms first-token on M3 Pro); Qwen 2.5 used because qwen3.5:0.8b is Q8-only and times out",
    tag: "qwen2.5:1.5b-instruct",
    tier: "low"
  },
  {
    approxSizeGb: 1.9,
    minRamGb: 6,
    note: "mid; balanced JARVIS surface, good Korean",
    tag: "qwen3.5:2b-q4_K_M",
    tier: "mid"
  },
  {
    approxSizeGb: 6.6,
    minRamGb: 12,
    note: "high; recommended JARVIS daily-driver, stable tool calling",
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
 * Default Ollama tags for Qwen 3.5 sizes ship with Q8_0 quantisation
 * (2× the disk + ~3× the inference latency of Q4_K_M for the same
 * weights). Dogfood on M3 Pro: `qwen3.5:2b` first-token = 134 s,
 * `qwen3.5:2b-q4_K_M` first-token < 500 ms. The presets always use
 * the `-q4_K_M` suffix so users don't accidentally pull the slow
 * variant.
 */

export interface SetupLocalHelpers {
  readonly readConfigStore: ConfigCommandHelpers["readConfigStore"];
  readonly writeConfigStore: ConfigCommandHelpers["writeConfigStore"];
}

interface OllamaTag {
  readonly name: string;
  readonly size?: number;
}

async function fetchOllamaTags(baseUrl: string): Promise<readonly OllamaTag[] | undefined> {
  try {
    const resp = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!resp.ok) return undefined;
    const body = (await resp.json()) as { models?: readonly OllamaTag[] };
    return body.models ?? [];
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
  // Default picker: highest tier already pulled, else highest tier overall
  // so the user sees the "you should pull this" hint.
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
