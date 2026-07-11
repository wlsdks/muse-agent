/**
 * Persisted `next_batch` token for Matrix `/sync`.
 *
 * A sync without `since` is an initial sync (full state + recent
 * timeline), so a polling client that doesn't persist the token
 * reprocesses the same events on every restart. This store is the
 * single-string sidecar that lets `MatrixProvider.pollUpdates`
 * advance through the event stream — the Matrix analogue of
 * `telegram-offset-store.ts`.
 *
 * Shape: `{ "version": 1, "since": "<token>" }`. Missing / malformed
 * files yield `undefined` — the next poll is then an initial sync.
 * Atomic tmp+rename write, user-only mode, same pattern as the
 * sibling stores.
 */

import { promises as fs } from "node:fs";
import { dirname } from "node:path";

interface PersistedShape {
  readonly version: 1;
  readonly since: string;
}

export async function readMatrixSince(file: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const candidate = (parsed as { since?: unknown }).since;
  if (typeof candidate !== "string" || candidate.length === 0) {
    return undefined;
  }
  return candidate;
}

export async function writeMatrixSince(file: string, since: string): Promise<void> {
  if (typeof since !== "string" || since.length === 0) {
    throw new TypeError("since must be a non-empty string");
  }
  const payload: PersistedShape = { since, version: 1 };
  const tmp = `${file}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
}
