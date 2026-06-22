/**
 * Tasks-registry builder — env → `TasksProviderRegistry` with the
 * personal-JARVIS subset (local file / Apple Reminders / Notion).
 * Lifted from `personal-providers.ts` following the messaging /
 * calendar / voice / notes builders.
 *
 * Env (resolution order):
 *   - `MUSE_TASKS_PROVIDERS` — comma-separated subset of
 *     `local,apple-reminders,notion`. Defaults to `local`. Adding
 *     `apple-reminders` registers an `AppleRemindersProvider`; the
 *     osascript calls fail with `REMINDERS_PERMISSION` until the
 *     user grants Reminders access on macOS, but the registry
 *     itself is built unconditionally so the agent surfaces a typed
 *     error rather than a missing tool. Adding `notion` requires
 *     `MUSE_NOTION_TASKS_TOKEN` + `MUSE_NOTION_TASKS_DATABASE_ID`;
 *     when either is missing the entry is silently skipped.
 *   - `MUSE_APPLE_REMINDERS_LIST` — optional list scope (e.g.
 *     "Groceries", "Work"). Default: every list, add lands in the
 *     default Reminders list.
 *   - `MUSE_NOTION_TASKS_TOKEN` — Notion integration token.
 *   - `MUSE_NOTION_TASKS_DATABASE_ID` — Notion database id (32-char).
 *   - `MUSE_NOTION_TASKS_TITLE_PROPERTY` — title-property name
 *     (default `Name`).
 *   - `MUSE_NOTION_TASKS_STATUS_PROPERTY` — select-property name
 *     (default `Status`).
 *   - `MUSE_NOTION_TASKS_STATUS_OPEN` / `..._STATUS_DONE` — option
 *     names (default `Open` / `Done`).
 *
 * The caller decides whether to register the registry-aware MCP
 * server (`createTasksRegistryMcpServer`) on top of the inline
 * filesystem-only `createTasksMcpServer`.
 */

import { AppleRemindersProvider, LocalFileTasksProvider, NotionTasksProvider, TasksProviderRegistry, type TasksProvider } from "@muse/domain-tools";

import type { MuseEnvironment } from "../index.js";
import { resolveTasksFile } from "../provider-paths.js";

export function buildTasksRegistry(env: MuseEnvironment): TasksProviderRegistry {
  const registry = new TasksProviderRegistry();
  const requested = (env.MUSE_TASKS_PROVIDERS?.trim() || "local")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  for (const id of requested) {
    const provider = tryBuildTasksProvider(id, env);
    if (provider) {
      registry.register(provider);
    }
  }

  return registry;
}

function tryBuildTasksProvider(id: string, env: MuseEnvironment): TasksProvider | undefined {
  if (id === "local") {
    return new LocalFileTasksProvider({ file: resolveTasksFile(env) });
  }

  if (id === "apple-reminders") {
    const list = env.MUSE_APPLE_REMINDERS_LIST?.trim();
    return new AppleRemindersProvider(list ? { list } : {});
  }

  if (id === "notion") {
    const token = env.MUSE_NOTION_TASKS_TOKEN?.trim();
    const databaseId = env.MUSE_NOTION_TASKS_DATABASE_ID?.trim();
    if (!token || !databaseId) {
      // Silently skip — explicit opt-in via MUSE_TASKS_PROVIDERS but
      // missing credentials means the user hasn't finished setup yet.
      return undefined;
    }
    const titleProperty = env.MUSE_NOTION_TASKS_TITLE_PROPERTY?.trim();
    const statusProperty = env.MUSE_NOTION_TASKS_STATUS_PROPERTY?.trim();
    const statusOpenValue = env.MUSE_NOTION_TASKS_STATUS_OPEN?.trim();
    const statusDoneValue = env.MUSE_NOTION_TASKS_STATUS_DONE?.trim();
    return new NotionTasksProvider({
      databaseId,
      token,
      ...(titleProperty ? { titleProperty } : {}),
      ...(statusProperty ? { statusProperty } : {}),
      ...(statusOpenValue ? { statusOpenValue } : {}),
      ...(statusDoneValue ? { statusDoneValue } : {})
    });
  }

  return undefined;
}
