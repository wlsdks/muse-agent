/**
 * Personal-domain provider builders + env-driven path resolvers.
 *
 * Lifted out of `packages/autoconfigure/src/index.ts` (1,255 LOC,
 * the largest source file in the repo after the mcp splits) so the
 * JARVIS-personal wiring — Notes / Tasks / Calendar / Voice — lives
 * in its own focused module.
 *
 * What's here:
 *   - Default-path resolvers for the personal-domain trio's local
 *     storage: notes dir, tasks file, local calendar file, plus the
 *     credentials JSON file consumed by remote calendar providers
 *   - `ensureNotesDir` — best-effort `mkdir -p` so the inline
 *     Notes MCP server has a directory to land into
 *
 * Registry builders live under `./registry-builders/`:
 * `buildMessagingRegistry`, `buildCalendarRegistry`,
 * `buildVoiceRegistry`. The functions are re-exported from this
 * module so existing `index.ts` call sites stay byte-identical.
 *
 * The shape of `MuseEnvironment` stays in `index.ts`; this module
 * imports it back as a type-only consumer.
 */

import { mkdirSync } from "node:fs";

import type {
  SkillCatalogEntry,
  SkillCatalogProvider
} from "@muse/agent-core";
import {
  FileSystemSkillLoader,
  InMemorySkillRegistry,
  type Skill,
  type SkillRegistry
} from "@muse/skills";

import type { MuseEnvironment } from "./index.js";
import { OPENAI_COMPAT_PRESETS } from "./openai-compat-presets.js";
import { readCredentialsSync, stringField } from "./provider-utils.js";
import { parseBoolean } from "./env-parsers.js";

import {
  resolveAuthoredSkillsDir,
  resolveModelKeysFile,
  resolveUserSkillsDir,
  resolveWorkspaceSkillsDir
} from "./provider-paths.js";
import { isLocalOnlyEnabled } from "@muse/model";

export {
  resolveActionLogFile,
  resolveAttunementFile,
  resolveAuthoredSkillsDir,
  resolveSkillRewardsFile,
  resolvePendingApprovalsFile,
  resolveBriefingSidecarFile,
  resolveContactsFile,
  resolveCredentialsFile,
  resolveDiscordAfterFile,
  resolveDiscordInboxFile,
  resolveEpisodesFile,
  resolveNoteProvenanceFile,
  resolveFadedMemoriesFile,
  resolveFeedsFile,
  resolveBrowsingFile,
  resolveFollowupLlmBudgetFile,
  resolveFollowupsFile,
  resolveInboxInjectionCursorFile,
  resolveInterruptionLedgerFile,
  resolveDigestQueueFile,
  resolveDigestSentFile,
  resolveLastProactiveDeliveryFile,
  resolvePatternsFiredFile,
  resolveRecallHitsFile,
  resolveFactRecallHitsFile,
  resolveCheckinsFile,
  resolveLineInboxFile,
  resolveLocalCalendarFile,
  resolveMatrixInboxFile,
  resolveMatrixSinceFile,
  resolveMessagingCredentialsFile,
  resolveModelKeysFile,
  resolveMuseCliConfigFilePath,
  resolveOAuthStoreDir,
  resolveNotesDir,
  resolveNotesIndexFile,
  resolveObjectivesFile,
  resolveProactiveHistoryFile,
  resolveReminderHistoryFile,
  resolveRemindersFile,
  resolveSessionLockFile,
  resolveSlackAfterFile,
  resolveSlackInboxFile,
  resolveTasksFile,
  resolveTokenUsageFile,
  resolveCheckpointsDir,
  resolveWeaknessesFile,
  resolveTelegramInboxFile,
  resolveTelegramOffsetFile,
  resolveVetoesFile,
  resolvePlaybookFile,
  resolveReflectionsFile,
  resolveSuppressedLessonsFile,
  resolveLearningPauseFile,
  resolvePlanCacheFile,
} from "./provider-paths.js";

