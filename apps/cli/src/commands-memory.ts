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

import { readFile } from "node:fs/promises";

import { FileUserMemoryStore } from "@muse/memory";
import type { Command } from "commander";

import { closestCommandName } from "./closest-command.js";
import { formatMemoryShow } from "./human-formatters.js";
import { isApiUnreachable, resolvePersona } from "./program-helpers.js";
import type { ProgramIO } from "./program.js";

function envValue(key: string): string | undefined {
  const v = process.env[key]?.trim();
  return v && v.length > 0 ? v : undefined;
}

/**
 * Extend the persona precedence to `muse memory`.
 * The on-disk store keys multi-persona slots as `<user>@<persona>`;
 * without honouring the slot here, a
 * user with `MUSE_PERSONA=work` couldn't `muse memory show` /
 * `set` against their work slot — the command silently read /
 * wrote the bare `<user>` record instead.
 */
export function resolveMemoryUserId(explicit: string | undefined, personaOption?: string): string {
  const base = explicit ?? envValue("MUSE_USER_ID") ?? envValue("USER") ?? "default";
  const slot = resolvePersona(personaOption);
  return slot ? `${base}@${slot}` : base;
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
  readonly persona?: string;
  readonly local?: boolean;
  readonly json?: boolean;
}

export function registerMemoryCommands(program: Command, io: ProgramIO, helpers: MemoryCommandHelpers): void {
  const memory = program.command("memory").description("Personal user-memory facts / preferences");

  memory
    .command("show")
    .description("Print stored facts, preferences, and recent topics")
    .option("--user <id>", "User identity (default $MUSE_USER_ID or $USER)")
    .option("--persona <slot>", "Persona slot (work / home / hobby / …); falls back to MUSE_PERSONA env")
    .option("--local", "Read directly from ~/.muse/user-memory.json instead of the API")
    .option("--json", "Print the raw response instead of the formatted summary")
    .action(async (options: MemoryCommonOptions, command) => {
      const userId = resolveMemoryUserId(options.user, options.persona);
      const readLocalMemory = async (): Promise<Record<string, unknown>> => {
        const store = new FileUserMemoryStore();
        const memoryRecord = await store.findByUserId(userId);
        return memoryRecord
          ? {
              facts: memoryRecord.facts,
              preferences: memoryRecord.preferences,
              recentTopics: memoryRecord.recentTopics,
              updatedAt: memoryRecord.updatedAt.toISOString()
            }
          : { facts: {}, preferences: {}, recentTopics: [] };
      };
      let payload: Record<string, unknown> | undefined;
      if (options.local) {
        payload = await readLocalMemory();
      } else {
        try {
          payload = (await helpers.apiRequest(io, command, `/api/user-memory/${userId}`)) as Record<string, unknown> | undefined;
        } catch (cause) {
          if (!isApiUnreachable(cause)) {
            throw cause;
          }
          io.stderr("muse: API not reachable — reading memory from the local store.\n");
          payload = await readLocalMemory();
        }
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
    .option("--persona <slot>", "Persona slot (work / home / hobby / …); falls back to MUSE_PERSONA env")
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
      const userId = resolveMemoryUserId(options.user, options.persona);
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
    .command("diff")
    .description("Show added / changed / removed facts + preferences since a baseline snapshot")
    .option("--user <id>", "User identity (default $MUSE_USER_ID or $USER)")
    .option("--persona <slot>", "Persona slot (work / home / hobby / …); falls back to MUSE_PERSONA env")
    .option("--baseline <path>", "Path to a baseline JSON file (shape: { facts?, preferences? }). When omitted, treats baseline as empty so every entry shows as added.")
    .option("--json", "Emit the structured diff payload instead of a formatted summary")
    .action(async (options: MemoryCommonOptions & { readonly baseline?: string }) => {
      const userId = resolveMemoryUserId(options.user, options.persona);
      const store = new FileUserMemoryStore();
      const memoryRecord = await store.findByUserId(userId);
      const current: MemorySnapshotLike = memoryRecord
        ? { facts: memoryRecord.facts, preferences: memoryRecord.preferences }
        : { facts: {}, preferences: {} };

      let baseline: MemorySnapshotLike = { facts: {}, preferences: {} };
      if (options.baseline) {
        try {
          const raw = await readFile(options.baseline, "utf8");
          const parsed = JSON.parse(raw) as MemorySnapshotLike;
          baseline = {
            facts: parsed.facts ?? {},
            preferences: parsed.preferences ?? {}
          };
        } catch (cause) {
          io.stderr(`Could not read baseline ${options.baseline}: ${cause instanceof Error ? cause.message : String(cause)}\n`);
          process.exitCode = 1;
          return;
        }
      }

      const diff = computeMemoryDiff(baseline, current);
      if (options.json) {
        helpers.writeOutput(io, diff);
        return;
      }
      if (diff.totalChanges === 0) {
        io.stdout(`No memory changes for ${userId}\n`);
        return;
      }
      io.stdout(`Memory diff for ${userId} (${diff.totalChanges.toString()} change(s)):\n\n`);
      renderDiffSlot(io, "facts", diff.facts);
      renderDiffSlot(io, "preferences", diff.preferences);
    });

  memory
    .command("clear")
    .description("Wipe stored user memory")
    .option("--user <id>", "User identity (default $MUSE_USER_ID or $USER)")
    .option("--persona <slot>", "Persona slot (work / home / hobby / …); falls back to MUSE_PERSONA env")
    .option("--local", "Clear directly in ~/.muse/user-memory.json instead of via API")
    .option("--force", "Skip the confirmation prompt (required for --local)")
    .action(async (options: MemoryCommonOptions & { readonly force?: boolean }, command) => {
      const userId = resolveMemoryUserId(options.user, options.persona);
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

/**
 * Accept singular / plural forms for both kinds and
 * surface a closest-match hint on typos. Previously a user typing
 * `muse memory set preferene name Stark` got a flat "kind must be
 * 'fact' or 'preference'" — no clue which of the four valid forms
 * they were closest to.
 */
export const MEMORY_KIND_FORMS = ["fact", "facts", "preference", "preferences"] as const;

export function parseKindSegment(kind: string): "facts" | "preferences" {
  const trimmed = kind.trim().toLowerCase();
  if (trimmed === "fact" || trimmed === "facts") {
    return "facts";
  }
  if (trimmed === "preference" || trimmed === "preferences") {
    return "preferences";
  }
  const suggestion = closestCommandName(trimmed, MEMORY_KIND_FORMS);
  const hint = suggestion ? ` — did you mean '${suggestion}'?` : "";
  throw new Error(`kind must be 'fact' or 'preference' (got '${kind}')${hint}`);
}

/**
 * Shape of the diff returned by `computeMemoryDiff`.
 * Each slot kind (facts / preferences) gets three buckets so a
 * dashboard or commit-style message can render "added 2, changed
 * 1, removed 0" without re-walking the data.
 */
export interface MemoryDiffSlot {
  readonly added: Readonly<Record<string, string>>;
  readonly changed: Readonly<Record<string, { readonly from: string; readonly to: string }>>;
  readonly removed: Readonly<Record<string, string>>;
}

export interface MemoryDiff {
  readonly facts: MemoryDiffSlot;
  readonly preferences: MemoryDiffSlot;
  readonly totalChanges: number;
}

interface MemorySnapshotLike {
  readonly facts?: Readonly<Record<string, string>>;
  readonly preferences?: Readonly<Record<string, string>>;
}

/**
 * Pure diff over the two map-shaped memory slots. The
 * caller is responsible for loading + parsing the JSON; this
 * function only takes plain objects so tests can drive it with
 * fixtures and the CLI can read from either a file or an API
 * response without branching the diff code.
 */
export function computeMemoryDiff(
  previous: MemorySnapshotLike,
  current: MemorySnapshotLike
): MemoryDiff {
  const facts = diffSlot(previous.facts ?? {}, current.facts ?? {});
  const preferences = diffSlot(previous.preferences ?? {}, current.preferences ?? {});
  const totalChanges =
    Object.keys(facts.added).length + Object.keys(facts.changed).length + Object.keys(facts.removed).length +
    Object.keys(preferences.added).length + Object.keys(preferences.changed).length + Object.keys(preferences.removed).length;
  return { facts, preferences, totalChanges };
}

function renderDiffSlot(io: ProgramIO, label: string, slot: MemoryDiffSlot): void {
  const total = Object.keys(slot.added).length + Object.keys(slot.changed).length + Object.keys(slot.removed).length;
  if (total === 0) return;
  io.stdout(`  ${label}:\n`);
  for (const [key, value] of Object.entries(slot.added)) {
    io.stdout(`    + ${key} = ${value}\n`);
  }
  for (const [key, change] of Object.entries(slot.changed)) {
    io.stdout(`    ~ ${key}: ${change.from} -> ${change.to}\n`);
  }
  for (const [key, value] of Object.entries(slot.removed)) {
    io.stdout(`    - ${key} (was ${value})\n`);
  }
  io.stdout("\n");
}

function diffSlot(prev: Readonly<Record<string, string>>, curr: Readonly<Record<string, string>>): MemoryDiffSlot {
  const added: Record<string, string> = {};
  const changed: Record<string, { from: string; to: string }> = {};
  const removed: Record<string, string> = {};
  for (const [key, value] of Object.entries(curr)) {
    if (!(key in prev)) {
      added[key] = value;
    } else if (prev[key] !== value) {
      changed[key] = { from: prev[key]!, to: value };
    }
  }
  for (const [key, value] of Object.entries(prev)) {
    if (!(key in curr)) {
      removed[key] = value;
    }
  }
  return { added, changed, removed };
}
