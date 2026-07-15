/**
 * `muse setup cloud` — the BYO-key onboarding wizard for a CLOUD LLM (Gemini / OpenAI /
 * Anthropic / OpenRouter). Muse is provider-neutral under the hood and ships local-by-default
 * (architecture.md); this is the easy on-ramp to the OTHER side of that contract. It writes the
 * chosen `defaultModel` to the CLI config, then tells you EXACTLY which env to set — the API
 * key and `MUSE_LOCAL_ONLY=false` stay in the environment (Muse never persists a cloud key to
 * plaintext config — cli-product.md), so the wizard plans + guides rather than storing secrets.
 */

import type { Command } from "commander";

import { parseBooleanFromEnv } from "@muse/shared";
import type { ConfigCommandHelpers } from "./commands-config.js";
import type { ProgramIO } from "./program.js";

export interface SetupCloudHelpers {
  readonly readConfigStore: ConfigCommandHelpers["readConfigStore"];
  readonly writeConfigStore: ConfigCommandHelpers["writeConfigStore"];
}

export interface CloudProvider {
  readonly id: string;
  readonly label: string;
  /** The model spec written to config when no `--model` is given (`<providerId>/<model>`). */
  readonly defaultModel: string;
  /** Accepted key env vars, canonical first (matches the model router's key detection). */
  readonly keyEnvVars: readonly string[];
}

export const CLOUD_PROVIDERS: readonly CloudProvider[] = [
  { defaultModel: "gemini/gemini-2.0-flash", id: "gemini", keyEnvVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], label: "Google Gemini" },
  { defaultModel: "openai/gpt-4o-mini", id: "openai", keyEnvVars: ["OPENAI_API_KEY"], label: "OpenAI" },
  { defaultModel: "anthropic/claude-haiku-4-5-20251001", id: "anthropic", keyEnvVars: ["ANTHROPIC_API_KEY"], label: "Anthropic Claude" },
  { defaultModel: "openrouter/google/gemini-2.0-flash-001", id: "openrouter", keyEnvVars: ["OPENROUTER_API_KEY"], label: "OpenRouter" }
];

export interface CloudSetupPlan {
  readonly provider: CloudProvider;
  /** The `defaultModel` to write to config. */
  readonly defaultModel: string;
  readonly keyPresent: boolean;
  readonly localOnlyDisabled: boolean;
  /** Shell `export` lines the user still has to set for the cloud path to actually run. */
  readonly requiredExports: readonly string[];
}

/**
 * Plan a cloud setup: resolve the model spec + detect what the cloud path NEEDS from the
 * environment. Cloud is allowed by default, so the only hard requirement is the provider's
 * API key — `MUSE_LOCAL_ONLY` only matters when it is explicitly `true` (which blocks cloud
 * and must be unset). Pure — `undefined` for an unknown provider id.
 */
export function planCloudSetup(providerId: string, env: NodeJS.ProcessEnv, modelOverride?: string): CloudSetupPlan | undefined {
  const provider = CLOUD_PROVIDERS.find((p) => p.id === providerId);
  if (!provider) return undefined;
  const defaultModel = modelOverride?.trim() ? `${provider.id}/${modelOverride.trim()}` : provider.defaultModel;
  const keyPresent = provider.keyEnvVars.some((k) => (env[k] ?? "").trim().length > 0);
  // Cloud egress is permitted unless local-only is explicitly forced on.
  const localOnlyForced = parseBooleanFromEnv(env.MUSE_LOCAL_ONLY, false);
  const localOnlyDisabled = !localOnlyForced;
  const requiredExports: string[] = [];
  if (localOnlyForced) requiredExports.push("unset MUSE_LOCAL_ONLY");
  if (!keyPresent) requiredExports.push(`export ${provider.keyEnvVars[0]!}=<your-key>`);
  return { defaultModel, keyPresent, localOnlyDisabled, provider, requiredExports };
}

/**
 * Guidance shown after a cloud setup so the user knows privacy-tiered routing exists: with
 * `MUSE_PRIVACY_ROUTING=true`, only context-free requests ride the cloud model — anything
 * carrying persona/memory/PII/possessive markers stays local (`@muse/policy`
 * `resolvePrivacyRoutedModel`). `MUSE_LOCAL_ONLY=true` still overrides everything to local.
 */
export function cloudPrivacyRoutingGuidance(cloudModel: string): string {
  return `Privacy-tiered routing (optional): set MUSE_PRIVACY_ROUTING=true and MUSE_CLOUD_MODEL=${cloudModel}
to send ONLY context-free requests to the cloud model — anything with your persona, memory,
PII, or possessive markers ("my", "I") stays on the LOCAL model instead.
MUSE_LOCAL_ONLY=true still overrides all of this back to fully local.
`;
}

export function registerSetupCloudCommand(program: Command, io: ProgramIO, helpers: SetupCloudHelpers): void {
  const setupRoot = program.commands.find((cmd) => cmd.name() === "setup");
  if (!setupRoot) {
    throw new Error("registerSetupCloudCommand: 'setup' command group must be registered first.");
  }
  setupRoot
    .command("cloud")
    .description("Wire Muse to a cloud LLM (Gemini / OpenAI / Anthropic / OpenRouter) — BYO API key")
    .addHelpText("after", `
Examples:
  $ muse setup cloud --provider gemini --check      # report readiness only; don't write config
  $ muse setup cloud --provider gemini              # use Gemini (needs GEMINI_API_KEY)
  $ muse setup cloud --provider openai --model gpt-4o-mini`)
    .requiredOption("--provider <id>", `Provider: ${CLOUD_PROVIDERS.map((p) => p.id).join(" | ")}`)
    .option("--model <model>", "Model name (provider default if omitted)")
    .option("--check", "Report readiness only; do not write config")
    .action(async (options: { readonly provider: string; readonly model?: string; readonly check?: boolean }) => {
      const plan = planCloudSetup(options.provider, process.env, options.model);
      if (!plan) {
        io.stderr(`muse setup cloud: unknown provider '${options.provider}'. One of: ${CLOUD_PROVIDERS.map((p) => p.id).join(", ")}\n`);
        process.exitCode = 1;
        return;
      }
      io.stdout(`Provider: ${plan.provider.label}\nModel:    ${plan.defaultModel}\n`);
      if (options.check) {
        io.stdout("  --check mode: not writing config.\n");
      } else {
        const config = await helpers.readConfigStore(io);
        await helpers.writeConfigStore(io, { ...config, defaultModel: plan.defaultModel });
        io.stdout(`Wrote defaultModel=${plan.defaultModel} to CLI config.\n`);
      }
      if (plan.requiredExports.length === 0) {
        io.stdout(`\n✅ Ready — your key is set and MUSE_LOCAL_ONLY=false. Try: muse ask "hello"\n`);
      } else {
        io.stdout("\nTo finish, set these in your shell (Muse keeps cloud keys in the ENV, never in plaintext config):\n");
        for (const line of plan.requiredExports) io.stdout(`  ${line}\n`);
      }
      io.stdout("\nLocal stays the shipped default; this only applies while MUSE_LOCAL_ONLY=false. Revert anytime: muse setup local\n");
      io.stdout(`\n${cloudPrivacyRoutingGuidance(plan.defaultModel)}`);
    });
}