/**
 * Merge model API keys saved by `muse setup model` into the env
 * record. Env always wins on conflict — a one-off shell export
 * stays effective. The file shape comes from `setup-model.ts`:
 *   { providers: { openai: { token, suggestedModel }, ... } }
 *
 * Recognised file ids → env keys:
 *   openai      → OPENAI_API_KEY
 *   anthropic   → ANTHROPIC_API_KEY
 *   gemini      → GEMINI_API_KEY
 *   openrouter  → OPENROUTER_API_KEY
 *   ollama      → OLLAMA_BASE_URL  (the file's `token` field is
 *                                   the URL, not a secret)
 *
 * Sync read by design — `createMuseRuntimeAssembly` is sync and
 * reads env directly; the file fallback rides the same path.
 */
export interface MergeModelKeysFromFileOptions {
  /**
   * A composition-owned local-only posture. This is deliberately a narrow
   * internal seam: API snapshots and local MCP bootstraps must not re-read a
   * contradictory ambient value while materialising model settings.
   */
  readonly localOnlyOverride?: boolean;
}

const GMAIL_ENV_KEY = "MUSE_GMAIL_TOKEN";
const LOCAL_ONLY_ENV_KEY = "MUSE_LOCAL_ONLY";

/**
 * Resolve the local-only posture used while materialising the model
 * environment. The actual process is the non-bypassable floor: a supplied
 * composition snapshot may add strictness, but a false snapshot must not
 * reopen an already strict Muse process. Returning `undefined` is deliberate
 * for the ordinary non-strict/no-override path so its historical raw-env
 * merge behaviour does not become a broad Proxy projection.
 */
export function resolveEffectiveLocalOnlyOverride(
  sourceEnv: MuseEnvironment,
  explicitOverride: boolean | undefined
): boolean | undefined {
  if (isLocalOnlyEnabled(process.env)) {
    return true;
  }
  if (explicitOverride !== undefined) {
    return explicitOverride;
  }
  return isLocalOnlyEnabled(sourceEnv) ? true : undefined;
}

/**
 * A bounded env projection used only when local-only is effective (or a
 * caller supplied a frozen override). It never enumerates the source env:
 * `models.json` remains available, ordinary non-model values remain lazily
 * readable, and Gmail is absent from every reflective surface under
 * local-only. This matters for a source that is a credential-protecting
 * Proxy: spreading it would invoke `ownKeys` before the registry can apply
 * its Gmail gate.
 */
function createModelEnvironmentOverlay(
  source: MuseEnvironment,
  materialized: Readonly<Record<string, string | undefined>>,
  localOnly: boolean
): MuseEnvironment {
  const values = new Map<string, string>();
  for (const [key, value] of Object.entries(materialized)) {
    if (value !== undefined) {
      values.set(key, value);
    }
  }
  values.set(LOCAL_ONLY_ENV_KEY, localOnly ? "true" : "false");

  // A fresh target avoids Proxy invariant interaction with an arbitrary
  // source Proxy. Every virtual own property is configurable.
  const target: Record<string, never> = Object.create(null);
  return new Proxy(target, {
    defineProperty: () => false,
    deleteProperty: () => false,
    get(_target, property) {
      if (typeof property !== "string") {
        return Reflect.get(source, property);
      }
      if (property === GMAIL_ENV_KEY && localOnly) {
        return undefined;
      }
      if (values.has(property)) {
        return values.get(property);
      }
      // Do not turn this into a spread or `Object.keys(source)`: direct reads
      // preserve normal env access without exposing unrelated credentials.
      return source[property];
    },
    getOwnPropertyDescriptor(_target, property) {
      if (typeof property === "string" && values.has(property)) {
        return {
          configurable: true,
          enumerable: true,
          value: values.get(property),
          writable: false
        };
      }
      // In particular, Gmail has no descriptor in local-only mode. Unknown
      // source fields are intentionally lazy-only rather than reflected.
      return undefined;
    },
    has(_target, property) {
      if (property === GMAIL_ENV_KEY && localOnly) {
        return false;
      }
      if (typeof property === "string" && values.has(property)) {
        return true;
      }
      return typeof property === "symbol" ? Reflect.has(source, property) : property in source;
    },
    ownKeys() {
      // `values` is source-independent and includes MUSE_LOCAL_ONLY exactly
      // once. Do not reflect or enumerate the source here.
      return [...values.keys()];
    },
    preventExtensions: () => false,
    set: () => false
  });
}

