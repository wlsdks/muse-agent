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

import { isMemoryInjection } from "@muse/agent-core";
import { classifyFactFreshness, consolidationPlan, defaultBeliefProvenanceFile, deriveFactProvenance, FileBeliefProvenanceStore, FileUserMemoryStore, normalizeMemoryKey, recordRetraction, selectPromotableFacts, selectPromotableMemories, type BeliefProvenance, type ConsolidationPlan } from "@muse/memory";
import { resolveFadedMemoriesFile, resolveRecallHitsFile } from "@muse/autoconfigure";
import { readRecallHits, writeFadedMemoryKeys, type RecallHitRecord } from "@muse/mcp";
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
/** Render one sleep-consolidation pass as an honest, non-destructive readout. Pure. */
export function formatConsolidationPlan(plan: ConsolidationPlan): string {
  if (plan.promote.length === 0 && plan.fade.length === 0) {
    return "🌙 Sleep consolidation: nothing to consolidate yet — recall a few memories first.\n";
  }
  const lines = ["🌙 Sleep consolidation (recall-driven; non-destructive)"];
  if (plan.promote.length > 0) {
    lines.push(`  ↑ promoting ${plan.promote.length.toString()} salient (re-engaged):`);
    for (const memory of plan.promote) {
      lines.push(`    • ${memory.key}  (score ${memory.score.toFixed(2)}, ${memory.hits.toString()}× recalled)`);
    }
  }
  if (plan.fade.length > 0) {
    lines.push(`  ↓ fading ${plan.fade.length.toString()} (idle + decayed — down-ranked in recall; kept, not deleted):`);
    for (const memory of plan.fade) {
      lines.push(`    • ${memory.key}  (score ${memory.score.toFixed(2)}, idle ${Math.round(memory.ageDays).toString()}d)`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function formatBeliefWhy(
  records: ReadonlyArray<{ readonly kind: string; readonly key: string; readonly value: string; readonly learnedAt: string; readonly evidenceExcerpt?: string; readonly sessionId?: string; readonly source?: "auto" | "user" }>,
  key: string,
  nowMs: number = Date.now()
): string {
  const prov = deriveFactProvenance(records as unknown as readonly BeliefProvenance[]).find((p) => p.key === key);
  if (!prov) {
    return `(no recorded provenance for "${key}" — learned before provenance tracking, or not remembered)\n`;
  }
  const verb = prov.source === "user" ? "you set this directly" : "learned";
  const freshness = classifyFactFreshness({ lastConfirmed: prov.lastConfirmed, now: nowMs });
  // Has it cleared the durable-promotion gate? (user-stated, or auto + re-confirmed
  // recently, and never an injection-flagged value.)
  const durable = selectPromotableFacts([prov], { isInjection: isMemoryInjection, now: nowMs }).length > 0;
  // A belief whose value FLIPPED across confirmations is volatile (it's why an
  // often-confirmed fact can still be provisional — H2).
  const volatileNote = prov.distinctValueCount > 1 ? ` · value changed ${prov.distinctValueCount.toString()}× (volatile)` : "";
  const lines = [
    `${prov.kind} ${prov.key} = ${prov.value} — ${verb} ${prov.lastConfirmed}`,
    `  ↳ confirmed ${prov.confirmCount.toString()}× since ${prov.firstSeen} · ${freshness} · ${durable ? "durable" : "provisional"}${volatileNote}`
  ];
  // The newest record carries the evidence excerpt / session; the excerpt only
  // exists for inferred (auto) beliefs.
  const latest = [...records]
    .filter((r) => r.key === key)
    .sort((a, b) => Date.parse(b.learnedAt) - Date.parse(a.learnedAt))[0];
  if (prov.source !== "user" && latest?.evidenceExcerpt) {
    lines.push(`  ↳ from your message: "${latest.evidenceExcerpt}"`);
  }
  if (latest?.sessionId) {
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
    .command("consolidate")
    .description("Sleep consolidation: promotes salient recalled memories, down-ranks fading ones in recall (never deletes)")
    .option("--json", "Print the raw plan")
    .action(async (options: { readonly json?: boolean }) => {
      const env = process.env as Record<string, string | undefined>;
      const file = resolveRecallHitsFile(env);
      const records = await readRecallHits(file);
      const nowMs = Date.now();
      const plan = consolidationPlan(
        records.map((record) => ({ hits: record.hits, key: record.key, lastHitMs: record.lastHitMs, recentAccessMs: record.recentAccessMs })),
        { nowMs, useActrRanking: true }
      );
      // Close the Ebbinghaus forgetting loop (arXiv:2305.10250, MemoryBank):
      // write fading keys to the sidecar so the episodic ranker can down-rank
      // them. Overwrite every run — reinstatement is automatic: a session
      // re-engaged between runs drops out of selectForgettable, so the
      // next consolidation writes a file that no longer contains it.
      const fadeKeys = plan.fade.map((m) => m.key);
      await writeFadedMemoryKeys(resolveFadedMemoriesFile(env), fadeKeys, nowMs);
      if (options.json) {
        helpers.writeOutput(io, plan);
        return;
      }
      io.stdout(formatConsolidationPlan(plan));
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
    .command("forget")
    .description("Forget ONE remembered fact/preference by key (vs `clear`, which wipes everything)")
    .argument("<key>", "Memory key to drop, e.g. `muse memory forget home_city`")
    .option("--user <id>", "User identity (default $MUSE_USER_ID or $USER)")
    .option("--persona <slot>", "Persona slot (work / home / hobby / …)")
    .action(async (key: string, options: MemoryCommonOptions) => {
      const userId = resolveMemoryUserId(options.user, options.persona);
      const store = new FileUserMemoryStore();
      const removed = await store.forget(userId, key);
      // Record a RETRACTION marker so the auto-extractor won't silently resurface
      // the fact the user just forgot (source: user > auto). Fail-open. Only when
      // something was actually removed — a no-op forget records nothing.
      if (removed) {
        try {
          await recordRetraction(new FileBeliefProvenanceStore(defaultBeliefProvenanceFile()), userId, normalizeMemoryKey(key));
        } catch { /* provenance is best-effort; the forget already succeeded */ }
      }
      io.stdout(removed
        ? `Forgot "${normalizeMemoryKey(key)}" (user=${userId})\n`
        : `(nothing remembered under "${key}" — already forgotten or never stored)\n`);
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
        // Record user-provenance: a direct `set` is a user-stated truth, not
        // an inference. Fail-open — a provenance write never blocks the set.
        try {
          await new FileBeliefProvenanceStore(defaultBeliefProvenanceFile()).record({
            userId,
            key: normalizeMemoryKey(key),
            kind: segment === "facts" ? "fact" : "preference",
            value,
            learnedAt: new Date().toISOString(),
            source: "user"
          });
        } catch {
          // provenance is best-effort; the memory write already succeeded
        }
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

  memory
    .command("promote")
    .description("Dreaming: promote your most recall-useful past sessions into the always-on persona (frequently-recalled memories)")
    .option("--user <id>", "User identity (default $MUSE_USER_ID or $USER)")
    .option("--persona <slot>", "Persona slot (work / home / hobby / …); falls back to MUSE_PERSONA env")
    .option("--min-hits <n>", "Minimum recall hits to be eligible (default 3)")
    .option("--max <n>", "Max memories to promote (default 3)")
    .option("--json", "Print the raw payload")
    .action(async (options: MemoryCommonOptions & { readonly minHits?: string; readonly max?: string }) => {
      const userId = resolveMemoryUserId(options.user, options.persona);
      const result = await promoteRecalledMemories({
        store: new FileUserMemoryStore(),
        userId,
        readHits: () => readRecallHits(resolveRecallHitsFile(process.env)),
        ...(options.minHits !== undefined ? { minHits: Number(options.minHits) } : {}),
        ...(options.max !== undefined ? { maxPromoted: Number(options.max) } : {})
      });
      if (options.json) {
        io.stdout(`${JSON.stringify({ promoted: result.promoted, total: result.promoted.length }, null, 2)}\n`);
        return;
      }
      if (result.promoted.length === 0) {
        io.stdout("Nothing to promote yet — no past session has been recalled often enough.\n");
        return;
      }
      io.stdout(`Promoted ${result.promoted.length.toString()} frequently-recalled memor${result.promoted.length === 1 ? "y" : "ies"} into your always-on persona:\n`);
      for (const p of result.promoted) {
        io.stdout(`  • ${p.summary}  (recalled ${p.hits.toString()}×)\n`);
      }
    });

  memory
    .command("encrypt")
    .description("Encrypt your user-memory AT REST (AES-256-GCM). Reads/writes stay transparent; a plaintext backup is kept. Set MUSE_MEMORY_KEY for a portable key (else a per-host key is used).")
    .action(async () => {
      const store = new FileUserMemoryStore();
      try {
        const { alreadyEncrypted, backupPath } = await store.encryptAtRest();
        if (alreadyEncrypted) {
          io.stdout("Your user-memory is already encrypted at rest.\n");
          return;
        }
        io.stdout("🔒 Encrypted your user-memory at rest (AES-256-GCM).\n");
        io.stdout(`   A plaintext backup is at: ${backupPath ?? "(none)"}\n`);
        io.stdout("   The key comes from MUSE_MEMORY_KEY (or a per-host fallback). Keep MUSE_MEMORY_KEY safe — without it AND the backup, the data is unrecoverable.\n");
      } catch (cause) {
        io.stderr(`muse memory encrypt: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        process.exitCode = 1;
      }
    });

  memory
    .command("decrypt")
    .description("Reverse encryption-at-rest — rewrite your user-memory as plaintext (needs the correct MUSE_MEMORY_KEY / per-host key)")
    .action(async () => {
      const store = new FileUserMemoryStore();
      try {
        const { alreadyPlaintext } = await store.decryptAtRest();
        io.stdout(alreadyPlaintext ? "Your user-memory is already plaintext.\n" : "🔓 Rewrote your user-memory as plaintext.\n");
      } catch (cause) {
        io.stderr(`muse memory decrypt: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        process.exitCode = 1;
      }
    });

  memory
    .command("encryption-status")
    .description("Show whether your user-memory is encrypted at rest")
    .action(async () => {
      const store = new FileUserMemoryStore();
      io.stdout(await store.isEncryptedAtRest()
        ? "🔒 encrypted at rest (AES-256-GCM)\n"
        : "🔓 plaintext (run `muse memory encrypt` to protect it at rest)\n");
    });
}

interface PromoteMemoriesStore {
  findByUserId(userId: string): Promise<{ readonly facts: Record<string, string> } | undefined>;
  upsertFact(userId: string, key: string, value: string): Promise<unknown>;
  forget(userId: string, key: string): Promise<unknown> | unknown;
}

export interface PromoteMemoriesResult {
  readonly promoted: readonly { readonly key: string; readonly hits: number; readonly summary: string }[];
}

const PROMOTED_FACT_PREFIX = "recalled-";

/**
 * Dreaming pass: read recall-hit records, select the most recall-useful
 * memories (`selectPromotableMemories`), and write their summaries into the
 * always-on persona as `recalled-N` facts (which the persona renderer already
 * surfaces). Idempotent — clears the prior `recalled-*` facts first so a memory
 * that's no longer top-ranked drops out instead of accumulating. Store is
 * injected so it's testable without a real `~/.muse` file.
 */
export async function promoteRecalledMemories(options: {
  readonly store: PromoteMemoriesStore;
  readonly userId: string;
  readonly readHits: () => Promise<readonly RecallHitRecord[]>;
  readonly now?: () => Date;
  readonly minHits?: number;
  readonly maxPromoted?: number;
}): Promise<PromoteMemoriesResult> {
  const nowMs = (options.now ? options.now() : new Date()).getTime();
  const hits = await options.readHits().catch(() => []);
  const promotable = selectPromotableMemories(hits, {
    nowMs,
    useActrRanking: true,
    ...(options.minHits !== undefined ? { minHits: options.minHits } : {}),
    ...(options.maxPromoted !== undefined ? { maxPromoted: options.maxPromoted } : {})
  });

  // Clear prior promoted facts so promotion is idempotent (today's top set
  // fully replaces yesterday's — a faded-out memory doesn't linger).
  const current = await options.store.findByUserId(options.userId).catch(() => undefined);
  for (const key of Object.keys(current?.facts ?? {})) {
    if (key.startsWith(PROMOTED_FACT_PREFIX)) {
      await options.store.forget(options.userId, key);
    }
  }

  const summaryByKey = new Map(hits.map((record) => [record.key, record.summary]));
  const promoted: { key: string; hits: number; summary: string }[] = [];
  let index = 1;
  for (const memory of promotable) {
    const summary = summaryByKey.get(memory.key)?.trim() || `past session ${memory.key}`;
    await options.store.upsertFact(options.userId, `${PROMOTED_FACT_PREFIX}${index.toString()}`, summary);
    promoted.push({ hits: memory.hits, key: memory.key, summary });
    index += 1;
  }
  return { promoted };
}

/**
 * Accept singular / plural forms for both kinds and
 * surface a closest-match hint on typos. Previously a user typing
 * `muse memory set preferene name Stark` got a flat "kind must be
 * 'fact' or 'preference'" — no clue which of the four valid forms
 * they were closest to.
 */
const MEMORY_KIND_FORMS = ["fact", "facts", "preference", "preferences"] as const;

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
