/**
 * `muse work` — docs/design/muse-work.md. A Work is a reference-only BINDING
 * (one-line goal + the flows/board-tasks/thread that belong to it + an
 * outcome history) — it never executes anything itself. Mirrors `muse tasks`'
 * API-first / `--local` fallback convention so this works with or without
 * the API server running.
 */

import { deleteWorkContinuitySafe, projectWorkContinuity, setWorkContinuityThread } from "@muse/attunement";
import { resolveAttunementFile, resolveWorksFile } from "@muse/autoconfigure";
import { defaultBoardFile, readBoard } from "@muse/multi-agent";
import { FileScheduledJobStore } from "@muse/scheduler";
import {
  addWorkOutcome,
  createWork,
  getWork,
  linkWorkBoardTask,
  linkWorkFlow,
  listWorks,
  markWorkDone,
  serializeWork,
  unlinkWorkBoardTask,
  unlinkWorkFlow,
  WorksStoreError,
  type PersistedWork,
  type WorkOutcomeKind
} from "@muse/stores";
import type { Command } from "commander";

import { closestCommandName } from "./closest-command.js";
import { isApiUnreachable, withApiLocalFallback } from "./program-helpers.js";
import type { ProgramIO } from "./program.js";

const LINK_KINDS = ["flow", "task", "thread"] as const;
type LinkKind = (typeof LINK_KINDS)[number];
const OUTCOME_KINDS: readonly WorkOutcomeKind[] = ["used", "adjusted", "ignored"];

export interface WorksCommandHelpers {
  readonly apiRequest: (
    io: ProgramIO,
    command: Command,
    path: string,
    body?: Record<string, unknown>,
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  ) => Promise<unknown>;
  readonly writeOutput: (io: ProgramIO, value: unknown, textField?: string) => void;
}

interface SharedOptions {
  readonly local?: boolean;
  readonly json?: boolean;
}

function localWorksFile(): string {
  return resolveWorksFile(process.env as Record<string, string | undefined>);
}

function localAttunementFile(): string {
  return resolveAttunementFile(process.env as Record<string, string | undefined>);
}

const worksLocalFallback = <T>(
  io: ProgramIO,
  useLocal: boolean,
  local: () => Promise<T>,
  api: () => Promise<T>
): Promise<T> => withApiLocalFallback(io, useLocal, local, api, "works");

/** Local existence checks — the same referential-integrity contract the API route enforces. */
async function localFlowExists(id: string): Promise<boolean> {
  return Boolean(await new FileScheduledJobStore().findById(id));
}
async function localBoardTaskExists(id: string): Promise<boolean> {
  return (await readBoard(defaultBoardFile())).some((task) => task.id === id);
}
function shortId(id: string): string {
  return id.length > 10 ? id.slice(0, 10) : id;
}

/** `muse work list` — one line per Work, most-recently-touched first. Pure. */
export function formatWorkList(works: readonly PersistedWork[]): string {
  if (works.length === 0) {
    return 'No Work yet. Start one: muse work start "생일 파티 준비" --goal "다음 주 토요일까지 준비 끝내기"\n';
  }
  const lines = works.flatMap((work) => {
    try {
      const projected = projectWorkContinuity(work, work.id);
      if (!projected) return [];
      return [
        `  [${shortId(work.id)}] ${projected.title} (${work.status}) — ${projected.summary}`,
        `    continuity: muse thread link <thread-id> work ${work.id} --role context`
      ];
    } catch {
      return [`  [${shortId(work.id)}] (unsafe Work text hidden) (${work.status})`];
    }
  });
  return `Work (${works.length.toString()}):\n${lines.join("\n")}\n`;
}

/** `muse work show <id>` full detail. Pure. */
export function formatWorkDetail(work: PersistedWork): string {
  const lines = [
    `${work.id}`,
    `  ${work.name} (${work.status})`,
    `  goal: ${work.goal}`,
    `  flows: ${work.flowIds.length > 0 ? work.flowIds.join(", ") : "none"}`,
    `  board tasks: ${work.boardTaskIds.length > 0 ? work.boardTaskIds.join(", ") : "none"}`,
    `  thread: ${work.threadId ?? "none"}`
  ];
  if (work.outcomes.length > 0) {
    lines.push(`  outcomes (${work.outcomes.length.toString()}):`);
    for (const outcome of work.outcomes) {
      lines.push(`    [${outcome.atIso}] ${outcome.kind}${outcome.note ? ` — ${outcome.note}` : ""}`);
    }
  }
  return lines.join("\n");
}

function isLinkKind(value: string): value is LinkKind {
  return (LINK_KINDS as readonly string[]).includes(value);
}

function isOutcomeKind(value: string): value is WorkOutcomeKind {
  return (OUTCOME_KINDS as readonly string[]).includes(value);
}