export function mergeModelKeysFromFile(
  env: MuseEnvironment,
  options: MergeModelKeysFromFileOptions = {}
): MuseEnvironment {
  // Work out the strict floor before this function reaches its raw-env merge
  // branch. In particular, a nonempty models.json must never make an ambient
  // strict process enumerate a supplied false environment before downstream
  // credential gates (such as Home Assistant) can classify it.
  const effectiveOverride = resolveEffectiveLocalOnlyOverride(env, options.localOnlyOverride);
  const projected = effectiveOverride !== undefined;
  const effectiveLocalOnly = effectiveOverride === true;
  const file = readCredentialsSync(resolveModelKeysFile(env), env);
  // The historical false/unset branch intentionally keeps its exact raw-env
  // precedence and early returns. Only the projection branch must avoid raw
  // enumeration/reflection.
  if (Object.keys(file).length === 0 && !projected) {
    return env;
  }
  const fileKeyForEnv: Record<string, string | undefined> = {};
  const legacy: ReadonlyArray<{ id: string; envKey: string }> = [
    { envKey: "OPENAI_API_KEY", id: "openai" },
    { envKey: "ANTHROPIC_API_KEY", id: "anthropic" },
    { envKey: "GEMINI_API_KEY", id: "gemini" },
    { envKey: "OPENROUTER_API_KEY", id: "openrouter" },
    { envKey: "OLLAMA_BASE_URL", id: "ollama" }
  ];
  const map: ReadonlyArray<{ id: string; envKey: string }> = [
    ...legacy,
    ...Object.entries(OPENAI_COMPAT_PRESETS).map(([id, preset]) => ({ envKey: preset.envKey, id }))
  ];
  let firstSuggestedModel: string | undefined;
  for (const entry of map) {
    const token = stringField(file[entry.id], "token");
    if (token && token.length > 0) {
      fileKeyForEnv[entry.envKey] = token;
      // Capture the first provider's `suggestedModel` so `setup model`
      // produces a turnkey configuration — without it the user has to
      // separately `export MUSE_MODEL=...` even though the wizard
      // already asked them to pick a provider.
      if (firstSuggestedModel === undefined) {
        const suggested = stringField(file[entry.id], "suggestedModel");
        if (suggested && suggested.length > 0) {
          firstSuggestedModel = suggested;
        }
      }
    }
  }
  if (Object.keys(fileKeyForEnv).length === 0 && !projected) {
    return env;
  }
  // Env wins on conflict, BUT an empty/whitespace-only env value
  // for a key we just resolved from the file is treated as "unset"
  // — otherwise a shell that pre-clears `OLLAMA_BASE_URL=` would
  // silently shadow the user's configured ~/.muse/models.json with
  // an empty string and fall back to localhost.
  if (firstSuggestedModel !== undefined) {
    fileKeyForEnv["MUSE_MODEL"] = firstSuggestedModel;
  }
  if (projected) {
    const materialized: Record<string, string | undefined> = { ...fileKeyForEnv };
    for (const key of Object.keys(fileKeyForEnv)) {
      const envValue = env[key];
      materialized[key] = typeof envValue === "string" && envValue.trim().length > 0
        ? envValue
        : fileKeyForEnv[key];
    }
    return createModelEnvironmentOverlay(env, materialized, effectiveLocalOnly);
  }

  const merged: Record<string, string | undefined> = { ...fileKeyForEnv, ...env };
  for (const key of Object.keys(fileKeyForEnv)) {
    const envValue = env[key];
    if (typeof envValue === "string" && envValue.trim().length === 0) {
      merged[key] = fileKeyForEnv[key];
    }
  }
  return merged;
}

export { buildCalendarRegistry } from "./registry-builders/calendar.js";

export { buildNotesRegistry } from "./registry-builders/notes.js";

export { buildTasksRegistry } from "./registry-builders/tasks.js";

export { buildVoiceRegistry } from "./registry-builders/voice.js";

export function ensureNotesDir(notesDir: string): void {
  try {
    mkdirSync(notesDir, { recursive: true });
  } catch {
    // Best-effort — the notes server will surface clearer errors when the
    // first list/read/save call hits a permissions issue.
  }
}


