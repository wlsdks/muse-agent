import { isCanonicalLocalRunId, isCanonicalWorkspaceRealpath } from "./local-run-reference.js";

const CHECKPOINT_REFERENCE_PREFIX = "muse-checkpoint-v1:";

export interface LocalCheckpointReference {
  readonly runId: string;
  readonly step: number;
  readonly workspaceRealpath: string;
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

export function isCanonicalCheckpointStep(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function encodeLocalCheckpointReference(reference: LocalCheckpointReference): string {
  if (!isCanonicalWorkspaceRealpath(reference.workspaceRealpath) || reference.workspaceRealpath === "/") {
    throw new Error("local checkpoint reference requires a non-root canonical workspace realpath");
  }
  if (!isCanonicalLocalRunId(reference.runId)) {
    throw new Error("local checkpoint reference requires a canonical run id");
  }
  if (!isCanonicalCheckpointStep(reference.step)) {
    throw new Error("local checkpoint reference requires a non-negative safe-integer step");
  }
  const payload = encodeBase64Url(JSON.stringify([reference.workspaceRealpath, reference.runId, reference.step]));
  return `${CHECKPOINT_REFERENCE_PREFIX}${payload}`;
}

export function decodeLocalCheckpointReference(value: string): LocalCheckpointReference | undefined {
  if (!value.startsWith(CHECKPOINT_REFERENCE_PREFIX)) return undefined;
  try {
    const encoded = value.slice(CHECKPOINT_REFERENCE_PREFIX.length);
    if (encoded.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(encoded)) return undefined;
    const decoded: unknown = JSON.parse(decodeBase64Url(encoded));
    if (!Array.isArray(decoded) || decoded.length !== 3) return undefined;
    const [workspaceRealpath, runId, step] = decoded;
    if (!isCanonicalWorkspaceRealpath(workspaceRealpath) || workspaceRealpath === "/" || !isCanonicalLocalRunId(runId) || !isCanonicalCheckpointStep(step)) {
      return undefined;
    }
    const reference = { runId, step, workspaceRealpath };
    return encodeLocalCheckpointReference(reference) === value ? reference : undefined;
  } catch {
    return undefined;
  }
}
