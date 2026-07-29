/**
 * Read-only first-run preflight for `muse onboard --preflight --json`.
 *
 * This is intentionally narrower than `muse doctor`: it establishes that a
 * caller can use an explicitly isolated state root before any wizard, model
 * probe, daemon install, or config write is offered.  In particular, it never
 * creates a probe file to test writability.
 */

import { constants as fsConstants, promises as fs } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { LOCAL_FIRST_DEFAULT_MODEL, resolveDefaultModel, resolveModelProvider } from "@muse/autoconfigure";

import { defaultDaemonTemporaryRoots, validateDaemonCliEntry } from "./commands-daemon-autostart.js";
import { cloudSyncFolderCheck, volatileMountCheck } from "./commands-doctor-checks.js";
import { SETUP_MODEL_PROVIDER_SPECS } from "./setup-model.js";

type PreflightStatus = "ok" | "action";

export interface OnboardPreflightCheck {
  readonly id: "cli-entry" | "muse-home" | "model-provider";
  readonly status: PreflightStatus;
  readonly detail: string;
}

export interface OnboardPreflightReport {
  readonly schemaVersion: "muse.onboard-preflight/v1";
  readonly ready: boolean;
  readonly checks: readonly OnboardPreflightCheck[];
  readonly museHome?: string;
  readonly model: string;
  readonly provider?: string;
  readonly locality?: "cloud" | "local";
  /** Names only: credential values are deliberately never included. */
  readonly configuredProviders: readonly string[];
}

export interface OnboardPreflightFs {
  readonly access: (path: string, mode: number) => Promise<void>;
  readonly lstat: (path: string) => Promise<{ isDirectory(): boolean }>;
}

export interface OnboardPreflightOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cliEntry?: string;
  readonly temporaryRoots?: readonly string[];
  /** Test seam for MUSE_HOME's temporary-root rejection. */
  readonly museHomeTemporaryRoots?: readonly string[];
  readonly fileSystem?: OnboardPreflightFs;
  readonly platform?: NodeJS.Platform;
  readonly readMounts?: () => Promise<string>;
}

const defaultFileSystem: OnboardPreflightFs = {
  access: (path, mode) => fs.access(path, mode),
  lstat: (path) => fs.lstat(path)
};

