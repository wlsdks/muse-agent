import { createHash } from "node:crypto";

import type { Command } from "commander";

import { auditNoteRelationsStore } from "./note-relations-audit.js";
import { loadBoundedNotesIndex, loadIndexedNoteSource } from "./note-relations-context.js";
import {
  NoteRelationsOperationError,
  commitPreparedAdd,
  commitPreparedRemove,
  prepareAddRelation,
  prepareRemoveRelation,
  type RelationSpanRef
} from "./note-relations-operations.js";
import {
  NoteRelationsStoreError,
  readNoteRelationsStore,
  resolveNoteRelationsPathSnapshot
} from "./note-relations-store.js";
import type { ProgramIO } from "./program.js";

export interface NoteRelationsCommandDeps {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly isTTY?: () => boolean;
  readonly confirm?: (message: string) => Promise<boolean>;
  readonly now?: () => Date;
  readonly randomEdgeId?: () => string;
}

type CommandName = "inspect" | "add" | "list" | "show" | "remove" | "audit";

function emitJson(io: ProgramIO, value: unknown): void {
  io.stdout(`${JSON.stringify(value)}\n`);
}

function success(io: ProgramIO, command: CommandName, data: unknown, json: boolean | undefined): void {
  if (json) emitJson(io, { ok: true, command, data });
  else io.stdout(`${command}: ${JSON.stringify(data)}\n`);
}

function failure(io: ProgramIO, command: CommandName, code: string, exitCode: 1 | 2, json: boolean | undefined): void {
  const message = code.replaceAll("_", " ").toLowerCase();
  if (json) emitJson(io, { ok: false, command, error: { code, message } });
  else io.stderr(`${command}: ${message}\n`);
  process.exitCode = exitCode;
}

function classifyFailure(cause: unknown): { code: string; exitCode: 1 | 2 } {
  if (cause instanceof NoteRelationsOperationError) {
    return {
      code: cause.code,
      exitCode: cause.code === "NOT_FOUND" || cause.code === "INVALID_REFERENCE" ? 2 : 1
    };
  }
  if (cause instanceof NoteRelationsStoreError) {
    return { code: cause.code, exitCode: 1 };
  }
  const code = typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : "OPERATION_FAILED";
  return { code, exitCode: 1 };
}

