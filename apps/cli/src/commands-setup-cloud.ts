/**
 * `muse setup cloud` — the BYO-key onboarding wizard for a CLOUD LLM (Gemini / OpenAI /
 * Anthropic / OpenRouter). Muse is provider-neutral under the hood and ships local-by-default
 * (architecture.md); this is the easy on-ramp to the OTHER side of that contract. It writes the
 * chosen `defaultModel` to the CLI config, then tells you EXACTLY which env to set — the API
 * key and `MUSE_LOCAL_ONLY=false` stay in the environment (Muse never persists a cloud key to
 * plaintext config — cli-product.md), so the wizard plans + guides rather than storing secrets.
 */

import { confirm, isCancel } from "@clack/prompts";
import { resolveModelProvider } from "@muse/autoconfigure";
import { inspectLocalOnlyEnvironmentSetting } from "@muse/model";
import type { Command } from "commander";

import type { ConfigCommandHelpers } from "./commands-config.js";
import type { ProgramIO } from "./program.js";

export interface SetupCloudHelpers {
  readonly confirmEgress?: (message: string) => Promise<boolean>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly isInteractive?: () => boolean;
  readonly readConfigStore: ConfigCommandHelpers["readConfigStore"];
  readonly writeConfigStore: ConfigCommandHelpers["writeConfigStore"];
}

export interface CloudProvider {
  readonly id: string;
  readonly label: string;
  /** Current built-in adapter endpoint, for a truthful setup-time projection only. */
  readonly defaultBaseUrl: string;
  /** The model spec written to config when no `--model` is given (`<providerId>/<model>`). */
  readonly defaultModel: string;
  /** Provider-specific key env vars; the generic MUSE_MODEL_API_KEY is also accepted. */
  readonly keyEnvVars: readonly string[];
}

export const CLOUD_PROVIDERS: readonly CloudProvider[] = [
  {
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini/gemini-2.0-flash",
    id: "gemini",
    keyEnvVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    label: "Google Gemini"
  },
  {
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "openai/gpt-4o-mini",
    id: "openai",
    keyEnvVars: ["OPENAI_API_KEY"],
    label: "OpenAI"
  },
  {
    defaultBaseUrl: "https://api.anthropic.com/v1",
    defaultModel: "anthropic/claude-haiku-4-5-20251001",
    id: "anthropic",
    keyEnvVars: ["ANTHROPIC_API_KEY"],
    label: "Anthropic Claude"
  },
  {
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openrouter/google/gemini-2.0-flash-001",
    id: "openrouter",
    keyEnvVars: ["OPENROUTER_API_KEY"],
    label: "OpenRouter"
  }
];

export const CLOUD_EGRESS_FIELD_CLASSES = [
  "messages: system, user, assistant, and tool content",
  "conversation and personal context, when present",
  "tool schemas, calls, and results",
  "attachments (inline data or provider-fetchable URLs)",
  "generation and structured-output settings"
] as const;

export interface CloudSetupPlan {
  readonly provider: CloudProvider;
  /** The `defaultModel` to write to config. */
  readonly defaultModel: string;
  readonly keyPresent: boolean;
  readonly localOnlyDisabled: boolean;
  /** Shell `export` lines the user still has to set for the cloud path to actually run. */
  readonly requiredExports: readonly string[];
}

export interface CloudEgressPreview {
  readonly activeProviderId: string;
  readonly customBaseUrl: boolean;
  readonly effectiveBaseUrl: string;
  readonly fieldClasses: typeof CLOUD_EGRESS_FIELD_CLASSES;
  readonly locality: "cloud" | "local";
  readonly model: string;
  readonly selectedProvider: CloudProvider;
}

/**
 * Plan a cloud setup: resolve the model spec + detect what the cloud path NEEDS from the
 * environment. Cloud is allowed by default, so the only hard requirement is the provider's
 * API key — `MUSE_LOCAL_ONLY` only matters when it is explicitly `true` (which blocks cloud
 * and must be unset). Pure — `undefined` for an unknown provider id.
 */