function messageOf(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

async function nearestCreatableParent(
  target: string,
  fileSystem: OnboardPreflightFs
): Promise<{ readonly ok: boolean; readonly parent?: string }> {
  let candidate = target;
  for (;;) {
    try {
      const stat = await fileSystem.lstat(candidate);
      if (!stat.isDirectory()) return { ok: false };
      await fileSystem.access(candidate, fsConstants.W_OK | fsConstants.X_OK);
      return { ok: true, parent: candidate };
    } catch (error) {
      if (messageOf(error) !== "ENOENT") return { ok: false };
      const parent = dirname(candidate);
      if (parent === candidate) return { ok: false };
      candidate = parent;
    }
  }
}

async function museHomeCheck(
  env: Readonly<Record<string, string | undefined>>,
  fileSystem: OnboardPreflightFs,
  platform: NodeJS.Platform,
  readMounts: (() => Promise<string>) | undefined,
  temporaryRoots: readonly string[]
): Promise<{ readonly check: OnboardPreflightCheck; readonly museHome?: string }> {
  const raw = env.MUSE_HOME?.trim();
  if (!raw) {
    return { check: { detail: "MUSE_HOME must be an explicit absolute isolated directory before onboarding", id: "muse-home", status: "action" } };
  }
  if (!isAbsolute(raw)) {
    return { check: { detail: `MUSE_HOME must be absolute: ${raw}`, id: "muse-home", status: "action" } };
  }
  const museHome = resolve(raw);
  if (platform === "darwin") {
    const temporaryRoot = temporaryRoots.find((root) => {
      const fromRoot = relative(resolve(root), museHome);
      return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
    });
    if (temporaryRoot) {
      return { check: { detail: `${museHome} is inside a temporary directory (${resolve(temporaryRoot)}) — choose a stable local path such as ~/.cache/muse`, id: "muse-home", status: "action" }, museHome };
    }
  }
  const cloud = cloudSyncFolderCheck(museHome);
  if (cloud.status !== "ok") {
    return { check: { detail: cloud.detail, id: "muse-home", status: "action" }, museHome };
  }
  const volatile = await volatileMountCheck(museHome, platform, readMounts);
  if (volatile?.status === "warn") {
    return { check: { detail: volatile.detail, id: "muse-home", status: "action" }, museHome };
  }
  try {
    const stat = await fileSystem.lstat(museHome);
    if (!stat.isDirectory()) {
      return { check: { detail: `${museHome} exists but is not a directory`, id: "muse-home", status: "action" }, museHome };
    }
    await fileSystem.access(museHome, fsConstants.W_OK | fsConstants.X_OK);
    return { check: { detail: `${museHome} is local and writable`, id: "muse-home", status: "ok" }, museHome };
  } catch (error) {
    if (messageOf(error) !== "ENOENT") {
      return { check: { detail: `${museHome} cannot be inspected or written`, id: "muse-home", status: "action" }, museHome };
    }
  }
  const parent = await nearestCreatableParent(dirname(museHome), fileSystem);
  return parent.ok
    ? { check: { detail: `${museHome} does not exist yet but is creatable from ${parent.parent} (no files were written)`, id: "muse-home", status: "ok" }, museHome }
    : { check: { detail: `${museHome} does not exist and no writable parent could be verified`, id: "muse-home", status: "action" }, museHome };
}

function configuredProviderNames(env: Readonly<Record<string, string | undefined>>): readonly string[] {
  const configured = new Set<string>(SETUP_MODEL_PROVIDER_SPECS
    .filter((spec) => (env[spec.envKey] ?? "").trim().length > 0)
    .map((spec) => spec.id));
  if ((env.GOOGLE_API_KEY ?? "").trim()) configured.add("gemini");
  const explicitProvider = env.MUSE_MODEL_PROVIDER_ID?.trim();
  if (explicitProvider) {
    configured.add(explicitProvider);
  } else if ((env.MUSE_MODEL_BASE_URL ?? "").trim()) {
    configured.add("openai-compatible");
  }
  return [...configured].sort();
}

/**
 * Runs no network or interactive work, and never mutates the filesystem.
 * It intentionally reports only provider names and a resolved model — it does
 * not test credentials (Core100-093) or preview egress (Core100-092).
 */
export async function collectOnboardPreflight(options: OnboardPreflightOptions = {}): Promise<OnboardPreflightReport> {
  const env = options.env ?? process.env;
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const platform = options.platform ?? process.platform;
  const entry = validateDaemonCliEntry(options.cliEntry ?? process.argv[1], { temporaryRoots: options.temporaryRoots });
  const cliCheck: OnboardPreflightCheck = entry.ok
    ? { detail: `${entry.entrypoint} is the declared muse bin of @muse/cli`, id: "cli-entry", status: "ok" }
    : { detail: entry.reason, id: "cli-entry", status: "action" };
  const homeTemporaryRoots = options.museHomeTemporaryRoots
    ?? defaultDaemonTemporaryRoots(env as NodeJS.ProcessEnv);
  const home = await museHomeCheck(env, fileSystem, platform, options.readMounts, homeTemporaryRoots);
  const model = resolveDefaultModel(env as Record<string, string | undefined>) ?? LOCAL_FIRST_DEFAULT_MODEL;
  const configuredProviders = configuredProviderNames(env);
  let modelCheck: OnboardPreflightCheck;
  let provider: string | undefined;
  let locality: "cloud" | "local" | undefined;
  try {
    const projection = resolveModelProvider(env as Record<string, string | undefined>);
    if (!projection) {
      modelCheck = { detail: `${model} did not resolve to a runtime model provider`, id: "model-provider", status: "action" };
    } else {
      provider = projection.provider.id;
      locality = projection.locality;
      const providerDetail = configuredProviders.length > 0
        ? `${model} resolves to active ${locality} provider ${provider}; configured provider names: ${configuredProviders.join(", ")}`
        : `${model} resolves to active ${locality} provider ${provider}; no provider is configured`;
      modelCheck = { detail: providerDetail, id: "model-provider", status: "ok" };
    }
  } catch {
    modelCheck = { detail: `${model} could not be resolved to a safe runtime model provider`, id: "model-provider", status: "action" };
  }
  const checks = [cliCheck, home.check, modelCheck] as const;
  return {
    checks,
    configuredProviders,
    ...(home.museHome ? { museHome: home.museHome } : {}),
    model,
    ...(provider ? { provider } : {}),
    ...(locality ? { locality } : {}),
    ready: checks.every((check) => check.status === "ok"),
    schemaVersion: "muse.onboard-preflight/v1"
  };
}
