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

import type { MessagingProvider } from "@muse/messaging";
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

import {
  resolveModelKeysFile,
  resolveUserSkillsDir,
  resolveWorkspaceSkillsDir
} from "./provider-paths.js";

export {
  resolveActionLogFile,
  resolvePendingApprovalsFile,
  resolveBriefingSidecarFile,
  resolveContactsFile,
  resolveCredentialsFile,
  resolveDiscordAfterFile,
  resolveDiscordInboxFile,
  resolveEpisodesFile,
  resolveFeedsFile,
  resolveFollowupLlmBudgetFile,
  resolveFollowupsFile,
  resolveInboxInjectionCursorFile,
  resolvePatternsFiredFile,
  resolveLineInboxFile,
  resolveLocalCalendarFile,
  resolveMessagingCredentialsFile,
  resolveModelKeysFile,
  resolveNotesDir,
  resolveObjectivesFile,
  resolveProactiveHistoryFile,
  resolveReminderHistoryFile,
  resolveRemindersFile,
  resolveSessionLockFile,
  resolveSlackAfterFile,
  resolveSlackInboxFile,
  resolveTasksFile,
  resolveTelegramInboxFile,
  resolveTelegramOffsetFile,
  resolveUserSkillsDir,
  resolveVetoesFile,
  resolvePlaybookFile,
  resolveWorkspaceSkillsDir
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
export function mergeModelKeysFromFile(env: MuseEnvironment): MuseEnvironment {
  const file = readCredentialsSync(resolveModelKeysFile(env));
  if (Object.keys(file).length === 0) {
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
  if (Object.keys(fileKeyForEnv).length === 0) {
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

// Suppress unused-import warning when only the type is referenced.
export type { MessagingProvider };

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
  buildPlaybookProvider
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
  if (env.MUSE_SKILLS_ENABLED?.trim().toLowerCase() === "false") {
    return undefined;
  }
  const roots: { path: string; source: "user" | "workspace" }[] = [
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

