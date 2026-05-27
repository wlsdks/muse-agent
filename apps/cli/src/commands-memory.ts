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

import { defaultBeliefProvenanceFile, FileBeliefProvenanceStore, FileUserMemoryStore, normalizeMemoryKey } from "@muse/memory";
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

export interface MemorySearchHit {
  readonly source: "fact" | "preference";
  readonly key: string;
  readonly value: string;
}

/**
 * Substring-search remembered facts & preferences by key OR value
 * (case-insensitive). Facts are listed before preferences. Pure — the
 * command layer loads the maps and renders the hits.
 */
export function searchMemoryEntries(
  facts: Readonly<Record<string, string>>,
  preferences: Readonly<Record<string, string>>,
  query: string
): MemorySearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return [];
  }
  const match = (k: string, v: string): boolean => k.toLowerCase().includes(needle) || v.toLowerCase().includes(needle);
  const hits: MemorySearchHit[] = [];
  for (const [key, value] of Object.entries(facts)) {
    if (match(key, value)) hits.push({ key, source: "fact", value });
  }
  for (const [key, value] of Object.entries(preferences)) {
    if (match(key, value)) hits.push({ key, source: "preference", value });
  }
  return hits;
}

export interface FactTimelineEntry {
  readonly key: string;
  readonly current?: string;
  readonly since?: string;
  readonly previous: ReadonlyArray<{ readonly value: string; readonly until: string }>;
}

/**
 * Build the validity timeline for remembered facts (Zep, arXiv 2501.13956:
 * supersede-don't-delete). Each key shows its CURRENT value, when it took
 * effect (`since` = the last supersession), and the chain of prior values
 * each valid `until` it was replaced (newest-first). With no `keyFilter`,
 * only keys that actually CHANGED are returned (a flat never-changed fact has
 * no story to tell); with a `keyFilter`, that one key is always returned
 * (current value + any history). A key present only in history (the fact was
 * later forgotten) is included with `current` undefined.
 */
