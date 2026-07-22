import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, sep } from "node:path";

import {
  CANONICAL_RUN_OUTCOMES,
  decodeLocalRunReference,
  isCanonicalWorkspaceRealpath,
  isRecord,
  parseStrictJson,
  type CanonicalRunOutcome
} from "@muse/shared";

const MAX_FILE_BYTES = 1_048_576;
const MAX_LINES = 128;
const MAX_LINE_BYTES = 262_144;
const MAX_QUERY_BYTES = 240;
const MAX_ANSWER_BYTES = 600;
const MAX_TOOL_NAMES = 32;
const MAX_TOOL_NAME_BYTES = 96;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;
const EVENT_KEYS = new Set(["apiUrl", "grounded", "message", "model", "recordedAt", "response", "runId", "source", "success", "type"]);

export interface LocalRunEvidence {
  readonly answerSummary: string;
  readonly outcome: CanonicalRunOutcome;
  readonly query: string;
  readonly recordedAt: string;
  readonly runId: string;
  readonly success: boolean | null;
  readonly toolNames: readonly string[];
  readonly workspaceRealpath: string;
}

export type LocalRunEvidenceReadResult =
  | { readonly kind: "available"; readonly evidence: LocalRunEvidence }
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "unreadable"; readonly reason: string };

function ioCode(cause: unknown): string | undefined {
  return cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value;
  let output = "";
  for (const character of value) {
    if (utf8Bytes(output + character) > maxBytes - 3) break;
    output += character;
  }
  return `${output}…`;
}

function boundedText(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string" || CONTROL_PATTERN.test(value)) return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > 0 ? truncateUtf8(normalized, maxBytes) : undefined;
}

function canonicalRecordedAt(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) && instant.toISOString() === value ? value : undefined;
}

function toolNames(value: unknown): readonly string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_TOOL_NAMES) return undefined;
  const seen = new Set<string>();
  const names: string[] = [];
  for (const name of value) {
    if (typeof name !== "string" || utf8Bytes(name) > MAX_TOOL_NAME_BYTES || !TOOL_NAME_PATTERN.test(name) || seen.has(name)) return undefined;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function projectEvent(value: unknown, runId: string, workspaceRealpath: string): LocalRunEvidence | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => !EVENT_KEYS.has(key))) return undefined;
  if (value.type !== "chat.completed" || value.runId !== runId) return undefined;
  if (typeof value.source !== "string" || !(typeof value.apiUrl === "string" || value.apiUrl === null)) return undefined;
  if (!(typeof value.model === "string" || value.model === null)) return undefined;
  const query = boundedText(value.message, MAX_QUERY_BYTES);
  const recordedAt = canonicalRecordedAt(value.recordedAt);
  const outcome = value.grounded === null
    ? null
    : typeof value.grounded === "string" && (CANONICAL_RUN_OUTCOMES as readonly string[]).includes(value.grounded)
      ? value.grounded as Exclude<CanonicalRunOutcome, null>
      : undefined;
  const success = value.success === null || typeof value.success === "boolean" ? value.success : undefined;
  if (!query || !recordedAt || outcome === undefined || success === undefined || !isRecord(value.response)) return undefined;
  const answerSummary = boundedText(value.response.response, MAX_ANSWER_BYTES);
  const names = toolNames(value.response.toolsUsed);
  if (answerSummary === undefined || names === undefined) return undefined;
  return { answerSummary, outcome, query, recordedAt, runId, success, toolNames: names, workspaceRealpath };
}

function sameFile(left: { dev: number; ino: number; size: number; mtimeMs: number }, right: { dev: number; ino: number; size: number; mtimeMs: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

export async function readLocalRunEvidenceStrict(input: {
  readonly allowedWorkspaceRealpath: string;
  readonly reference: string;
}): Promise<LocalRunEvidenceReadResult> {
  const reference = decodeLocalRunReference(input.reference);
  if (!reference || !isCanonicalWorkspaceRealpath(input.allowedWorkspaceRealpath) || reference.workspaceRealpath !== input.allowedWorkspaceRealpath) {
    return { kind: "invalid", reason: "run reference is not canonical for the configured workspace" };
  }

  let workspaceActual: string;
  try {
    workspaceActual = await realpath(reference.workspaceRealpath);
  } catch (cause) {
    return ioCode(cause) === "ENOENT" ? { kind: "absent" } : { kind: "unreadable", reason: "workspace cannot be resolved" };
  }
  if (workspaceActual !== reference.workspaceRealpath) return { kind: "invalid", reason: "workspace authority is not its canonical realpath" };

  const runsDir = join(reference.workspaceRealpath, ".muse", "runs");
  let runsStat;
  try {
    runsStat = await lstat(runsDir);
    if (!runsStat.isDirectory() || runsStat.isSymbolicLink() || await realpath(runsDir) !== runsDir) {
      return { kind: "invalid", reason: "run evidence root is not a canonical real directory" };
    }
  } catch (cause) {
    return ioCode(cause) === "ENOENT" ? { kind: "absent" } : { kind: "unreadable", reason: "run evidence root cannot be read" };
  }

  const target = join(runsDir, `${reference.runId}.jsonl`);
  if (!target.startsWith(`${runsDir}${sep}`)) return { kind: "invalid", reason: "run evidence path escapes its root" };
  let pathStat;
  try {
    pathStat = await lstat(target);
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || await realpath(target) !== target) {
      return { kind: "invalid", reason: "run evidence target is not a canonical regular file" };
    }
  } catch (cause) {
    return ioCode(cause) === "ENOENT" ? { kind: "absent" } : { kind: "unreadable", reason: "run evidence target cannot be read" };
  }

  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || !sameFile(pathStat, before) || before.size > MAX_FILE_BYTES) {
      return { kind: "invalid", reason: "run evidence changed or exceeds the file limit" };
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.byteLength > MAX_FILE_BYTES || !sameFile(before, after)) {
      return { kind: "invalid", reason: "run evidence changed while being read" };
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { kind: "invalid", reason: "run evidence is not valid UTF-8" };
    }
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0 || lines.length > MAX_LINES) return { kind: "invalid", reason: "run evidence has an invalid line count" };
    let projected: LocalRunEvidence | undefined;
    for (const line of lines) {
      if (utf8Bytes(line) > MAX_LINE_BYTES) return { kind: "invalid", reason: "run evidence line exceeds the byte limit" };
      let event: unknown;
      try {
        event = parseStrictJson(line, { maxArrayItems: 4_096, maxDepth: 32, maxNodes: 16_384, maxObjectMembers: 4_096 });
      } catch {
        return { kind: "invalid", reason: "run evidence contains malformed or duplicate-key JSON" };
      }
      projected = projectEvent(event, reference.runId, reference.workspaceRealpath);
      if (!projected) return { kind: "invalid", reason: "run evidence event violates the strict schema" };
    }
    return { kind: "available", evidence: projected! };
  } catch (cause) {
    return ioCode(cause) === "ENOENT" ? { kind: "absent" } : { kind: "unreadable", reason: "run evidence file cannot be opened or read" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
