import { promises as fs } from "node:fs";

import {
  decryptMemoryEnvelopeBytes,
  type EncryptedMemoryEnvelope
} from "@muse/memory";
import { isRecord, parseStrictJson } from "@muse/shared";

import type { PersistedWork, WorkOutcome, WorkOutcomeKind, WorkStatus } from "./works-store.js";

export const EXACT_WORK_PHYSICAL_MAX_BYTES = 24 * 1024 * 1024;
export const EXACT_WORK_CONTENT_MAX_BYTES = 16 * 1024 * 1024;
const MAX_WORKS = 2_000;
const MAX_LINKS = 500;
const CANONICAL_WORK_ID = /^work_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export class WorkExactReadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkExactReadError";
  }
}

export interface WorkStoreSnapshot {
  readonly encrypted: boolean;
  readonly schema: "legacy" | 1;
  readonly works: readonly PersistedWork[];
}

export function isCanonicalWorkId(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_WORK_ID.test(value);
}

async function closeWorkStore(handle: Awaited<ReturnType<typeof fs.open>>): Promise<void> {
  try {
    await handle.close();
  } catch (cause) {
    throw new WorkExactReadError("Work store could not be closed", { cause });
  }
}

function exactKeys(value: Readonly<Record<string, unknown>>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}

function canonicalIso(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_ISO.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function boundedStrings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= MAX_LINKS
    && value.every((entry) => typeof entry === "string" && entry.length > 0);
}

function parseOutcome(value: unknown): WorkOutcome {
  if (!isRecord(value) || !exactKeys(value, ["atIso", "kind"], ["note"])
    || !canonicalIso(value.atIso)
    || !["used", "adjusted", "ignored"].includes(value.kind as WorkOutcomeKind)
    || (value.note !== undefined && typeof value.note !== "string")) {
    throw new WorkExactReadError("Work store contains an invalid outcome");
  }
  return {
    atIso: value.atIso,
    kind: value.kind as WorkOutcomeKind,
    ...(value.note !== undefined ? { note: value.note } : {})
  };
}

function parseWork(value: unknown): PersistedWork {
  if (!isRecord(value)
    || !exactKeys(value, ["boardTaskIds", "createdAtIso", "flowIds", "goal", "id", "name", "outcomes", "status", "updatedAtIso"], ["threadId"])
    || !isCanonicalWorkId(value.id)
    || typeof value.name !== "string" || value.name.length === 0
    || typeof value.goal !== "string" || value.goal.length === 0
    || !boundedStrings(value.flowIds) || !boundedStrings(value.boardTaskIds)
    || !Array.isArray(value.outcomes) || value.outcomes.length > MAX_LINKS
    || !["active", "paused", "done"].includes(value.status as WorkStatus)
    || !canonicalIso(value.createdAtIso) || !canonicalIso(value.updatedAtIso)
    || (value.threadId !== undefined && (typeof value.threadId !== "string" || value.threadId.length === 0))) {
    throw new WorkExactReadError("Work store contains an invalid record");
  }
  return {
    boardTaskIds: value.boardTaskIds,
    createdAtIso: value.createdAtIso,
    flowIds: value.flowIds,
    goal: value.goal,
    id: value.id,
    name: value.name,
    outcomes: value.outcomes.map(parseOutcome),
    status: value.status as WorkStatus,
    ...(value.threadId !== undefined ? { threadId: value.threadId } : {}),
    updatedAtIso: value.updatedAtIso
  };
}

function canonicalBase64(value: unknown, name: string, expectedBytes?: number): Buffer {
  if (typeof value !== "string" || !BASE64.test(value)) throw new WorkExactReadError(`encrypted Work ${name} is not canonical base64`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || (expectedBytes !== undefined && bytes.byteLength !== expectedBytes)) {
    throw new WorkExactReadError(`encrypted Work ${name} has an invalid length or encoding`);
  }
  return bytes;
}

function parseEnvelope(text: string): EncryptedMemoryEnvelope | undefined {
  const parsed = parseStrictJson(text, { maxArrayItems: 2_000, maxDepth: 8, maxNodes: 1_000_000, maxObjectMembers: 2_002 });
  if (!isRecord(parsed) || parsed.algorithm !== "aes-256-gcm" || parsed.version !== 1) return undefined;
  if (!exactKeys(parsed, ["algorithm", "data", "iv", "salt", "tag", "version"])) {
    throw new WorkExactReadError("encrypted Work envelope has unknown or missing keys");
  }
  const data = canonicalBase64(parsed.data, "data");
  if (data.byteLength > EXACT_WORK_CONTENT_MAX_BYTES) throw new WorkExactReadError("encrypted Work ciphertext exceeds the size limit");
  canonicalBase64(parsed.iv, "iv", 12);
  canonicalBase64(parsed.salt, "salt", 16);
  canonicalBase64(parsed.tag, "tag", 16);
  return parsed as unknown as EncryptedMemoryEnvelope;
}