export function buildFactTimeline(
  facts: Readonly<Record<string, string>>,
  factHistory: readonly { readonly key: string; readonly previousValue: string; readonly replacedAt: Date }[] | undefined,
  keyFilter?: string
): FactTimelineEntry[] {
  const wanted = keyFilter ? normalizeMemoryKey(keyFilter) : undefined;
  const byKey = new Map<string, { readonly previousValue: string; readonly replacedAt: Date }[]>();
  for (const entry of factHistory ?? []) {
    if (wanted && entry.key !== wanted) continue;
    const list = byKey.get(entry.key) ?? [];
    list.push({ previousValue: entry.previousValue, replacedAt: entry.replacedAt });
    byKey.set(entry.key, list);
  }
  const keys = new Set<string>(byKey.keys());
  if (wanted) keys.add(wanted);
  const out: FactTimelineEntry[] = [];
  for (const key of keys) {
    const history = (byKey.get(key) ?? [])
      .slice()
      .sort((a, b) => a.replacedAt.getTime() - b.replacedAt.getTime());
    const since = history.length > 0 ? history[history.length - 1]!.replacedAt.toISOString() : undefined;
    const previous = history
      .map((h) => ({ value: h.previousValue, until: h.replacedAt.toISOString() }))
      .reverse();
    out.push({
      key,
      ...(key in facts ? { current: facts[key] } : {}),
      ...(since ? { since } : {}),
      previous
    });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Render `muse memory why <key>` from the newest-first provenance records the
 * store returned. Uses the latest (records[0]); a forgotten/untracked key
 * yields a friendly note. Pure for testability.
 */
export function formatBeliefWhy(
  records: ReadonlyArray<{ readonly kind: string; readonly key: string; readonly value: string; readonly learnedAt: string; readonly evidenceExcerpt?: string; readonly sessionId?: string }>,
  key: string
): string {
  const latest = records[0];
  if (!latest) {
    return `(no recorded provenance for "${key}" — learned before provenance tracking, or not remembered)\n`;
  }
  const lines = [`${latest.kind} ${latest.key} = ${latest.value} — learned ${latest.learnedAt}`];
  if (latest.evidenceExcerpt) {
    lines.push(`  ↳ from your message: "${latest.evidenceExcerpt}"`);
  }
  if (latest.sessionId) {
    lines.push(`  ↳ session ${latest.sessionId}`);
  }
  return `${lines.join("\n")}\n`;
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
    .command("search")
    .description("Search remembered facts & preferences by key or value")
    .argument("<query...>", "Text to search for, e.g. `muse memory search city`")
    .option("--user <id>", "User identity (default $MUSE_USER_ID or $USER)")
    .option("--persona <slot>", "Persona slot (work / home / hobby / …)")
    .option("--json", "Print the raw hits instead of the formatted list")
    .action(async (parts: string[], options: MemoryCommonOptions) => {
      const userId = resolveMemoryUserId(options.user, options.persona);
      const store = new FileUserMemoryStore();
      const record = await store.findByUserId(userId);
      const hits = searchMemoryEntries(record?.facts ?? {}, record?.preferences ?? {}, parts.join(" "));
      if (options.json) {
        helpers.writeOutput(io, hits);
        return;
      }
      if (hits.length === 0) {
        io.stdout(`(no memory entries match "${parts.join(" ").trim()}")\n`);
        return;
      }
      io.stdout(`Memory matches for "${parts.join(" ").trim()}" (${hits.length.toString()}):\n`);
      for (const h of hits) {
        io.stdout(`  [${h.source}] ${h.key}: ${h.value}\n`);
      }
    });

  memory
    .command("history")
    .description("Show how a remembered fact changed over time (what it used to be + when)")
    .argument("[key]", "Fact key to trace, e.g. `muse memory history home_city`; omit to list every changed fact")
    .option("--user <id>", "User identity (default $MUSE_USER_ID or $USER)")
    .option("--persona <slot>", "Persona slot (work / home / hobby / …)")
    .option("--json", "Print the raw timeline instead of the formatted view")
    .action(async (key: string | undefined, options: MemoryCommonOptions) => {
      const userId = resolveMemoryUserId(options.user, options.persona);
      const store = new FileUserMemoryStore();
      const record = await store.findByUserId(userId);
      const timeline = buildFactTimeline(record?.facts ?? {}, record?.factHistory, key);
      if (options.json) {
        helpers.writeOutput(io, timeline);
        return;
      }
      if (timeline.length === 0) {
        io.stdout(key
          ? `(no history for "${key}" — it has never changed, or isn't remembered)\n`
          : "(no remembered fact has changed yet)\n");
        return;
      }
      for (const entry of timeline) {
        const current = entry.current === undefined ? "(no longer remembered)" : entry.current;
        const since = entry.since ? ` (since ${entry.since})` : "";
        io.stdout(`${entry.key}: ${current}${since}\n`);
        for (const prev of entry.previous) {
          io.stdout(`  ↳ was "${prev.value}" until ${prev.until}\n`);
        }
      }
    });

  memory
    .command("why")
    .description("Show WHY Muse remembers a fact — when + which conversation it was learned from")
    .argument("<key>", "Fact / preference key, e.g. `muse memory why home_city`")
    .option("--user <id>", "User identity (default $MUSE_USER_ID or $USER)")
    .option("--persona <slot>", "Persona slot (work / home / hobby / …)")
    .option("--json", "Print the raw provenance records instead of the formatted view")
    .action(async (key: string, options: MemoryCommonOptions) => {
      const userId = resolveMemoryUserId(options.user, options.persona);
      const store = new FileBeliefProvenanceStore(defaultBeliefProvenanceFile());
      const records = await store.query(userId, normalizeMemoryKey(key));
      if (options.json) {
        helpers.writeOutput(io, records);
        return;
      }
      io.stdout(formatBeliefWhy(records, key));
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
