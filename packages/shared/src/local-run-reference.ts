const RUN_REFERENCE_PREFIX = "muse-run-v1:";
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_RUN_ID_BYTES = 256;
const MAX_WORKSPACE_BYTES = 4_096;

export const CANONICAL_RUN_OUTCOMES = [
  "abstain",
  "grounded",
  "misgrounded",
  "contested",
  "ungrounded",
  "error"
] as const;

export type CanonicalRunOutcome = (typeof CANONICAL_RUN_OUTCOMES)[number] | null;

export interface LocalRunReference {
  readonly runId: string;
  readonly workspaceRealpath: string;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isCanonicalAbsolutePath(value: string): boolean {
  let segments: readonly string[];
  if (value.startsWith("/")) {
    if (value === "/" || value.endsWith("/") || value.includes("//")) return false;
    segments = value.slice(1).split("/");
  } else if (/^[A-Za-z]:[\\/]/u.test(value)) {
    const separator = value[2]!;
    if (value.length === 3 || value.endsWith(separator)) return false;
    if (separator === "\\" ? value.includes("/") : value.includes("\\")) return false;
    segments = value.slice(3).split(separator);
  } else if (value.startsWith("\\\\")) {
    if (value.includes("/") || value.endsWith("\\") || value.includes("\\\\", 2)) return false;
    segments = value.slice(2).split("\\");
    if (segments.length < 2) return false;
  } else {
    return false;
  }
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function encodeBase64Url(value: string): string {
  const binary = Array.from(new TextEncoder().encode(value), (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): string {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(`${base64}${"=".repeat((4 - base64.length % 4) % 4)}`);
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

export function isCanonicalLocalRunId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && utf8Bytes(value) <= MAX_RUN_ID_BYTES
    && RUN_ID_PATTERN.test(value)
    && value !== "."
    && value !== "..";
}

export function isCanonicalWorkspaceRealpath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && utf8Bytes(value) <= MAX_WORKSPACE_BYTES
    && !CONTROL_PATTERN.test(value)
    && isCanonicalAbsolutePath(value);
}

export function encodeLocalRunReference(reference: LocalRunReference): string {
  if (!isCanonicalWorkspaceRealpath(reference.workspaceRealpath)) {
    throw new Error("local run reference requires an absolute canonical workspace realpath");
  }
  if (!isCanonicalLocalRunId(reference.runId)) {
    throw new Error("local run reference requires a canonical run id");
  }
  const payload = encodeBase64Url(JSON.stringify([reference.workspaceRealpath, reference.runId]));
  return `${RUN_REFERENCE_PREFIX}${payload}`;
}

export function decodeLocalRunReference(value: string): LocalRunReference | undefined {
  if (!value.startsWith(RUN_REFERENCE_PREFIX)) return undefined;
  try {
    const encoded = value.slice(RUN_REFERENCE_PREFIX.length);
    if (encoded.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(encoded)) return undefined;
    const decoded: unknown = JSON.parse(decodeBase64Url(encoded));
    if (!Array.isArray(decoded) || decoded.length !== 2) return undefined;
    const [workspaceRealpath, runId] = decoded;
    if (!isCanonicalWorkspaceRealpath(workspaceRealpath) || !isCanonicalLocalRunId(runId)) return undefined;
    const reference = { runId, workspaceRealpath };
    return encodeLocalRunReference(reference) === value ? reference : undefined;
  } catch {
    return undefined;
  }
}

export function canonicalRunOutcome(value: unknown): CanonicalRunOutcome | undefined {
  if (value === null) return null;
  if (typeof value === "string" && (CANONICAL_RUN_OUTCOMES as readonly string[]).includes(value)) {
    return value as Exclude<CanonicalRunOutcome, null>;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 1 && "verdict" in record
    ? canonicalRunOutcome(record.verdict)
    : undefined;
}