export function registerWorksCommands(program: Command, io: ProgramIO, helpers: WorksCommandHelpers): void {
  const work = program.command("work").description("A named goal binding your flows, board tasks, and continuity thread");

  work
    .command("list")
    .description("List your Work, most-recently-touched first (--local skips the API)")
    .option("--local", "Read directly from the local works file instead of the API")
    .option("--json", "Print the raw API response instead of the formatted list")
    .action(async (options: SharedOptions, command) => {
      const readLocal = async (): Promise<{ continuityReferences: readonly Record<string, unknown>[]; works: readonly Record<string, unknown>[] }> => {
        const entries = await listWorks(localWorksFile());
        return {
          continuityReferences: entries.flatMap((entry) => {
            try {
              projectWorkContinuity(entry, entry.id);
              return [{ artifactId: entry.id, artifactType: "work", providerId: "local", role: "context" }];
            } catch {
              return [];
            }
          }),
          works: entries.map(serializeWork)
        };
      };
      const payload = await worksLocalFallback(
        io,
        Boolean(options.local),
        readLocal,
        async () => (await helpers.apiRequest(io, command, "/api/works")) as { works: readonly Record<string, unknown>[] }
      );
      if (options.json) {
        helpers.writeOutput(io, payload);
        return;
      }
      io.stdout(formatWorkList(payload.works as unknown as PersistedWork[]));
    });

  work
    .command("show <id>")
    .description("Show a Work's full detail — goal, linked flows/tasks/thread, outcome history (--local skips the API)")
    .option("--local", "Read directly from the local works file instead of the API")
    .option("--json", "Print the raw API response instead of the formatted detail")
    .action(async (id: string, options: SharedOptions, command) => {
      try {
        const found = await worksLocalFallback(
          io,
          Boolean(options.local),
          async () => {
            const w = await getWork(localWorksFile(), id);
            if (!w) throw new WorksStoreError(`no work with id '${id}'`);
            return serializeWork(w);
          },
          async () => (await helpers.apiRequest(io, command, `/api/works/${encodeURIComponent(id)}`)) as Record<string, unknown>
        );
        if (options.json) {
          helpers.writeOutput(io, found);
          return;
        }
        io.stdout(`${formatWorkDetail(found as unknown as PersistedWork)}\n`);
      } catch (cause) {
        reportWorksError(io, cause, `muse work show: ${id}`);
      }
    });

  work
    .command("start <name...>")
    .description('Start a new Work — a one-line goal, nothing linked yet (--local skips the API). e.g. muse work start "생일 파티 준비" --goal "다음 주 토요일까지 준비 끝내기"')
    .requiredOption("--goal <text>", "The one-line goal this Work is for")
    .option("--local", "Write directly to the local works file instead of the API")
    .option("--json", "Print the raw response instead of a short confirmation")
    .action(async (nameParts: readonly string[], options: { readonly goal: string } & SharedOptions, command) => {
      const name = nameParts.join(" ").trim();
      if (name.length === 0) {
        io.stderr("muse work start: a name is required\n");
        process.exitCode = 1;
        return;
      }
      const goal = options.goal.trim();
      if (goal.length === 0) {
        io.stderr("muse work start: --goal must be a non-empty string\n");
        process.exitCode = 1;
        return;
      }
      try {
        const created = await worksLocalFallback(
          io,
          Boolean(options.local),
          async () => serializeWork(await createWork(localWorksFile(), { goal, name })),
          async () => (await helpers.apiRequest(io, command, "/api/works", { goal, name }, "POST")) as Record<string, unknown>
        );
        if (options.json) {
          helpers.writeOutput(io, created);
          return;
        }
        io.stdout(`Started [${shortId(String(created.id))}] ${String(created.name)} — ${String(created.goal)}\n`);
      } catch (cause) {
        reportWorksError(io, cause, "muse work start");
      }
    });

  work
    .command("link <work-id> <kind> <target-id>")
    .description(`Link a flow/board task/continuity thread to a Work (kind: ${LINK_KINDS.join(" | ")}) — refuses a nonexistent target id (--local skips the API)`)
    .option("--local", "Write directly to the local stores instead of the API")
    .option("--unlink", "Remove the link instead of adding it")
    .option("--json", "Print the raw response instead of a short confirmation")
    .action(async (workId: string, kind: string, targetId: string, options: { readonly unlink?: boolean } & SharedOptions, command) => {
      if (!isLinkKind(kind)) {
        const suggestion = closestCommandName(kind, LINK_KINDS);
        io.stderr(`muse work link: kind must be one of ${LINK_KINDS.join(", ")} (got '${kind}')${suggestion ? ` — did you mean '${suggestion}'?` : ""}\n`);
        process.exitCode = 1;
        return;
      }
      try {
        const rawResult = await worksLocalFallback<unknown>(
          io,
          Boolean(options.local),
          async () => serializeWork(await localLinkOrUnlink(kind, workId, targetId, Boolean(options.unlink))),
          async () => helpers.apiRequest(
            io,
            command,
            `/api/works/${encodeURIComponent(workId)}/link`,
            { id: targetId, kind },
            options.unlink ? "DELETE" : "POST"
          )
        );
        const responseObject = rawResult as { work?: Record<string, unknown> } & Record<string, unknown>;
        const work: Record<string, unknown> = responseObject.work ?? responseObject;
        if (options.json) {
          helpers.writeOutput(io, rawResult);
          return;
        }
        io.stdout(`${options.unlink ? "Unlinked" : "Linked"} ${kind} '${targetId}' ${options.unlink ? "from" : "to"} [${shortId(String(work.id))}] ${String(work.name)}\n`);
      } catch (cause) {
        reportWorksError(io, cause, `muse work link ${workId} ${kind} ${targetId}`);
      }
    });

  work
    .command("outcome <work-id> <kind> [note...]")
    .description(`Record an outcome for a Work (kind: ${OUTCOME_KINDS.join(" | ")}) — "done" is judged from these, not from a self-report (--local skips the API)`)
    .option("--local", "Write directly to the local works file instead of the API")
    .option("--json", "Print the raw response instead of a short confirmation")
    .action(async (workId: string, kind: string, noteParts: readonly string[], options: SharedOptions, command) => {
      if (!isOutcomeKind(kind)) {
        const suggestion = closestCommandName(kind, OUTCOME_KINDS);
        io.stderr(`muse work outcome: kind must be one of ${OUTCOME_KINDS.join(", ")} (got '${kind}')${suggestion ? ` — did you mean '${suggestion}'?` : ""}\n`);
        process.exitCode = 1;
        return;
      }
      const note = noteParts.join(" ").trim();
      try {
        const updated = await worksLocalFallback(
          io,
          Boolean(options.local),
          async () => serializeWork(await addWorkOutcome(localWorksFile(), workId, { kind, ...(note ? { note } : {}) })),
          async () => (await helpers.apiRequest(
            io,
            command,
            `/api/works/${encodeURIComponent(workId)}/outcome`,
            { kind, ...(note ? { note } : {}) },
            "POST"
          )) as Record<string, unknown>
        );
        if (options.json) {
          helpers.writeOutput(io, updated);
          return;
        }
        io.stdout(`Recorded outcome '${kind}' for [${shortId(String(updated.id))}] ${String(updated.name)}\n`);
      } catch (cause) {
        reportWorksError(io, cause, `muse work outcome ${workId} ${kind}`);
      }
    });

  work
    .command("done <work-id>")
    .description("Mark a Work done (--local skips the API)")
    .option("--local", "Update the local works file instead of calling the API")
    .option("--json", "Print the raw response instead of a short confirmation")
    .action(async (workId: string, options: SharedOptions, command) => {
      try {
        const updated = await worksLocalFallback(
          io,
          Boolean(options.local),
          async () => serializeWork(await markWorkDone(localWorksFile(), workId)),
          async () => (await helpers.apiRequest(io, command, `/api/works/${encodeURIComponent(workId)}`, { status: "done" }, "PATCH")) as Record<string, unknown>
        );
        if (options.json) {
          helpers.writeOutput(io, updated);
          return;
        }
        io.stdout(`Done: [${shortId(String(updated.id))}] ${String(updated.name)}\n`);
      } catch (cause) {
        reportWorksError(io, cause, `muse work done ${workId}`);
      }
    });

  work
    .command("delete <work-id>")
    .description("Remove a Work — severs its flow/task/thread links only, never touches those stores (--local skips the API)")
    .option("--local", "Delete from the local works file instead of calling the API")
    .action(async (workId: string, options: { readonly local?: boolean }, command) => {
      try {
        await worksLocalFallback(
          io,
          Boolean(options.local),
          async () => {
            const removed = await deleteWorkContinuitySafe({ attunementFile: localAttunementFile(), worksFile: localWorksFile() }, workId);
            if (!removed) throw new WorksStoreError(`no work with id '${workId}'`);
          },
          async () => {
            await helpers.apiRequest(io, command, `/api/works/${encodeURIComponent(workId)}`, undefined, "DELETE");
          }
        );
        io.stdout(`Deleted work ${workId}\n`);
      } catch (cause) {
        if (isApiUnreachable(cause)) throw cause;
        reportWorksError(io, cause, `muse work delete ${workId}`);
      }
    });
}

async function localLinkOrUnlink(kind: LinkKind, workId: string, targetId: string, unlink: boolean): Promise<PersistedWork> {
  if (kind === "flow") {
    return unlink ? unlinkWorkFlow(localWorksFile(), workId, targetId) : linkWorkFlow(localWorksFile(), workId, targetId, localFlowExists);
  }
  if (kind === "task") {
    return unlink ? unlinkWorkBoardTask(localWorksFile(), workId, targetId) : linkWorkBoardTask(localWorksFile(), workId, targetId, localBoardTaskExists);
  }
  return setWorkContinuityThread(
    { attunementFile: localAttunementFile(), worksFile: localWorksFile() },
    unlink ? { workId } : { threadId: targetId, workId }
  );
}

/** 원인+원문+다음 행동: surface the store's exact message, never a bare "failed". */
function reportWorksError(io: ProgramIO, cause: unknown, context: string): void {
  const message = cause instanceof Error ? cause.message : String(cause);
  io.stderr(`${context}: ${message}\n`);
  process.exitCode = 1;
}