export function planCloudSetup(
  providerId: string,
  env: Readonly<Record<string, string | undefined>>,
  modelOverride?: string
): CloudSetupPlan | undefined {
  const provider = CLOUD_PROVIDERS.find((p) => p.id === providerId);
  if (!provider) return undefined;
  const defaultModel = modelOverride?.trim() ? `${provider.id}/${modelOverride.trim()}` : provider.defaultModel;
  const keyPresent = (env.MUSE_MODEL_API_KEY ?? "").trim().length > 0
    || provider.keyEnvVars.some((k) => (env[k] ?? "").trim().length > 0);
  // Cloud egress is permitted unless local-only is explicitly forced on.
  const localOnlyForced = inspectLocalOnlyEnvironmentSetting(env) === "enabled";
  const localOnlyDisabled = !localOnlyForced;
  const requiredExports: string[] = [];
  if (localOnlyForced) requiredExports.push("unset MUSE_LOCAL_ONLY");
  if (!keyPresent) requiredExports.push(`export ${provider.keyEnvVars[0]!}=<your-key>`);
  return { defaultModel, keyPresent, localOnlyDisabled, provider, requiredExports };
}

/**
 * Remove every URL component that can carry credentials while retaining the
 * endpoint identity needed for informed consent. Malformed input is never
 * echoed because it may itself contain a secret.
 */
export function sanitizeBaseUrlForDisplay(raw: string): string {
  const value = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(value) ? value : `http://${value}`;
  try {
    const parsed = new URL(withScheme);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    return "<invalid URL>";
  }
}

/**
 * Project the target through the same provider/locality resolver used by the
 * runtime. `MUSE_LOCAL_ONLY` is disabled only inside this non-networking
 * projection so the command can describe the target before separately
 * enforcing the user's original local-only posture.
 */
export function planCloudEgressPreview(
  plan: CloudSetupPlan,
  env: Readonly<Record<string, string | undefined>>
): CloudEgressPreview {
  const projectedEnv = {
    ...env,
    MUSE_LOCAL_ONLY: "false",
    MUSE_MODEL: plan.defaultModel
  };
  const resolution = resolveModelProvider(projectedEnv);
  if (!resolution) {
    throw new Error(`Unable to resolve the projected model provider for ${plan.defaultModel}`);
  }
  const overrideValue = env.MUSE_MODEL_BASE_URL?.trim();
  const override = overrideValue ? overrideValue : undefined;
  const activeProvider = CLOUD_PROVIDERS.find((provider) => provider.id === resolution.provider.id);
  const effectiveBaseUrl = override
    ?? activeProvider?.defaultBaseUrl
    ?? (resolution.provider.id === "ollama"
      ? resolveOllamaProjectionBaseUrl(env.OLLAMA_BASE_URL)
      : "<provider-managed default>");
  return {
    activeProviderId: resolution.provider.id,
    customBaseUrl: override !== undefined,
    effectiveBaseUrl: effectiveBaseUrl.startsWith("<")
      ? effectiveBaseUrl
      : sanitizeBaseUrlForDisplay(effectiveBaseUrl),
    fieldClasses: CLOUD_EGRESS_FIELD_CLASSES,
    locality: resolution.locality,
    model: plan.defaultModel,
    selectedProvider: plan.provider
  };
}

