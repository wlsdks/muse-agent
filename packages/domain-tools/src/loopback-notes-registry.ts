import { assertNoSecretInPersistedFields, type JsonObject } from "@muse/shared";

import { readString } from "@muse/mcp";
import type { LoopbackMcpServer } from "@muse/mcp";
import {
  NotesProviderError,
  NotesValidationError,
  type NotesAppendInput,
  type NotesContent,
  type NotesEntry,
  type NotesProviderRegistry,
  type NotesSaveInput,
  type NotesSearchHit
} from "./notes-providers.js";

const EMPTY_NOTES_ENTRIES: readonly NotesEntry[] = [];
const EMPTY_NOTES_SEARCH_HITS: readonly NotesSearchHit[] = [];

/**
 * `muse.notes-multi` — provider-neutral notes MCP surface backed by
 * `NotesProviderRegistry`. Exposes the same five operations the
 * existing filesystem-only `muse.notes.*` server does, but routed
 * through the registry so the agent can target any registered
 * backend (LocalDir, Apple Notes, Notion) via `providerId`.
 *
 * Coexists with the original `createNotesMcpServer` — server names
 * `muse.notes` (filesystem-only) and `muse.notes-multi` (registry)
 * don't collide, so operators can register both during the
 * transition. Future iterations can either deprecate the
 * filesystem-only server or have autoconfigure wire the registry
 * one when more than one provider is configured.
 */

export interface NotesRegistryMcpServerOptions {
  readonly registry: NotesProviderRegistry;
}

