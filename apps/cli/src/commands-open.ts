/**
 * `muse open <id-prefix>` — unified lookup across activity stores.
 *
 * `muse history` / `muse status` / `muse remind list` each print
 * 12-char ID prefixes. To inspect one, the user previously had to
 * know which subcommand owns the ID space (followup vs episode vs
 * reminder vs task vs proactive-history). This command scans every
 * known store in a fixed order, returns the first prefix match,
 * and surfaces the full record. Ambiguous matches print a
 * disambiguation list.
 *
 * Probe order:
 *   reminders → followups → objectives → episodes → patterns-fired →
 *   proactive-history → tasks → jobs
 *
 * Pure-read; no LLM, no model invocation.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { readFollowups, readObjectives, readProactiveHistory, readReminders, readTasks } from "@muse/stores";
import type { Command } from "commander";

import { findJobsByIdPrefix } from "./commands-jobs.js";
import type { ProgramIO } from "./program.js";

interface OpenOptions {
  readonly json?: boolean;
  /**
   * Emit ONLY the raw record JSON (no kind header, no
   * `{ kind, record: ... }` envelope, no formatted lines).
   * Designed for `muse open <id> --raw | jq` pipelines.
   */
  readonly raw?: boolean;
}

interface Hit {
  readonly kind: "reminder" | "followup" | "objective" | "episode" | "pattern" | "proactive" | "task" | "job";
  readonly id: string;
  readonly record: Record<string, unknown>;
}

function envOr(key: string, fallbackName: string): string {
  const v = process.env[key]?.trim();
  return v && v.length > 0 ? v : join(homedir(), ".muse", fallbackName);
}

async function safeReadJson(path: string): Promise<unknown | undefined> {
  try {
    const raw = await fs.readFile(path, "utf8");
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function scanAll(prefix: string): Promise<readonly Hit[]> {
  const hits: Hit[] = [];

  for (const r of await readReminders(envOr("MUSE_REMINDERS_FILE", "reminders.json")).catch(() => [])) {
    if (r.id.startsWith(prefix)) hits.push({ kind: "reminder", id: r.id, record: toRecord(r) });
  }

  for (const f of await readFollowups(envOr("MUSE_FOLLOWUPS_FILE", "followups.json")).catch(() => [])) {
    if (f.id.startsWith(prefix)) hits.push({ kind: "followup", id: f.id, record: toRecord(f) });
  }

  // Objectives (standing delegated-autonomy items — `obj_<uuid>`)
  for (const o of await readObjectives(envOr("MUSE_OBJECTIVES_FILE", "objectives.json")).catch(() => [])) {
    if (o.id.startsWith(prefix)) hits.push({ kind: "objective", id: o.id, record: toRecord(o) });
  }

  const episodesDoc = await safeReadJson(envOr("MUSE_EPISODES_FILE", "episodes.json")) as { episodes?: readonly Record<string, unknown>[] } | undefined;
  for (const e of episodesDoc?.episodes ?? []) {
    const id = e["id"];
    if (typeof id === "string" && id.startsWith(prefix)) hits.push({ kind: "episode", id, record: e });
  }

  // Patterns fired (sidecar)
  const patternsDoc = await safeReadJson(envOr("MUSE_PATTERNS_FIRED_FILE", "patterns-fired.json")) as { fired?: readonly Record<string, unknown>[] } | undefined;
  for (const p of patternsDoc?.fired ?? []) {
    const id = p["patternId"];
    if (typeof id === "string" && id.startsWith(prefix)) hits.push({ kind: "pattern", id, record: p });
  }

  for (const entry of await readProactiveHistory(envOr("MUSE_PROACTIVE_HISTORY_FILE", "proactive-history.json")).catch(() => [])) {
    if (entry.itemId.startsWith(prefix)) hits.push({ kind: "proactive", id: entry.itemId, record: toRecord(entry) });
  }

  for (const t of await readTasks(envOr("MUSE_TASKS_FILE", "tasks.json")).catch(() => [])) {
    if (t.id.startsWith(prefix)) hits.push({ kind: "task", id: t.id, record: toRecord(t) });
  }

  // Jobs (background-task records — `muse job run` → ~/.muse/jobs/<id>.jsonl)
  for (const j of await findJobsByIdPrefix(prefix).catch(() => [])) {
    hits.push({ kind: "job", id: j.id, record: j.record });
  }

  return hits;
}

function toRecord<T extends object>(value: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = item;
  }
  return out;
}

export function registerOpenCommand(program: Command, io: ProgramIO): void {
  program
    .command("open")
    .description("Look up an activity record by ID prefix (scans every store; first hit wins, ambiguous matches surfaced)")
    .argument("<prefix>", "Substring matched against record IDs (must be a prefix, e.g. 'rem_a' or 'ep_b')")
    .option("--json", "Emit the matched record as JSON wrapped in { kind, record }")
    .option("--raw", "Emit only the raw record JSON — no kind header, no envelope, no formatted lines. For piping into jq.")
    .action(async (prefix: string, options: OpenOptions) => {
      const trimmed = prefix.trim();
      if (trimmed.length === 0) {
        io.stderr("prefix is required\n");
        process.exitCode = 1;
        return;
      }
      const hits = await scanAll(trimmed);
      // `--raw` only differs from `--json` on the happy path
      // (single unambiguous hit). On 0 / many hits the diagnostic
      // payload is identical to `--json` so jq still sees structured
      // data instead of formatted text. Exit codes are unchanged.
      const wantJson = options.json === true;
      const wantRaw = options.raw === true;
      if (hits.length === 0) {
        if (wantJson || wantRaw) {
          io.stdout(`${JSON.stringify({ matches: 0, prefix: trimmed }, null, 2)}\n`);
        } else {
          io.stdout(`(no records found with id prefix '${trimmed}')\n`);
        }
        process.exitCode = 1;
        return;
      }
      if (hits.length > 1) {
        if (wantJson || wantRaw) {
          io.stdout(`${JSON.stringify({
            ambiguous: true,
            hits: hits.map((h) => ({ kind: h.kind, id: h.id }))
          }, null, 2)}\n`);
        } else {
          io.stdout(`Ambiguous prefix '${trimmed}' matched ${hits.length.toString()} record(s):\n`);
          for (const h of hits) {
            io.stdout(`  [${h.kind}] ${h.id}\n`);
          }
          io.stdout(`(re-run with a longer prefix to disambiguate)\n`);
        }
        process.exitCode = 1;
        return;
      }
      const hit = hits[0]!;
      if (wantRaw) {
        // No envelope — kind is recoverable from the record itself.
        io.stdout(`${JSON.stringify(hit.record, null, 2)}\n`);
        return;
      }
      if (wantJson) {
        io.stdout(`${JSON.stringify({ kind: hit.kind, record: hit.record }, null, 2)}\n`);
        return;
      }
      io.stdout(`[${hit.kind}] ${hit.id}\n\n`);
      for (const [k, v] of Object.entries(hit.record)) {
        if (v === undefined || v === null) continue;
        const display = typeof v === "string" ? v : JSON.stringify(v);
        io.stdout(`  ${k}: ${display}\n`);
      }
    });
}