function decodeUtf8(bytes: Uint8Array, label: string, maxBytes = EXACT_WORK_CONTENT_MAX_BYTES): string {
  if (bytes.byteLength > maxBytes) throw new WorkExactReadError(`${label} exceeds the size limit`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new WorkExactReadError(`${label} is not valid UTF-8`, { cause });
  }
}

function parseState(text: string): Pick<WorkStoreSnapshot, "schema" | "works"> {
  const parsed = parseStrictJson(text, { maxArrayItems: 2_000, maxDepth: 8, maxNodes: 1_000_000, maxObjectMembers: 2_002 });
  if (!isRecord(parsed)) throw new WorkExactReadError("Work store has an unsupported schema");
  const legacy = exactKeys(parsed, ["works"]);
  const v1 = exactKeys(parsed, ["version", "works"]) && parsed.version === 1;
  if ((!legacy && !v1) || !Array.isArray(parsed.works) || parsed.works.length > MAX_WORKS) {
    throw new WorkExactReadError("Work store has an unsupported schema or exceeds the catalog limit");
  }
  const works = parsed.works.map(parseWork);
  if (new Set(works.map((work) => work.id)).size !== works.length) throw new WorkExactReadError("Work store contains duplicate ids");
  return { schema: legacy ? "legacy" : 1, works };
}

/** Validate an in-memory catalog against the exact v1 write contract. */
export function assertValidWorkStoreState(works: readonly PersistedWork[]): void {
  parseState(JSON.stringify({ version: 1, works }));
}

export async function readWorkStoreSnapshot(file: string, env: NodeJS.ProcessEnv = process.env): Promise<WorkStoreSnapshot> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(file, "r");
  } catch (cause) {
    if (isRecord(cause) && cause.code === "ENOENT") return { encrypted: false, schema: 1, works: [] };
    throw new WorkExactReadError("Work store could not be opened", { cause });
  }
  try {
    const before = await handle.stat();
    if (before.size > EXACT_WORK_PHYSICAL_MAX_BYTES) throw new WorkExactReadError("Work store exceeds the physical size limit");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.byteLength > EXACT_WORK_PHYSICAL_MAX_BYTES || after.size > EXACT_WORK_PHYSICAL_MAX_BYTES) {
      throw new WorkExactReadError("Work store exceeds the physical size limit");
    }
    const outerText = decodeUtf8(bytes, "Work store", EXACT_WORK_PHYSICAL_MAX_BYTES);
    let envelope: EncryptedMemoryEnvelope | undefined;
    try {
      envelope = parseEnvelope(outerText);
    } catch (cause) {
      if (cause instanceof WorkExactReadError) throw cause;
      throw new WorkExactReadError("Work store contains invalid JSON", { cause });
    }
    if (!envelope) {
      if (bytes.byteLength > EXACT_WORK_CONTENT_MAX_BYTES) throw new WorkExactReadError("Work store plaintext exceeds the size limit");
      return { encrypted: false, ...parseState(outerText) };
    }
    let plaintext: Buffer;
    try {
      plaintext = decryptMemoryEnvelopeBytes(envelope, env);
    } catch (cause) {
      throw new WorkExactReadError("Work store could not be decrypted", { cause });
    }
    return { encrypted: true, ...parseState(decodeUtf8(plaintext, "decrypted Work store")) };
  } catch (cause) {
    if (cause instanceof WorkExactReadError) throw cause;
    throw new WorkExactReadError("Work store is invalid", { cause });
  } finally {
    await closeWorkStore(handle);
  }
}

export async function readExactWorkCatalog(file: string, env: NodeJS.ProcessEnv = process.env): Promise<readonly PersistedWork[]> {
  return (await readWorkStoreSnapshot(file, env)).works;
}

export async function readExactWork(file: string, artifactId: string, env: NodeJS.ProcessEnv = process.env): Promise<PersistedWork | undefined> {
  if (!isCanonicalWorkId(artifactId)) return undefined;
  return (await readWorkStoreSnapshot(file, env)).works.find((work) => work.id === artifactId);
}
