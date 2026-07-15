/**
 * `muse journey` — one reverse-chronological "what Muse learned about you"
 * timeline, merged across the stores that separately hold the pieces: the
 * fact validity chain (belief-provenance log), authored skills, and
 * playbook strategies. Local-only (no API server round-trip), matching
 * `muse playbook` / `muse skills`. Corrections/decays are NOT journeyed —
 * the playbook only tracks a running decay COUNT, not a per-event
 * timestamp, so a decay event would be an invented date; the CLI says so
 * rather than fabricating one.
 */

import {
  defaultBeliefProvenanceFile,
  FileBeliefProvenanceStore,
  FileUserMemoryStore,
  normalizeMemoryKey,
  recordRetraction,
  type BeliefProvenance
} from "@muse/memory";
import { resolveAuthoredSkillsDir, resolvePlaybookFile, type MuseEnvironment } from "@muse/autoconfigure";
import { isRecord } from "@muse/shared";
import { AuthoredSkillStore } from "@muse/skills";
import {
  factRecordsFromProvenance,
  mergeJourneyEvents,
  queryPlaybook,
  removePlaybookStrategy,
  resolveJourneyForgetTarget,
  type JourneyEvent,
  type JourneyFactRecord,
  type JourneySkillRecord,
  type JourneyStoreKind,
  type JourneyStrategyRecord
} from "@muse/stores";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";
import { resolveDefaultUserKey } from "./user-id.js";
import { withBestEffort } from "./async-promises.js";

const JOURNEY_KINDS: readonly JourneyStoreKind[] = ["fact", "skill", "strategy"];
const JOURNEY_KIND_SET = new Set<string>(JOURNEY_KINDS);
const EMPTY_BELIEF_PROVENANCE: readonly BeliefProvenance[] = [];

function environment(): MuseEnvironment {
  return process.env;
}

function isJourneyStoreKind(value: string): value is JourneyStoreKind {
  return JOURNEY_KIND_SET.has(value);
}

async function loadFactRecords(userId: string): Promise<readonly JourneyFactRecord[]> {
  const store = new FileBeliefProvenanceStore(defaultBeliefProvenanceFile());
  const records = await withBestEffort(store.query(userId), EMPTY_BELIEF_PROVENANCE);
  return factRecordsFromProvenance(records);
}

async function loadSkillRecords(): Promise<readonly JourneySkillRecord[]> {
  const store = new AuthoredSkillStore({ dir: resolveAuthoredSkillsDir(environment()) });
  const skills = await withBestEffort(store.listAuthored(), []);
  return skills.map((skill) => {
    const muse = isRecord(skill.frontmatter.metadata?.["muse"]) ? skill.frontmatter.metadata["muse"] : {};
    const authoredAt = typeof muse.authoredAt === "string" ? muse.authoredAt : undefined;
    const lastUsedAt = typeof muse.lastUsedAt === "string" ? muse.lastUsedAt : undefined;
    return {
      description: skill.description,
      name: skill.name,
      ...(authoredAt ? { authoredAt } : {}),
      ...(lastUsedAt ? { lastUsedAt } : {})
    };
  });
}

async function loadStrategyRecords(userId: string): Promise<readonly JourneyStrategyRecord[]> {
  const entries = await withBestEffort(queryPlaybook(resolvePlaybookFile(environment()), userId), []);
  return entries.map((entry) => ({
    createdAt: entry.createdAt,
    id: entry.id,
    text: entry.text,
    ...(entry.lastReinforcedAt ? { lastReinforcedAt: entry.lastReinforcedAt } : {})
  }));
}

async function loadJourneyEvents(
  userId: string,
  options: { readonly kind?: JourneyStoreKind; readonly since?: string; readonly limit?: number }
): Promise<readonly JourneyEvent[]> {
  const [facts, skills, strategies] = await Promise.all([
    loadFactRecords(userId),
    loadSkillRecords(),
    loadStrategyRecords(userId)
  ]);
  return mergeJourneyEvents({ facts, skills, strategies, ...options });
}

function formatEvent(event: JourneyEvent): string {
  const date = event.at.slice(0, 10);
  const ref = event.ref ? `  [${event.storeKind}:${event.ref}]` : "";
  return `${date}  ${event.eventKind.padEnd(10)}  ${event.content}${ref}\n`;
}

const NO_HISTORY_FOOTER =
  "(no history recorded: playbook decay events — the playbook tracks a running decay COUNT per strategy, not a per-event timestamp, so a decay can't be placed on a timeline honestly)\n";

interface JourneyOptions {
  readonly user?: string;
  readonly kind?: string;
  readonly since?: string;
  readonly limit?: string;
  readonly json?: boolean;
}