export function createNotesRegistryMcpServer(options: NotesRegistryMcpServerOptions): LoopbackMcpServer {
  const { registry } = options;

  return {
    description: "Provider-neutral personal notes (LocalDir / Apple Notes / Notion) via NotesProviderRegistry.",
    name: "muse.notes-multi",
    tools: [
      {
        description:
          "List configured notes providers (id, displayName, local). " +
          "Use `providerId` from this list to target a specific provider in other muse.notes-multi.* calls.",
        execute: async (): Promise<JsonObject> => ({
          providers: registry.describe().map((info) => ({
            description: info.description,
            displayName: info.displayName,
            id: info.id,
            local: info.local
          }))
        }),
        inputSchema: {
          additionalProperties: false,
          properties: {},
          type: "object"
        },
        name: "providers",
        risk: "read"
      },
      {
        description:
          "List notes from one provider (or every provider when `providerId` is omitted). " +
          "Optional `folder` filter is provider-specific (LocalDir: subdirectory, Notion: ignored, Apple: folder name).",
        execute: async (args): Promise<JsonObject> => {
          const providerId = readString(args, "providerId");
          const folder = readString(args, "folder");
          try {
            const entries = providerId
              ? await registry.require(providerId).list(folder)
              : (await Promise.all(
                  registry.list().map(async (provider) => {
                    try {
                      return await provider.list(folder);
                    } catch {
                      return EMPTY_NOTES_ENTRIES;
                    }
                  })
                )).flat();
            return {
            entries: entries.map(serializeEntry),
              total: entries.length
            };
          } catch (error) {
            return errorBody(error);
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            folder: { description: "Filter to a folder / notebook, e.g. 'journal' (default: all folders).", type: "string" },
            providerId: { description: "Notes provider id (default: all registered providers).", type: "string" }
          },
          type: "object"
        },
        name: "list",
        risk: "read"
      },
      {
        description: "Read a single note by `providerId` + `id`. Returns `{ note }` with id, title, body, folder, updatedAt.",
        execute: async (args): Promise<JsonObject> => {
          const providerId = readString(args, "providerId");
          const id = readString(args, "id");
          if (!providerId || !id) {
            return { error: "providerId and id are required" };
          }
          try {
            const note = await registry.require(providerId).read(id);
            if (!note) {
              return { error: `note not found: ${providerId}:${id}`, found: false };
            }
            return { note: serializeContent(note) };
          } catch (error) {
            return errorBody(error);
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            id: { description: "The note's id, from `list` or `search`.", type: "string" },
            providerId: { description: "Notes provider id the note belongs to.", type: "string" }
          },
          required: ["providerId", "id"],
          type: "object"
        },
        name: "read",
        risk: "read"
      },
      {
        description:
          "Search notes by substring across one or all providers. " +
          "Without `providerId`, the same query runs in parallel against every registered provider.",
        execute: async (args): Promise<JsonObject> => {
          const query = readString(args, "query")?.trim();
          if (!query) {
            return { error: "query is required" };
          }
          const providerId = readString(args, "providerId");
          const limitArg = args["limit"];
          const limit = typeof limitArg === "number" && Number.isFinite(limitArg)
            ? Math.max(1, Math.min(100, Math.trunc(limitArg)))
            : 20;
          try {
            const hits = providerId
              ? await registry.require(providerId).search(query, limit)
              : (await Promise.all(
                  registry.list().map(async (provider) => {
                    try {
                      return await provider.search(query, limit);
                    } catch {
                      return EMPTY_NOTES_SEARCH_HITS;
                    }
                  })
                )).flat();
            return {
              hits: hits.map(serializeHit),
              total: hits.length
            };
          } catch (error) {
            return errorBody(error);
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            limit: { description: "Max results to return (1–100, default 20).", type: "number" },
            providerId: { description: "Notes provider id (default: search all providers).", type: "string" },
            query: { description: "Text to find in note titles/bodies, e.g. 'Q3 launch plan'.", type: "string" }
          },
          required: ["query"],
          type: "object"
        },
        name: "search",
        risk: "read"
      },
      {
        description:
          "Save a note via the registry. With `id`, updates the existing note (set `overwrite: true` to replace body) — " +
          "`providerId` is required there to name which backend holds it. Without `id`, creates a new note; omit " +
          "`providerId` to use your primary notes provider.",
        execute: async (args): Promise<JsonObject> => {
          const providerId = readString(args, "providerId");
          const title = readString(args, "title")?.trim();
          const body = readString(args, "body");
          if (!title) {
            return { error: "title is required" };
          }
          if (body === undefined) {
            return { error: "body is required" };
          }
          const id = readString(args, "id");
          if (id && !providerId) {
            return { error: "providerId is required to update an existing note" };
          }
      const guard = assertNoSecretInPersistedFields({ title, body });
      if (!guard.safe) {
        return { blocked: true, error: guard.notice, kinds: [...guard.kinds] };
      }
          const folder = readString(args, "folder");
          const overwrite = args["overwrite"] === true;
          const input: NotesSaveInput = {
            body,
            title,
            ...(id ? { id } : {}),
            ...(folder ? { folder } : {}),
            ...(overwrite ? { overwrite } : {})
          };
          try {
            const provider = id ? registry.require(providerId as string) : registry.requireOrPrimary(providerId);
            const saved = await provider.save(input);
            return { note: serializeContent(saved) };
          } catch (error) {
            return errorBody(error);
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            body: { description: "Note content (markdown).", type: "string" },
            folder: { description: "Folder / notebook to save into, e.g. 'journal'.", type: "string" },
            id: { description: "Existing note id to update; omit to create a new note.", type: "string" },
            overwrite: { description: "True to replace an existing note's body instead of erroring.", type: "boolean" },
            providerId: { description: "Notes provider id; required only when updating by `id` (default on create: your primary provider).", type: "string" },
            title: { description: "Note title, e.g. 'Meeting notes 2026-05-23'.", type: "string" }
          },
          required: ["title", "body"],
          type: "object"
        },
        name: "save",
        risk: "write"
      },
      {
        description: "Append `body` to an existing note's content. Requires `providerId` + `id`.",
        execute: async (args): Promise<JsonObject> => {
          const providerId = readString(args, "providerId");
          const id = readString(args, "id");
          const body = readString(args, "body");
          if (!providerId || !id) {
            return { error: "providerId and id are required" };
          }
          if (body === undefined) {
            return { error: "body is required" };
          }
      const guard = assertNoSecretInPersistedFields({ body });
      if (!guard.safe) {
        return { blocked: true, error: guard.notice, kinds: [...guard.kinds] };
      }
          const input: NotesAppendInput = { body, id };
          try {
            const updated = await registry.require(providerId).append(input);
            return { note: serializeContent(updated) };
          } catch (error) {
            return errorBody(error);
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            body: { description: "Text to append to the note's existing content.", type: "string" },
            id: { description: "The note's id, from `list` or `search`.", type: "string" },
            providerId: { description: "Notes provider id the note belongs to.", type: "string" }
          },
          required: ["providerId", "id", "body"],
          type: "object"
        },
        name: "append",
        risk: "write"
      }
    ]
  };
}

function serializeEntry(entry: NotesEntry): JsonObject {
  return {
    id: entry.id,
    providerId: entry.providerId,
    title: entry.title,
    ...(entry.folder ? { folder: entry.folder } : {}),
    ...(entry.sizeBytes !== undefined ? { sizeBytes: entry.sizeBytes } : {}),
    ...(entry.updatedAt ? { updatedAt: entry.updatedAt.toISOString() } : {})
  };
}

function serializeContent(content: NotesContent): JsonObject {
  return {
    body: content.body,
    id: content.id,
    providerId: content.providerId,
    title: content.title,
    ...(content.folder ? { folder: content.folder } : {}),
    ...(content.updatedAt ? { updatedAt: content.updatedAt.toISOString() } : {})
  };
}

function serializeHit(hit: NotesSearchHit): JsonObject {
  return {
    id: hit.id,
    providerId: hit.providerId,
    snippet: hit.snippet,
    title: hit.title,
    ...(hit.score !== undefined ? { score: hit.score } : {}),
    ...(hit.line !== undefined ? { line: hit.line } : {})
  };
}

function errorBody(error: unknown): JsonObject {
  if (error instanceof NotesProviderError || error instanceof NotesValidationError) {
    return { code: error.code, error: error.message };
  }
  return { error: error instanceof Error ? error.message : String(error) };
}
