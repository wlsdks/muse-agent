/**
 * `muse objectives` — the user entry point to the standing-objective
 * delegated-autonomy chain (store → daemon). Local mode over
 * the shared `~/.muse/objectives.json`, the same file the
 * objectives daemon ticks, so a CLI-registered objective is picked
 * up on the next tick with no API server required.
 */

import { randomUUID } from "node:crypto";

import { resolveObjectivesFile } from "@muse/autoconfigure";
import { addObjective, patchObjective, readObjectives, serializeObjective, type ObjectiveKind, type ObjectiveStatus } from "@muse/stores";
import type { Command } from "commander";

import { closestCommandName } from "./closest-command.js";
import type { ProgramIO } from "./program.js";

const KINDS = ["watch", "until", "notify"] as const;
const STATUS_FILTERS = ["active", "done", "escalated", "cancelled", "all"] as const;

function objectivesFile(): string {
  return resolveObjectivesFile(process.env as Record<string, string | undefined>);
}

function assertOneOf(raw: string, allowed: readonly string[], flag: string): void {
  const v = raw.trim().toLowerCase();
  if (allowed.includes(v)) {
    return;
  }
  const hint = closestCommandName(v, allowed);
  throw new Error(`${flag} must be one of: ${allowed.join(", ")} (got '${raw}')${hint ? ` — did you mean '${hint}'?` : ""}`);
}

type ResolvedObjectiveId =
  | { readonly kind: "match"; readonly id: string }
  | { readonly kind: "ambiguous"; readonly count: number; readonly preview: string }
  | { readonly kind: "none" };

/**
 * Resolve an objective id from an exact id OR an unambiguous prefix —
 * so a user cancels with the short head of `obj_<uuid>` instead of
 * pasting the whole thing, matching `muse followup` / `muse calendar`.
 * Exact match wins; otherwise a single prefix match resolves; an empty
 * input or >1 prefix match never silently picks one.
 */
function resolveObjectiveId(input: string, all: readonly { readonly id: string }[]): ResolvedObjectiveId {
  if (input.length === 0) {
    return { kind: "none" };
  }
  if (all.some((o) => o.id === input)) {
    return { id: input, kind: "match" };
  }
  const matches = all.filter((o) => o.id.startsWith(input));
  if (matches.length === 0) {
    return { kind: "none" };
  }
  if (matches.length > 1) {
    return { count: matches.length, kind: "ambiguous", preview: matches.slice(0, 5).map((o) => o.id.slice(0, 16)).join(", ") };
  }
  return { id: matches[0]!.id, kind: "match" };
}

export function registerObjectivesCommands(program: Command, io: ProgramIO): void {
  const objectives = program
    .command("objectives")
    .description("Standing objectives Muse pursues autonomously (watch X / until Z / tell me when W)");

  objectives
    .command("add <spec...>")
    .description("Register a standing objective")
    .option("--kind <kind>", `objective kind: ${KINDS.join(" | ")}`, "until")
    .option("--user <id>", "owner bucket", "local")
    .action(async (spec: string[], options: { readonly kind: string; readonly user: string }, command: Command) => {
      try {
        assertOneOf(options.kind, KINDS, "--kind");
        const text = spec.join(" ").trim();
        if (text.length === 0) {
          throw new Error("objective spec must not be empty");
        }
        const id = `obj_${randomUUID()}`;
        await addObjective(objectivesFile(), {
          createdAt: new Date().toISOString(),
          id,
          kind: options.kind.trim().toLowerCase() as ObjectiveKind,
          spec: text,
          status: "active",
          userId: options.user.trim() || "local"
        });
        io.stdout(`Registered objective ${id}: ${text}\n`);
      } catch (cause) {
        io.stderr(`${cause instanceof Error ? cause.message : String(cause)}\n`);
        command.error("objectives add failed", { exitCode: 1 });
      }
    });

  objectives
    .command("list")
    .description("List standing objectives")
    .option("--status <status>", `filter: ${STATUS_FILTERS.join(" | ")}`, "active")
    .option("--user <id>", "owner bucket", "local")
    .option("--json", "Print the raw payload instead of the formatted list")
    .action(async (options: { readonly status: string; readonly user: string; readonly json?: boolean }, command: Command) => {
      try {
        assertOneOf(options.status, STATUS_FILTERS, "--status");
        const filter = options.status.trim().toLowerCase();
        const ownerBucket = options.user.trim() || "local";
        const all = (await readObjectives(objectivesFile())).filter((o) => o.userId === ownerBucket);
        const shown = filter === "all" ? all : all.filter((o) => o.status === (filter as ObjectiveStatus));
        if (options.json) {
          const payload = {
            objectives: shown.map(serializeObjective),
            status: filter,
            total: shown.length,
            user: ownerBucket
          };
          io.stdout(`${JSON.stringify(payload, null, 2)}\n`);
          return;
        }
        if (shown.length === 0) {
          io.stdout('No objectives yet. Register one with `muse objectives add "watch the deploy until it is green"`.\n');
          return;
        }
        for (const o of shown) {
          io.stdout(`${o.id}  [${o.status}/${o.kind}]  ${o.spec}\n`);
        }
      } catch (cause) {
        io.stderr(`${cause instanceof Error ? cause.message : String(cause)}\n`);
        command.error("objectives list failed", { exitCode: 1 });
      }
    });

  // Shared resolve-then-patch for the terminal transitions (cancel /
  // done): both take an id-or-unambiguous-prefix, flip the status,
  // and record a CLI resolution. Keeps the two verbs identical except
  // for the target status + wording.
  const transitionObjective = async (
    id: string,
    command: Command,
    target: { readonly status: ObjectiveStatus; readonly resolution: string; readonly failLabel: string; readonly okWord: string }
  ): Promise<void> => {
    const all = await readObjectives(objectivesFile());
    const resolved = resolveObjectiveId(id.trim(), all);
    if (resolved.kind === "ambiguous") {
      io.stderr(`ambiguous objective id '${id}' — matches ${resolved.count.toString()} (${resolved.preview}…)\n`);
      command.error(target.failLabel, { exitCode: 1 });
      return;
    }
    if (resolved.kind === "none") {
      const suggestion = closestCommandName(id.trim(), all.map((o) => o.id));
      const hint = suggestion ? ` — did you mean '${suggestion}'?` : "";
      io.stderr(`no objective with id '${id}'${hint}\n`);
      command.error(target.failLabel, { exitCode: 1 });
      return;
    }
    const patched = await patchObjective(objectivesFile(), resolved.id, {
      resolution: target.resolution,
      status: target.status
    });
    if (!patched) {
      io.stderr(`no objective with id '${id}'\n`);
      command.error(target.failLabel, { exitCode: 1 });
      return;
    }
    io.stdout(`${target.okWord} ${resolved.id}\n`);
  };

  objectives
    .command("cancel <id>")
    .description("Cancel a standing objective (it stops being re-evaluated — you gave up on it)")
    .action(async (id: string, _options: unknown, command: Command) => {
      await transitionObjective(id, command, {
        failLabel: "objectives cancel failed",
        okWord: "Cancelled",
        resolution: "cancelled via CLI",
        status: "cancelled"
      });
    });

  objectives
    .command("done <id>")
    .description("Mark a standing objective accomplished (distinct from cancel — you achieved it)")
    .action(async (id: string, _options: unknown, command: Command) => {
      await transitionObjective(id, command, {
        failLabel: "objectives done failed",
        okWord: "Marked done",
        resolution: "completed via CLI",
        status: "done"
      });
    });
}
