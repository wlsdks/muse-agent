/**
 * `muse model` — show / switch Muse's default model, validated against what
 * Ollama actually has installed (R3-3). Distinct from `muse models`
 * (plural): that command is a static, offline capability catalog across
 * EVERY provider Muse knows about; this one is a LIVE Ollama probe limited
 * to models you've actually pulled — the two intentionally don't merge.
 *
 * `list` and `use` share their validation + config write with the
 * `/model <name>` channel command (`apps/api/src/inbound-slash-commands.ts`)
 * through `@muse/autoconfigure`'s model-registry — one implementation, two
 * surfaces, so a name one accepts the other can't reject.
 */

import {
  activeModelEnvOverride,
  fetchInstalledOllamaModels,
  LOCAL_FIRST_DEFAULT_MODEL,
  readMuseCliConfigFile,
  resolveDefaultModel,
  resolveModelSwitchTarget,
  resolveOllamaBaseUrl,
  writeMuseCliDefaultModel,
  type InstalledOllamaModel,
  type ModelSwitchResolution
} from "@muse/autoconfigure";
import { isLocalOnlyEnabled } from "@muse/model";
import type { Command } from "commander";

import { configPath } from "./program-config.js";
import type { ProgramIO } from "./program.js";

function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return "?";
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatModified(iso: string | undefined): string {
  if (!iso) return "?";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "?" : date.toISOString().slice(0, 10);
}

export interface CurrentDefaultModel {
  readonly model: string;
  readonly source: string;
}

/**
 * Where Muse's default model comes from RIGHT NOW, in the same precedence
 * `resolveDefaultModel` enforces: an explicit env var always wins over the
 * CLI config file, which wins over the built-in fallback. Exported + pure
 * so the "env beats config, switching config won't take effect" warning
 * (AC1) is unit-testable without a real env or filesystem.
 */
export function resolveCurrentDefaultModel(
  env: Readonly<Record<string, string | undefined>>,
  cliConfigDefaultModel: string | undefined
): CurrentDefaultModel {
  const override = activeModelEnvOverride(env);
  if (override) {
    return { model: override.value, source: `${override.key} env var (wins over CLI config)` };
  }
  if (cliConfigDefaultModel) {
    return { model: cliConfigDefaultModel, source: "CLI config (~/.config/muse/config.json defaultModel)" };
  }
  return {
    model: resolveDefaultModel(env) ?? LOCAL_FIRST_DEFAULT_MODEL,
    source: "built-in default (no MUSE_MODEL/MUSE_DEFAULT_MODEL set, no CLI config default)"
  };
}

/** Renders the `muse model list` body. Pure (no I/O) so it's directly unit-tested. */
export function formatInstalledModels(models: readonly InstalledOllamaModel[], current: CurrentDefaultModel): string {
  const lines = [`Current default: ${current.model}  (source: ${current.source})`, ""];
  if (models.length === 0) {
    lines.push("No models installed in Ollama — run `ollama pull <model>` first.");
    return lines.join("\n");
  }
  lines.push(`Installed in Ollama (${models.length.toString()}):`);
  for (const m of models) {
    const isCurrent = current.model === m.name || current.model === `ollama/${m.name}`;
    lines.push(`  ${isCurrent ? "* " : "  "}${m.name.padEnd(30)} ${formatBytes(m.sizeBytes).padEnd(8)} modified ${formatModified(m.modifiedAt)}`);
  }
  return lines.join("\n");
}

/** Renders the switch-refused reply body for every non-ok `ModelSwitchResolution`. Pure, unit-tested. */
export function formatSwitchFailure(resolution: Extract<ModelSwitchResolution, { readonly ok: false }>): string {
  if (resolution.reason === "unknown") {
    const lines = [resolution.message];
    if (resolution.suggestion) lines.push(`Did you mean '${resolution.suggestion}'?`);
    if (resolution.installedSample.length > 0) lines.push(`Installed: ${resolution.installedSample.join(", ")}`);
    return lines.join("\n");
  }
  return resolution.message;
}