function boundedInt(raw: unknown, _name: string): number {
  if (typeof raw !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(raw)) {
    throw new NoteRelationsOperationError("INVALID_REFERENCE");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new NoteRelationsOperationError("INVALID_REFERENCE");
  return value;
}

function ref(options: Record<string, string>, prefix: "current" | "stale"): RelationSpanRef {
  const source = options[`${prefix}Source`];
  if (typeof source !== "string" || source.length === 0) throw new NoteRelationsOperationError("INVALID_REFERENCE");
  return Object.freeze({
    chunk: boundedInt(options[`${prefix}Chunk`]!, `--${prefix}-chunk`),
    end: boundedInt(options[`${prefix}End`]!, `--${prefix}-end`),
    source,
    start: boundedInt(options[`${prefix}Start`]!, `--${prefix}-start`)
  });
}

async function defaultConfirm(message: string): Promise<boolean> {
  const prompts = await import("@clack/prompts");
  const answer = await prompts.confirm({ message });
  return answer === true;
}

async function authorizeMutation(
  io: ProgramIO,
  command: "add" | "remove",
  digest: string,
  options: { readonly yes?: boolean; readonly json?: boolean },
  deps: NoteRelationsCommandDeps
): Promise<boolean> {
  if (options.yes) return true;
  if (options.json || !(deps.isTTY?.() ?? Boolean(process.stdin.isTTY && process.stdout.isTTY))) {
    failure(io, command, "CONFIRMATION_REQUIRED", 2, options.json);
    return false;
  }
  let accepted: boolean;
  try {
    accepted = await (deps.confirm ?? defaultConfirm)(`${command} note relation ${digest}?`);
  } catch {
    accepted = false;
  }
  if (!accepted) {
    failure(io, command, "CONFIRMATION_CANCELLED", 2, options.json);
    return false;
  }
  return true;
}

export function registerNoteRelationsCommands(
  program: Command,
  io: ProgramIO,
  deps: NoteRelationsCommandDeps = {}
): void {
  const notes = program.commands.find((candidate) => candidate.name() === "notes")
    ?? program.command("notes").description("Markdown notes");
  const relations = notes.command("relations").description("Inspect and author explicit temporal note relations");
  const paths = () => resolveNoteRelationsPathSnapshot(deps.env ?? process.env);

  relations.command("inspect")
    .option("--source <relative>")
    .option("--chunk <n>")
    .option("--start <n>")
    .option("--end <n>")
    .option("--json")
    .action(async (options: { source?: string; chunk?: string; start?: string; end?: string; json?: boolean }) => {
      try {
        const actionPaths = paths();
        if (typeof options.source !== "string" || options.source.length === 0) throw new NoteRelationsOperationError("INVALID_REFERENCE");
        const index = await loadBoundedNotesIndex(actionPaths);
        const source = await loadIndexedNoteSource(index, options.source);
        if (source.status !== "resolved") throw new NoteRelationsOperationError("INVALID_REFERENCE");
        const chunks = source.sourceIndex.chunks.map((chunk) => ({
          chunk: chunk.chunkIndex,
          bytes: Buffer.byteLength(chunk.text),
          text: chunk.text
        }));
        let span: { chunk: number; start: number; end: number; text: string; hash: string } | undefined;
        if (options.chunk !== undefined || options.start !== undefined || options.end !== undefined) {
          if (options.chunk === undefined || options.start === undefined || options.end === undefined) {
            throw new NoteRelationsOperationError("INVALID_REFERENCE");
          }
          const chunkIndex = boundedInt(options.chunk, "--chunk");
          const start = boundedInt(options.start, "--start");
          const end = boundedInt(options.end, "--end");
          const chunk = source.sourceIndex.chunks.find((candidate) => candidate.chunkIndex === chunkIndex);
          if (!chunk) throw new NoteRelationsOperationError("INVALID_REFERENCE");
          const bytes = Buffer.from(chunk.text, "utf8");
          if (start >= end || end > bytes.byteLength || end - start > 4 * 1_024) throw new NoteRelationsOperationError("INVALID_REFERENCE");
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start, end));
          span = { chunk: chunkIndex, end, hash: createHash("sha256").update(bytes.subarray(start, end)).digest("hex"), start, text };
        }
        success(io, "inspect", { source: options.source, chunks, ...(span ? { span } : {}) }, options.json);
      } catch (cause) {
        const classified = classifyFailure(cause);
        failure(io, "inspect", classified.code, classified.exitCode, options.json);
      }
    });

  relations.command("add")
    .option("--current-source <relative>").option("--current-chunk <n>")
    .option("--current-start <n>").option("--current-end <n>")
    .option("--stale-source <relative>").option("--stale-chunk <n>")
    .option("--stale-start <n>").option("--stale-end <n>")
    .option("--yes").option("--json")
    .action(async (options: Record<string, string | boolean | undefined>) => {
      try {
        const actionPaths = paths();
        const stringOptions = options as Record<string, string>;
        const args = { current: ref(stringOptions, "current"), stale: ref(stringOptions, "stale") };
        const prepared = await prepareAddRelation(actionPaths, args, {
          authoredAt: (deps.now?.() ?? new Date()).toISOString(),
          edgeId: deps.randomEdgeId?.()
        });
        if (!options.yes && !options.json) {
          io.stdout([
            `current ${args.current.source}#${args.current.chunk.toString()}[${args.current.start.toString()}:${args.current.end.toString()}] ${JSON.stringify(prepared.evidence.currentSpan)}`,
            `stale ${args.stale.source}#${args.stale.chunk.toString()}[${args.stale.start.toString()}:${args.stale.end.toString()}] ${JSON.stringify(prepared.evidence.staleSpan)}`,
            `confirmation ${prepared.digest}`
          ].join("\n") + "\n");
        }
        if (!await authorizeMutation(io, "add", prepared.digest, options, deps)) return;
        const stored = await commitPreparedAdd(actionPaths, args, prepared);
        success(io, "add", { edgeId: prepared.evidence.relation.edgeId, revision: stored.revision, confirmationDigest: prepared.digest }, Boolean(options.json));
      } catch (cause) {
        const classified = classifyFailure(cause);
        failure(io, "add", classified.code, classified.exitCode, Boolean(options.json));
      }
    });

  relations.command("list").option("--json").action(async (options: { json?: boolean }) => {
    try {
      const actionPaths = paths();
      const audit = await auditNoteRelationsStore(actionPaths);
      const store = await readNoteRelationsStore(actionPaths);
      success(io, "list", { state: audit.state, revision: store.revision, relations: store.relations }, options.json);
    } catch (cause) {
      const classified = classifyFailure(cause); failure(io, "list", classified.code, classified.exitCode, options.json);
    }
  });

  relations.command("show <edgeId>").option("--json").action(async (edgeId: string, options: { json?: boolean }) => {
    try {
      const actionPaths = paths();
      const store = await readNoteRelationsStore(actionPaths);
      const relation = store.relations.find((candidate) => candidate.edgeId === edgeId);
      if (!relation) throw new NoteRelationsOperationError("NOT_FOUND");
      const audit = await auditNoteRelationsStore(actionPaths);
      success(io, "show", { relation, audit: audit.edges.find((edge) => edge.edgeId === edgeId) }, options.json);
    } catch (cause) {
      const classified = classifyFailure(cause); failure(io, "show", classified.code, classified.exitCode, options.json);
    }
  });

  relations.command("audit").option("--json").action(async (options: { json?: boolean }) => {
    try { const actionPaths = paths(); success(io, "audit", await auditNoteRelationsStore(actionPaths), options.json); }
    catch (cause) { const classified = classifyFailure(cause); failure(io, "audit", classified.code, classified.exitCode, options.json); }
  });

  relations.command("remove <edgeId>").option("--yes").option("--json")
    .action(async (edgeId: string, options: { yes?: boolean; json?: boolean }) => {
      try {
        const actionPaths = paths();
        const prepared = await prepareRemoveRelation(actionPaths, edgeId);
        if (!options.yes && !options.json) {
          io.stdout([
            `remove ${prepared.edgeId}`,
            `current ${prepared.relation.current.sourcePath}#${prepared.relation.current.chunkIndex.toString()}[${prepared.relation.current.start.toString()}:${prepared.relation.current.end.toString()}]`,
            `stale ${prepared.relation.stale.sourcePath}#${prepared.relation.stale.chunkIndex.toString()}[${prepared.relation.stale.start.toString()}:${prepared.relation.stale.end.toString()}]`,
            `confirmation ${prepared.digest}`
          ].join("\n") + "\n");
        }
        if (!await authorizeMutation(io, "remove", prepared.digest, options, deps)) return;
        const stored = await commitPreparedRemove(actionPaths, prepared);
        success(io, "remove", { edgeId, revision: stored.revision, confirmationDigest: prepared.digest }, options.json);
      } catch (cause) {
        const classified = classifyFailure(cause); failure(io, "remove", classified.code, classified.exitCode, options.json);
      }
    });
}
