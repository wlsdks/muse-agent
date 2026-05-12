/**
 * `muse memory` command group.
 *
 * Two backends, picked by `--local`:
 *
 *   - default (API): wraps `/api/user-memory/<userId>` CRUD.
 *   - `--local`:     writes directly to `~/.muse/user-memory.json`
 *                     via FileUserMemoryStore (same file the API
 *                     server reads/writes, so they round-trip).
 *
 *   - `muse memory show` — facts / preferences / recent topics
 *   - `muse memory set <kind> <key> <value>` — write a fact or preference
 *     (kind = "fact" | "preference")
 *   - `muse memory clear` — wipe the record for this user
 *
 * User identity resolves the same way every other personal command
 * does: `--user` flag → `$MUSE_USER_ID` → `$USER` → `"default"`.
 * Matches commands-status.ts / commands-ask.ts / commands-brief.ts
 * so a single user sees the same persona everywhere.
 */

import { FileUserMemoryStore } from "@muse/memory";
import type { Command } from "commander";

import { formatMemoryShow } from "./human-formatters.js";
import type { ProgramIO } from "./program.js";

function envValue(key: string): string | undefined {
  const v = process.env[key]?.trim();
  return v && v.length > 0 ? v : undefined;
}

function resolveMemoryUserId(explicit: string | undefined): string {
  return explicit ?? envValue("MUSE_USER_ID") ?? envValue("USER") ?? "default";
}

export interface MemoryCommandHelpers {
  readonly apiRequest: (
    io: ProgramIO,
    command: Command,
    path: string,
    body?: Record<string, unknown>,
    method?: "GET" | "POST" | "PUT" | "DELETE"
  ) => Promise<unknown>;
  readonly writeOutput: (io: ProgramIO, value: unknown, textField?: string) => void;
}

interface MemoryCommonOptions {
  readonly user?: string;
  readonly local?: boolean;
  readonly json?: boolean;
}

export function registerMemoryCommands(program: Command, io: ProgramIO, helpers: MemoryCommandHelpers): void {
  const memory = program.command("memory").description("Personal user-memory facts / preferences");

  memory
    .command("show")
    .description("Print stored facts, preferences, and recent topics")
    .option("--user <id>", "User identity (default $MUSE_USER_ID or $USER)")
    .option("--local", "Read directly from ~/.muse/user-memory.json instead of the API")
    .option("--json", "Print the raw response instead of the formatted summary")
    .action(async (options: MemoryCommonOptions, command) => {
      const userId = resolveMemoryUserId(options.user);
      let payload: Record<string, unknown> | undefined;
      if (options.local) {
        const store = new FileUserMemoryStore();
        const memoryRecord = await store.findByUserId(userId);
        payload = memoryRecord
          ? {
              facts: memoryRecord.facts,
              preferences: memoryRecord.preferences,
              recentTopics: memoryRecord.recentTopics,
              updatedAt: memoryRecord.updatedAt.toISOString()
            }
          : { facts: {}, preferences: {}, recentTopics: [] };
      } else {
        payload = (await helpers.apiRequest(io, command, `/api/user-memory/${userId}`)) as Record<string, unknown> | undefined;
      }
      if (options.json) {
        helpers.writeOutput(io, payload ?? {});
        return;
      }
      const merged = { userId, ...(payload ?? {}) };
      io.stdout(formatMemoryShow(merged as unknown as Parameters<typeof formatMemoryShow>[0]));
    });

  memory
    .command("set")
    .description("Store a fact or preference key/value entry")
    .argument("<kind>", "Entry kind: 'fact' or 'preference'")
    .argument("<key>", "Memory key (e.g. timezone)")
    .argument("<value>", "Memory value")
    .option("--user <id>", "User identity (default $MUSE_USER_ID or $USER)")
    .option("--local", "Write directly to ~/.muse/user-memory.json instead of the API")
    .option("--json", "Print the raw response instead of a short confirmation")
    .action(async (
      kind: string,
      key: string,
      value: string,
      options: MemoryCommonOptions,
      command
    ) => {
      const segment = parseKindSegment(kind);
      const userId = resolveMemoryUserId(options.user);
      if (options.local) {
        const store = new FileUserMemoryStore();
        const updated = segment === "facts"
          ? await store.upsertFact(userId, key, value)
          : await store.upsertPreference(userId, key, value);
        if (options.json) {
          helpers.writeOutput(io, {
            facts: updated.facts,
            preferences: updated.preferences,
            recentTopics: updated.recentTopics,
            updatedAt: updated.updatedAt.toISOString(),
            userId: updated.userId
          });
          return;
        }
        io.stdout(`Set ${segment.slice(0, -1)} ${key} = ${value} (user=${userId}, local)\n`);
        return;
      }
      const result = await helpers.apiRequest(io, command, `/api/user-memory/${userId}/${segment}`, { key, value }, "PUT");
      if (options.json) {
        helpers.writeOutput(io, result);
        return;
      }
      io.stdout(`Set ${segment.slice(0, -1)} ${key} = ${value}\n`);
    });

  memory
    .command("clear")
    .description("Wipe stored user memory")
    .option("--user <id>", "User identity (default $MUSE_USER_ID or $USER)")
    .option("--local", "Clear directly in ~/.muse/user-memory.json instead of via API")
    .option("--force", "Skip the confirmation prompt (required for --local)")
    .action(async (options: MemoryCommonOptions & { readonly force?: boolean }, command) => {
      const userId = resolveMemoryUserId(options.user);
      if (options.local) {
        if (!options.force) {
          io.stderr(`Refusing to clear ${userId} without --force\n`);
          process.exitCode = 2;
          return;
        }
        const store = new FileUserMemoryStore();
        await store.deleteByUserId(userId);
        io.stdout(`Cleared user memory (user=${userId}, local)\n`);
        return;
      }
      await helpers.apiRequest(io, command, `/api/user-memory/${userId}`, undefined, "DELETE");
      io.stdout("Cleared user memory\n");
    });
}

function parseKindSegment(kind: string): "facts" | "preferences" {
  const trimmed = kind.trim().toLowerCase();
  if (trimmed === "fact" || trimmed === "facts") {
    return "facts";
  }
  if (trimmed === "preference" || trimmed === "preferences") {
    return "preferences";
  }
  throw new Error("kind must be 'fact' or 'preference'");
}
