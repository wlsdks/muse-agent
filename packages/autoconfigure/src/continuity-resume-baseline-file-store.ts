import { constants, promises as fs } from "node:fs";
import { isAbsolute, normalize } from "node:path";

import type {
  ContinuityScopedSourceObservationScope
} from "@muse/attunement/continuity-source-observations";
import {
  verifyContinuityResumeRuntimeBaseline,
  type ContinuityResumeRuntimeBaselineStore,
  type ContinuityResumeRuntimeBaselineV1
} from "@muse/attunegraph/continuity-resume-runtime";
import { parseStrictJson } from "@muse/shared";
import {
  atomicWriteFile,
  withFileLock,
  withFileMutationQueue
} from "@muse/stores";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_BASELINES = 16;
const ENVELOPE_KEYS = ["schemaVersion", "baselines"] as const;

type Envelope = Readonly<{
  readonly schemaVersion: 1;
  readonly baselines: readonly ContinuityResumeRuntimeBaselineV1[];
}>;

export class ContinuityResumeBaselineFileStoreUnavailableError extends Error {
  constructor() {
    super("Continuity resume baseline file store is unavailable.");
    this.name = "ContinuityResumeBaselineFileStoreUnavailableError";
  }
}

function unavailable(): ContinuityResumeBaselineFileStoreUnavailableError {
  return new ContinuityResumeBaselineFileStoreUnavailableError();
}

function sameIdentity(
  left: Readonly<{ dev: number | bigint; ino: number | bigint }>,
  right: Readonly<{ dev: number | bigint; ino: number | bigint }>
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isPrivateRegularFile(stat: Awaited<ReturnType<typeof fs.lstat>>): boolean {
  return stat.isFile()
    && !stat.isSymbolicLink()
    && Number(stat.nlink) === 1
    && (
      process.platform === "win32"
      || (Number(stat.mode) & 0o777) === 0o600
    )
    && (
      typeof process.getuid !== "function"
      || Number(stat.uid) === process.getuid()
    );
}

function exactRecord(
  value: unknown,
  keys: readonly string[]
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}

function scopeKey(scope: ContinuityScopedSourceObservationScope): string {
  return `${scope.sourceId}\0${scope.threadId}`;
}

function hasScope(
  baseline: ContinuityResumeRuntimeBaselineV1,
  scope: ContinuityScopedSourceObservationScope
): boolean {
  return baseline.scope.sourceId === scope.sourceId
    && baseline.scope.threadId === scope.threadId;
}

function parseEnvelope(value: unknown): Envelope {
  if (!exactRecord(value, ENVELOPE_KEYS) || value.schemaVersion !== 1) {
    throw unavailable();
  }
  if (!Array.isArray(value.baselines) || value.baselines.length > MAX_BASELINES) {
    throw unavailable();
  }
  const baselines: ContinuityResumeRuntimeBaselineV1[] = [];
  const scopes = new Set<string>();
  for (const item of value.baselines) {
    let baseline: ContinuityResumeRuntimeBaselineV1;
    try {
      baseline = verifyContinuityResumeRuntimeBaseline(item);
    } catch {
      throw unavailable();
    }
    const key = scopeKey(baseline.scope);
    if (scopes.has(key)) throw unavailable();
    scopes.add(key);
    baselines.push(baseline);
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    baselines: Object.freeze(baselines)
  });
}