function parseJourneyOptions(options: JourneyOptions): { readonly kind?: JourneyStoreKind; readonly since?: string; readonly limit?: number } {
  if (options.kind !== undefined && !isJourneyStoreKind(options.kind)) {
    throw new Error(`--kind must be one of: ${JOURNEY_KINDS.join(", ")} (got '${options.kind}')`);
  }
  let limit: number | undefined;
  if (options.limit !== undefined) {
    const trimmed = options.limit.trim();
    limit = /^\d+$/u.test(trimmed) ? Number(trimmed) : Number.NaN;
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error(`--limit must be a positive integer (got '${options.limit}')`);
    }
  }
  if (options.since !== undefined && !Number.isFinite(Date.parse(options.since))) {
    throw new Error(`--since must be a valid ISO date (got '${options.since}')`);
  }
  return {
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.since ? { since: options.since } : {}),
    ...(limit !== undefined ? { limit } : {})
  };
}

export function registerJourneyCommands(program: Command, io: ProgramIO): void {
  const journey = program
    .command("journey")
    .description("One chronological timeline of what Muse has learned about you — facts, skills, strategies")
    .option("--user <id>", "User identity (default $MUSE_USER_ID or $USER)")
    .option("--kind <kind>", `Filter by store: ${JOURNEY_KINDS.join(" | ")}`)
    .option("--since <date>", "Only events at/after this ISO date")
    .option("--limit <n>", "Max events, newest first", "50")
    .option("--json", "Print the raw event list instead of the formatted timeline")
    .action(async (options: JourneyOptions, command: Command) => {
      try {
        const userId = resolveDefaultUserKey({ override: options.user });
        const parsed = parseJourneyOptions(options);
        const events = await loadJourneyEvents(userId, parsed);
        if (options.json) {
          io.stdout(`${JSON.stringify(events, null, 2)}\n`);
          return;
        }
        if (events.length === 0) {
          io.stdout("(no learning events recorded yet)\n");
        } else {
          io.stdout(`Your journey with Muse (${events.length.toString()} event${events.length === 1 ? "" : "s"}, newest first):\n`);
          for (const event of events) {
            io.stdout(formatEvent(event));
          }
        }
        if (!parsed.kind || parsed.kind === "strategy") {
          io.stdout(NO_HISTORY_FOOTER);
        }
      } catch (cause) {
        io.stderr(`${cause instanceof Error ? cause.message : String(cause)}\n`);
        command.error("journey failed", { exitCode: 1 });
      }
    });

  journey
    .command("forget")
    .description("Remove one journey entry by its ref — delegates to the same removal path as `memory forget` / `playbook remove` (skills have no safe single-entry delete)")
    .argument("<ref>", "Ref id shown in `muse journey` (a fact key, playbook id, or skill name)")
    .option("--user <id>", "User identity (default $MUSE_USER_ID or $USER)")
    .action(async (ref: string, options: { readonly user?: string }, command: Command) => {
      try {
        const userId = resolveDefaultUserKey({ override: options.user });
        const events = await loadJourneyEvents(userId, {});
        const target = resolveJourneyForgetTarget(events, ref);
        if (!target) {
          io.stdout(`(no journey entry matches "${ref}")\n`);
          return;
        }
        if (target.storeKind === "fact") {
          const store = new FileUserMemoryStore();
          const removed = await store.forget(userId, target.ref);
          if (removed) {
            try {
              await recordRetraction(new FileBeliefProvenanceStore(defaultBeliefProvenanceFile()), userId, normalizeMemoryKey(target.ref));
            } catch { /* provenance is best-effort; the forget already succeeded */ }
          }
          io.stdout(removed
            ? `Forgot "${normalizeMemoryKey(target.ref)}" (user=${userId})\n`
            : `(nothing remembered under "${target.ref}" — already forgotten or never stored)\n`);
          return;
        }
        if (target.storeKind === "strategy") {
          await removePlaybookStrategy(resolvePlaybookFile(environment()), target.ref);
          io.stdout(`Removed strategy [${target.ref.slice(0, 12)}]\n`);
          return;
        }
        io.stdout(
          `Skills have no safe single-entry delete — "${target.ref}" was authored, not deleted.\n` +
          `Use \`muse skills curate --max-idle-days <n>\` to archive it once idle, or \`muse skills consolidate --apply\` to merge overlapping skills (both archive, never destroy).\n`
        );
      } catch (cause) {
        io.stderr(`${cause instanceof Error ? cause.message : String(cause)}\n`);
        command.error("journey forget failed", { exitCode: 1 });
      }
    });
}