function resolveOllamaProjectionBaseUrl(raw: string | undefined): string {
  const trimmed = raw?.trim().replace(/\/+$/u, "");
  if (!trimmed) return "http://127.0.0.1:11434/v1";
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

export function renderCloudEgressPreview(preview: CloudEgressPreview): string {
  return [
    "Model data-flow / egress preview (no request has been sent):",
    `  Selected provider: ${preview.selectedProvider.label} (${preview.selectedProvider.id})`,
    `  Active provider:   ${preview.activeProviderId}`,
    `  Model:             ${preview.model}`,
    `  Effective base URL: ${preview.effectiveBaseUrl}`,
    `  Canonical locality: ${preview.locality}`,
    "  Possible outbound field classes:",
    ...preview.fieldClasses.map((fieldClass) => `    - ${fieldClass}`),
    "  Default model traffic may include any applicable class above; it is not privacy-tiered.",
    ""
  ].join("\n");
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
  $ muse setup cloud --provider gemini              # preview, confirm, then configure interactively
  $ muse setup cloud --provider openai --model gpt-4o-mini --accept-egress  # explicit scripted consent`)
    .requiredOption("--provider <id>", `Provider: ${CLOUD_PROVIDERS.map((p) => p.id).join(" | ")}`)
    .option("--model <model>", "Model name (provider default if omitted)")
    .option("--check", "Report readiness only; do not write config")
    .option("--accept-egress", "Explicitly accept the displayed cloud-model egress for scripting")
    .action(async (options: {
      readonly acceptEgress?: boolean;
      readonly check?: boolean;
      readonly model?: string;
      readonly provider: string;
    }) => {
      const env = helpers.env ?? process.env;
      const plan = planCloudSetup(options.provider, env, options.model);
      if (!plan) {
        io.stderr(`muse setup cloud: unknown provider '${options.provider}'. One of: ${CLOUD_PROVIDERS.map((p) => p.id).join(", ")}\n`);
        process.exitCode = 1;
        return;
      }
      const preview = planCloudEgressPreview(plan, env);
      io.stdout(renderCloudEgressPreview(preview));

      if (options.check) {
        io.stdout("  --check mode: not writing config.\n");
      }

      const localOnlySetting = inspectLocalOnlyEnvironmentSetting(env);
      if (localOnlySetting === "enabled") {
        io.stderr("muse setup cloud: refused — MUSE_LOCAL_ONLY=true conflicts with this target. No config was applied; resolve the posture explicitly before retrying.\n");
        process.exitCode = 1;
        return;
      }
      if (localOnlySetting === "invalid") {
        io.stderr("muse setup cloud: refused — MUSE_LOCAL_ONLY must be unset or an explicit true/false value. No config was applied.\n");
        process.exitCode = 1;
        return;
      }

      if (options.check) {
        renderCloudSetupReadiness(io, plan, preview, false);
        io.stdout(`\n${cloudPrivacyRoutingGuidance(plan.defaultModel)}`);
        return;
      }

      if (!options.acceptEgress) {
        const isInteractive = helpers.isInteractive?.() ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
        if (!isInteractive) {
          io.stderr("muse setup cloud: not applied — non-interactive use requires --accept-egress after reviewing the preview.\n");
          process.exitCode = 1;
          return;
        }
        const confirmEgress = helpers.confirmEgress ?? (async (message: string) => {
          const answer = await confirm({ initialValue: false, message });
          return !isCancel(answer) && answer === true;
        });
        if (!await confirmEgress("Apply this configuration and allow future model requests to use the displayed endpoint?")) {
          io.stdout("Cloud setup cancelled; no config was written and no provider request was made.\n");
          process.exitCode = 1;
          return;
        }
      }

      const config = await helpers.readConfigStore(io);
      await helpers.writeConfigStore(io, { ...config, defaultModel: plan.defaultModel });
      io.stdout(`Wrote defaultModel=${plan.defaultModel} to CLI config.\n`);
      renderCloudSetupReadiness(io, plan, preview, true);
      io.stdout("\nLocal remains available; revert anytime with: muse setup local\n");
      io.stdout(`\n${cloudPrivacyRoutingGuidance(plan.defaultModel)}`);
    });
}

function renderCloudSetupReadiness(
  io: ProgramIO,
  plan: CloudSetupPlan,
  preview: CloudEgressPreview,
  applied: boolean
): void {
  if (preview.customBaseUrl) {
    const credentialGuidance = preview.activeProviderId === "openai-compatible"
      ? "If it requires authentication, the active openai-compatible adapter reads MUSE_MODEL_API_KEY or OPENAI_API_KEY."
      : `Credential environment for the active '${preview.activeProviderId}' adapter was not inferred.`;
    io.stdout(
      "\nCustom endpoint credential requirements were not probed. "
      + `${credentialGuidance} Credential validity is not checked by this command.\n`
    );
    return;
  }
  if (plan.requiredExports.length === 0) {
    const status = applied ? "Configured" : "Ready to configure";
    io.stdout(`\n✅ ${status} — your key is set. Future model requests may use the displayed endpoint. Try: muse ask "hello"\n`);
  } else {
    io.stdout("\nTo finish, set these in your shell (Muse keeps cloud keys in the ENV, never in plaintext config):\n");
    for (const line of plan.requiredExports) io.stdout(`  ${line}\n`);
  }
}