/** Renders the switch-confirmed reply body (old → new + env/daemon caveats). Pure, unit-tested. */
export function formatSwitchConfirmation(params: {
  readonly oldModel: string;
  readonly newModelId: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): string {
  const lines = [`Switched default model: ${params.oldModel} → ${params.newModelId}`];
  const override = activeModelEnvOverride(params.env);
  if (override) {
    lines.push(
      `Note: ${override.key}=${override.value} is set in your shell env and wins over this config — ` +
      `new CLI runs keep using it until you unset it (or pass --model each time). The config file is updated for when you do.`
    );
  } else {
    lines.push(`New \`muse chat\` / \`muse tui\` runs will use ${params.newModelId} immediately.`);
  }
  lines.push(
    `This does NOT change an already-running \`muse daemon\` / API server — that process reads ` +
    `MUSE_MODEL/MUSE_DEFAULT_MODEL from its OWN environment at startup and never reads this config file. ` +
    `Export MUSE_DEFAULT_MODEL=${params.newModelId} in its environment and restart it to change what the daemon itself uses.`
  );
  return lines.join("\n");
}

export interface ModelCommandDeps {
  /** Injected — defaults to the real `globalThis.fetch`. Test seam so `pnpm test` never hits real Ollama. */
  readonly fetchImpl?: typeof globalThis.fetch;
  /** Defaults to `process.env`. Test seam for env-override / local-only scenarios. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** `muse model` / `muse model list`. Exported (not registrar-private) so tests
 *  drive it directly with an injected fetch + isolated `io.configDir`. */
export async function runModelList(io: ProgramIO, deps: ModelCommandDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  const baseUrl = resolveOllamaBaseUrl(env);
  const [config, fetched] = await Promise.all([
    readMuseCliConfigFile(configPath(io)),
    fetchInstalledOllamaModels(baseUrl, deps.fetchImpl)
  ]);
  if (!fetched.ok) {
    io.stderr(`Ollama is not reachable at ${baseUrl} (${fetched.error}).\n`);
    io.stderr("Install/start it: https://ollama.com/download, then `ollama pull <model>`.\n");
    process.exitCode = 2;
    return;
  }
  const current = resolveCurrentDefaultModel(env, config.defaultModel);
  io.stdout(`${formatInstalledModels(fetched.models, current)}\n`);
}

/** `muse model use <name>`. Exported for the same reason as `runModelList`. */
export async function runModelUse(io: ProgramIO, requestedModel: string, deps: ModelCommandDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  const baseUrl = resolveOllamaBaseUrl(env);
  const config = await readMuseCliConfigFile(configPath(io));
  const current = resolveCurrentDefaultModel(env, config.defaultModel);
  const resolution = await resolveModelSwitchTarget({
    baseUrl,
    fetchImpl: deps.fetchImpl,
    localOnly: isLocalOnlyEnabled(env),
    requestedModel
  });
  if (!resolution.ok) {
    io.stderr(`${formatSwitchFailure(resolution)}\n`);
    process.exitCode = 2;
    return;
  }
  await writeMuseCliDefaultModel(configPath(io), resolution.modelId);
  io.stdout(`${formatSwitchConfirmation({ env, newModelId: resolution.modelId, oldModel: current.model })}\n`);
}

export function registerModelCommand(program: Command, io: ProgramIO): void {
  const model = program
    .command("model")
    .description("Show/switch Muse's default model among installed Ollama models (offline catalog across all providers: `muse models`)");

  model
    .command("list", { isDefault: true })
    .description("List installed Ollama models + the current default and where it comes from")
    .action(async () => {
      await runModelList(io);
    });

  model
    .command("use")
    .description("Switch Muse's default model — validated against installed Ollama models (fails closed if not installed / Ollama unreachable)")
    .argument("<name>", "Ollama tag to switch to, e.g. gemma4:12b or ollama/gemma4:12b")
    .action(async (name: string) => {
      await runModelUse(io, name);
    });
}
