/**
 * Notes-registry builder — env + ~/.muse/credentials.json →
 * `NotesProviderRegistry` with the personal-JARVIS subset (local
 * filesystem / Apple Notes / Notion). Lifted from
 * `personal-providers.ts` following the messaging / calendar /
 * voice builders.
 *
 * Env (resolution order):
 *   - `MUSE_NOTES_PROVIDERS` — comma-separated subset of
 *     `local,apple,notion`. Defaults to `local`. Adding `apple`
 *     registers an `AppleNotesProvider`; the `osascript` calls fail
 *     with `NOTES_PERMISSION` until the user grants Notes access on
 *     macOS, but the registry itself is built unconditionally so
 *     the agent gets a typed error rather than a missing tool.
 *   - `MUSE_APPLE_NOTES_FOLDER` — optional folder filter for Apple
 *     Notes (default: every note).
 *   - Notion token resolution: `providers.notion.token` from the
 *     credentials file (`MUSE_CREDENTIALS_FILE`, default
 *     `~/.muse/credentials.json`) → `MUSE_NOTION_TOKEN` env. Without
 *     a token, Notion is silently skipped.
 *   - `MUSE_NOTION_DATABASE_ID` / `MUSE_NOTION_TITLE_PROPERTY` —
 *     overrides for the database scope and title-property name.
 *
 * The registry is composed; the caller decides whether to register
 * the registry-aware MCP server (`createNotesRegistryMcpServer`) on
 * top of the inline filesystem-only `createNotesMcpServer`.
 */

import { AppleNotesProvider, LocalDirNotesProvider, NotesProviderRegistry, NotionNotesProvider, type NotesProvider } from "@muse/domain-tools";

import type { MuseEnvironment } from "../index.js";
import { resolveCredentialsFile, resolveNotesDir } from "../provider-paths.js";
import { readCredentialsSync, stringField } from "../provider-utils.js";

export function buildNotesRegistry(env: MuseEnvironment): NotesProviderRegistry {
  const registry = new NotesProviderRegistry();
  const requested = (env.MUSE_NOTES_PROVIDERS?.trim() || "local")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  const credentials = readCredentialsSync(resolveCredentialsFile(env), env);

  for (const id of requested) {
    const provider = tryBuildNotesProvider(id, env, credentials[id]);
    if (provider) {
      registry.register(provider);
    }
  }

  return registry;
}

function tryBuildNotesProvider(
  id: string,
  env: MuseEnvironment,
  credentials: { readonly [key: string]: unknown } | undefined
): NotesProvider | undefined {
  if (id === "local") {
    return new LocalDirNotesProvider({ notesDir: resolveNotesDir(env) });
  }

  if (id === "apple") {
    const folder = stringField(credentials, "folder") ?? env.MUSE_APPLE_NOTES_FOLDER;
    return new AppleNotesProvider(folder ? { folder } : {});
  }

  if (id === "notion") {
    const token = stringField(credentials, "token") ?? env.MUSE_NOTION_TOKEN;
    if (!token) {
      return undefined;
    }
    const databaseId = stringField(credentials, "databaseId") ?? env.MUSE_NOTION_DATABASE_ID;
    const titleProperty = stringField(credentials, "titleProperty") ?? env.MUSE_NOTION_TITLE_PROPERTY;
    return new NotionNotesProvider({
      token,
      ...(databaseId ? { databaseId } : {}),
      ...(titleProperty ? { titleProperty } : {})
    });
  }

  return undefined;
}