async function readBoundedPrivateFile(
  file: string
): Promise<Uint8Array | undefined> {
  let pathStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    pathStat = await fs.lstat(file);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw unavailable();
  }
  if (!isPrivateRegularFile(pathStat) || pathStat.size > MAX_FILE_BYTES) {
    throw unavailable();
  }

  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(
      file,
      constants.O_RDONLY
        | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)
    );
    const openedStat = await handle.stat();
    if (
      !isPrivateRegularFile(openedStat)
      || !sameIdentity(pathStat, openedStat)
      || openedStat.size > MAX_FILE_BYTES
    ) {
      throw unavailable();
    }

    const buffer = Buffer.alloc(
      Math.min(MAX_FILE_BYTES + 1, openedStat.size + 1)
    );
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.byteLength - offset,
        null
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const [afterStat, afterPathStat] = await Promise.all([
      handle.stat(),
      fs.lstat(file)
    ]);
    if (
      offset > MAX_FILE_BYTES
      || offset !== openedStat.size
      || afterStat.size !== openedStat.size
      || !sameIdentity(openedStat, afterStat)
      || !sameIdentity(openedStat, afterPathStat)
      || !isPrivateRegularFile(afterStat)
      || !isPrivateRegularFile(afterPathStat)
    ) {
      throw unavailable();
    }
    return buffer.subarray(0, offset);
  } catch (cause) {
    if (
      cause instanceof ContinuityResumeBaselineFileStoreUnavailableError
    ) {
      throw cause;
    }
    throw unavailable();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readEnvelope(file: string): Promise<Envelope> {
  const bytes = await readBoundedPrivateFile(file);
  if (bytes === undefined) {
    return Object.freeze({
      schemaVersion: 1 as const,
      baselines: Object.freeze([])
    });
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw unavailable();
  }
  try {
    return parseEnvelope(parseStrictJson(text, {
      maxArrayItems: 4_096,
      maxDepth: 64,
      maxNodes: 1_000_000,
      maxObjectMembers: 1_000_000
    }));
  } catch (cause) {
    if (
      cause instanceof ContinuityResumeBaselineFileStoreUnavailableError
    ) {
      throw cause;
    }
    throw unavailable();
  }
}

function verifyProposed(
  scope: ContinuityScopedSourceObservationScope,
  proposed: ContinuityResumeRuntimeBaselineV1
): ContinuityResumeRuntimeBaselineV1 {
  let verified: ContinuityResumeRuntimeBaselineV1;
  try {
    verified = verifyContinuityResumeRuntimeBaseline(proposed);
  } catch {
    throw unavailable();
  }
  if (!hasScope(verified, scope)) throw unavailable();
  return verified;
}

export class ContinuityResumeBaselineFileStore
  implements ContinuityResumeRuntimeBaselineStore {
  readonly #file: string;

  constructor(file: string) {
    if (
      file.includes("\0")
      || !isAbsolute(file)
      || normalize(file) !== file
    ) {
      throw unavailable();
    }
    this.#file = file;
  }

  load(
    scope: ContinuityScopedSourceObservationScope
  ): Promise<unknown | undefined> {
    return withFileMutationQueue(this.#file, () =>
      withFileLock(this.#file, async () => {
        const envelope = await readEnvelope(this.#file);
        return envelope.baselines.find((baseline) =>
          hasScope(baseline, scope)
        );
      })
    );
  }

  compareAndSet(
    scope: ContinuityScopedSourceObservationScope,
    expectedBoundaryId: string | undefined,
    proposed: ContinuityResumeRuntimeBaselineV1
  ): Promise<"stored" | "unchanged" | "conflict"> {
    return withFileMutationQueue(this.#file, () =>
      withFileLock(this.#file, async () => {
        const envelope = await readEnvelope(this.#file);
        const verified = verifyProposed(scope, proposed);
        const index = envelope.baselines.findIndex((baseline) =>
          hasScope(baseline, scope)
        );
        const current = envelope.baselines[index];
        if (
          current === undefined
            ? expectedBoundaryId !== undefined
            : current.boundary.boundaryId !== expectedBoundaryId
        ) {
          return "conflict";
        }
        if (
          current !== undefined
          && current.boundary.boundaryId === verified.boundary.boundaryId
        ) {
          return "unchanged";
        }

        const retained = index < 0
          ? [...envelope.baselines]
          : envelope.baselines.filter((_baseline, itemIndex) =>
              itemIndex !== index
            );
        retained.push(verified);
        const baselines = retained.length > MAX_BASELINES
          ? retained.slice(retained.length - MAX_BASELINES)
          : retained;
        const serialized = `${JSON.stringify({
          schemaVersion: 1,
          baselines
        })}\n`;
        if (Buffer.byteLength(serialized, "utf8") > MAX_FILE_BYTES) {
          throw unavailable();
        }
        await atomicWriteFile(this.#file, serialized, {
          mode: 0o600,
          strictPrivate: true
        });
        return "stored";
      })
    );
  }
}