/**
 * Build the messaging provider registry from env tokens **and**
 * the persisted credential file (`~/.muse/messaging.json` or
 * `MUSE_MESSAGING_CREDENTIALS_FILE`). Env wins when both are
 * present; absence is silent. Phase 1 surface is outbound-only —
 * see `docs/design/messaging.md`.
 *
 * Recognised inputs:
 *   - MUSE_TELEGRAM_BOT_TOKEN          (env) or providers.telegram.token   (file)
 *   - MUSE_DISCORD_BOT_TOKEN           (env) or providers.discord.token    (file)
 *   - MUSE_SLACK_BOT_TOKEN  (xoxb-...) (env) or providers.slack.token      (file)
 *   - MUSE_LINE_CHANNEL_ACCESS_TOKEN   (env) or providers.line.token       (file)
 */
// `buildMessagingRegistry` lives in `./registry-builders/messaging.ts`.
// Re-exported so external call-sites stay byte-identical.
export { buildMessagingRegistry } from "./registry-builders/messaging.js";

/**
 * Context-engineering provider builders (Phases 1–5 + telemetry)
 * live in their own module so this file can focus on the
 * domain-provider registries (Calendar / Notes / Tasks / Messaging
 * / Voice).
 */
export {
  buildActiveContextProvider,
  buildEpisodicRecallProvider,
  buildInboxContextProvider,
  buildTelemetryAggregator,
  buildToolFilter,
  buildVetoAvoidanceProvider,
  buildPlaybookProvider,
  buildPlanCacheProvider,
  buildToolExemplarBank
} from "./context-engineering-builders.js";

/**
 * Build the SKILL.md registry by scanning user + workspace dirs.
 * Loads asynchronously off the hot path of
 * `createMuseRuntimeAssembly` — callers `await` the promise once
 * during boot to pre-warm the registry before serving traffic.
 *
 * Roots in low → high precedence:
 *   1. user dir (`~/.muse/skills/`)
 *   2. workspace dir (`MUSE_WORKSPACE_SKILLS_DIR`)
 *
 * Returns `undefined` when `MUSE_SKILLS_ENABLED=false`.
 */
export async function buildSkillRegistry(env: MuseEnvironment): Promise<SkillRegistry | undefined> {
  if (!parseBoolean(env.MUSE_SKILLS_ENABLED, true)) {
    return undefined;
  }
  const roots: { path: string; source: "user" | "workspace" | "authored" }[] = [
    { path: resolveAuthoredSkillsDir(env), source: "authored" }, // FIRST = lowest precedence
    { path: resolveUserSkillsDir(env), source: "user" }
  ];
  const workspace = resolveWorkspaceSkillsDir(env);
  if (workspace) {
    roots.push({ path: workspace, source: "workspace" });
  }
  const loader = new FileSystemSkillLoader({ roots });
  const skills = await loader.loadAll();
  return new InMemorySkillRegistry(skills);
}

/**
 * Wrap a `SkillRegistry` (sync) OR a pending `Promise<SkillRegistry>`
 * (from the async loader) as a `SkillCatalogProvider`. The catalog
 * provider's `list()` is async-friendly so the autoconfigure caller
 * can stay synchronous while the disk scan finishes — the first
 * request just `await`s the registry promise and subsequent calls
 * are O(1).
 */
export function buildSkillCatalogProvider(
  registryOrPromise: SkillRegistry | Promise<SkillRegistry | undefined> | undefined
): SkillCatalogProvider | undefined {
  if (!registryOrPromise) {
    return undefined;
  }
  return {
    async list(): Promise<readonly SkillCatalogEntry[]> {
      const registry = await registryOrPromise;
      return registry ? registry.list().map(toCatalogEntry) : [];
    }
  };
}

function toCatalogEntry(skill: Skill): SkillCatalogEntry {
  return {
    ...(skill.frontmatter.emoji ? { emoji: skill.frontmatter.emoji } : {}),
    description: skill.description,
    name: skill.name,
    ...(skill.frontmatter.requires?.bins && skill.frontmatter.requires.bins.length > 0
      ? { requiresBins: [...skill.frontmatter.requires.bins] }
      : {}),
    // any-of CLI requirement (e.g. "codex OR claude")
    // forwarded so the agent can see the alternate-CLI dependency
    // in `[Available Skills]` and route accordingly.
    ...(skill.frontmatter.requires?.anyBins && skill.frontmatter.requires.anyBins.length > 0
      ? { requiresAnyBins: [...skill.frontmatter.requires.anyBins] }
      : {})
  };
}
