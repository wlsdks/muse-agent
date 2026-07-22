import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, sep } from "node:path";

import {
  decodeLocalCheckpointReference,
  isCanonicalWorkspaceRealpath,
  parseStrictJson
} from "@muse/shared";

import { CHECKPOINT_V3_DIRECTORY, checkpointV3FileName, parseCheckpointV3Envelope } from "./checkpoint-v3.js";

const MAX_FILE_BYTES = 4 * 1_048_576;

export interface LocalCheckpointEvidence {
  readonly phase: "start" | "act" | "failed" | "complete";
  readonly query: string;
  readonly recordedAt: string;
  readonly runId: string;
  readonly step: number;
  readonly workspaceRealpath: string;
}

export type LocalCheckpointEvidenceReadResult =
  | { readonly kind: "available"; readonly evidence: LocalCheckpointEvidence }
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "unreadable"; readonly reason: string };

function ioCode(cause: unknown): string | undefined {
  return cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
}

function sameFile(left: { dev: number; ino: number; size: number; mtimeMs: number }, right: { dev: number; ino: number; size: number; mtimeMs: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

async function canonicalDirectory(path: string, label: string): Promise<LocalCheckpointEvidenceReadResult | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) {
      return { kind: "invalid", reason: `${label} is not a canonical real directory` };
    }
    return undefined;
  } catch (cause) {
    return ioCode(cause) === "ENOENT" ? { kind: "absent" } : { kind: "unreadable", reason: `${label} cannot be read` };
  }
}

export async function readLocalCheckpointEvidenceStrict(input: {
  readonly allowedWorkspaceRealpath: string;
  readonly checkpointsDir: string;
  readonly reference: string;
  /** Deterministic race seam for security tests; production callers leave this absent. */
  readonly testHooks?: { readonly afterOpen?: (target: string) => Promise<void> | void };
}): Promise<LocalCheckpointEvidenceReadResult> {
  const reference = decodeLocalCheckpointReference(input.reference);
  if (!reference
    || !isCanonicalWorkspaceRealpath(input.allowedWorkspaceRealpath)
    || input.allowedWorkspaceRealpath === "/"
    || reference.workspaceRealpath !== input.allowedWorkspaceRealpath
    || !isCanonicalWorkspaceRealpath(input.checkpointsDir)
    || input.checkpointsDir === "/") {
    return { kind: "invalid", reason: "checkpoint reference is not canonical for the configured authorities" };
  }

  try {
    if (await realpath(reference.workspaceRealpath) !== reference.workspaceRealpath) {
      return { kind: "invalid", reason: "workspace authority is not its canonical realpath" };
    }
  } catch (cause) {
    return ioCode(cause) === "ENOENT" ? { kind: "absent" } : { kind: "unreadable", reason: "workspace cannot be resolved" };
  }

  const rootFailure = await canonicalDirectory(input.checkpointsDir, "checkpoint evidence root");
  if (rootFailure) return rootFailure;
  const v3Dir = join(input.checkpointsDir, CHECKPOINT_V3_DIRECTORY);
  const v3Failure = await canonicalDirectory(v3Dir, "checkpoint v3 root");
  if (v3Failure) return v3Failure;

  const target = join(v3Dir, checkpointV3FileName(reference.workspaceRealpath, reference.runId));
  if (!target.startsWith(`${v3Dir}${sep}`)) return { kind: "invalid", reason: "checkpoint evidence path escapes its root" };
  let pathStat;
  try {
    pathStat = await lstat(target);
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || await realpath(target) !== target) {
      return { kind: "invalid", reason: "checkpoint evidence target is not a canonical regular file" };
    }
  } catch (cause) {
    return ioCode(cause) === "ENOENT" ? { kind: "absent" } : { kind: "unreadable", reason: "checkpoint evidence target cannot be read" };
  }

  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || !sameFile(pathStat, before) || before.size > MAX_FILE_BYTES) {
      return { kind: "invalid", reason: "checkpoint evidence changed or exceeds the file limit" };
    }
    await input.testHooks?.afterOpen?.(target);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    let finalPathStat;
    try {
      finalPathStat = await lstat(target);
    } catch {
      return { kind: "invalid", reason: "checkpoint evidence changed while being read" };
    }
    if (bytes.byteLength > MAX_FILE_BYTES || !sameFile(before, after) || !sameFile(after, finalPathStat)) {
      return { kind: "invalid", reason: "checkpoint evidence changed while being read" };
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { kind: "invalid", reason: "checkpoint evidence is not valid UTF-8" };
    }
    let parsed: unknown;
    try {
      parsed = parseStrictJson(text, { maxArrayItems: 65_536, maxDepth: 64, maxNodes: 65_536, maxObjectMembers: 65_536 });
    } catch {
      return { kind: "invalid", reason: "checkpoint evidence contains malformed or duplicate-key JSON" };
    }
    const envelope = parseCheckpointV3Envelope(parsed);
    if (!envelope
      || envelope.provenance.runId !== reference.runId
      || envelope.provenance.workspaceRealpath !== reference.workspaceRealpath) {
      return { kind: "invalid", reason: "checkpoint evidence violates the strict v3 schema or provenance" };
    }
    const checkpoint = envelope.checkpoints.find((candidate) => candidate.step === reference.step);
    if (!checkpoint?.continuityEvidence) return { kind: "absent" };
    return {
      kind: "available",
      evidence: {
        phase: checkpoint.continuityEvidence.phase,
        query: checkpoint.continuityEvidence.query,
        recordedAt: checkpoint.createdAt,
        runId: reference.runId,
        step: reference.step,
        workspaceRealpath: reference.workspaceRealpath
      }
    };
  } catch (cause) {
    return ioCode(cause) === "ENOENT" ? { kind: "absent" } : { kind: "unreadable", reason: "checkpoint evidence file cannot be opened or read" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
