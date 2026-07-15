/**
 * File-backed JWT secret rotation state.
 *
 * Shape of `~/.muse/auth-secrets.json`:
 *
 *   {
 *     "current":  "<hex32>",                    // active signing key
 *     "rotatedAt": "<iso>",                     // when `current` was promoted
 *     "previous": [
 *       { "secret": "<hex32>", "rotatedAt": "<iso>", "validUntil": "<iso>" },
 *       ...
 *     ]
 *   }
 *
 * The runtime (autoconfigure) reads this file at boot to populate
 * `JwtTokenProvider`'s `jwtSecret` + `previousJwtSecrets`, dropping
 * any `previous` entry whose `validUntil` is in the past. New
 * tokens are always signed with `current`; outstanding tokens
 * signed with a still-grace-window secret keep verifying.
 *
 * The CLI never echoes secret bytes — the only callers that touch
 * them are the writer (creates) and the reader (loads). Test
 * fixtures generate deterministic bytes through the `nowIso` +
 * `secretFactory` injection points so the unit suite never depends
 * on real entropy.
 */

import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { isRecord } from "@muse/shared";

import { withBestEffort } from "./async-promises.js";

interface PreviousSecretEntry {
  readonly secret: string;
  readonly rotatedAt: string;
  readonly validUntil: string;
}

export interface JwtRotationState {
  readonly current: string;
  readonly rotatedAt: string;
  readonly previous: readonly PreviousSecretEntry[];
}

export function defaultAuthSecretsFile(): string {
  const fromEnv = process.env.MUSE_AUTH_SECRETS_FILE?.trim();
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".muse", "auth-secrets.json");
}

/**
 * Read + validate the rotation state. Returns `undefined` when
 * the file is missing or malformed — callers fall back to env.
 * Tolerant: a broken file shouldn't lock an operator out, the
 * env-only path stays available.
 */
export async function readJwtRotationState(file: string): Promise<JwtRotationState | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const candidate = parsed;
  if (typeof candidate.current !== "string" || candidate.current.length < 32) return undefined;
  if (typeof candidate.rotatedAt !== "string") return undefined;
  const previousArr = Array.isArray(candidate.previous) ? candidate.previous : [];
  const previous: PreviousSecretEntry[] = [];
  for (const entry of previousArr) {
    if (!isRecord(entry)) continue;
    const e = entry;
    if (typeof e.secret !== "string" || e.secret.length < 32) continue;
    if (typeof e.rotatedAt !== "string" || typeof e.validUntil !== "string") continue;
    previous.push({ secret: e.secret, rotatedAt: e.rotatedAt, validUntil: e.validUntil });
  }
  return { current: candidate.current, rotatedAt: candidate.rotatedAt, previous };
}

/**
 * Drop `previous` entries whose `validUntil` has passed. Pure —
 * applied by the autoconfigure boot path so the `JwtTokenProvider`
 * never sees an expired grace-window secret. Exported for direct
 * unit-test coverage.
 */
export function pruneExpiredPreviousSecrets(state: JwtRotationState, now: Date): JwtRotationState {
  const stillValid = state.previous.filter((entry) => {
    const expires = new Date(entry.validUntil).getTime();
    return Number.isFinite(expires) && expires > now.getTime();
  });
  if (stillValid.length === state.previous.length) return state;
  return { ...state, previous: stillValid };
}

/**
 * Apply a rotation step: promote a fresh secret to `current` and
 * push the previous `current` onto `previous` with a `validUntil`
 * = now + graceMs. Returns the new state. Pure — the CLI calls
 * this then writes the result atomically; tests pin every
 * timestamp + secret via the injection knobs.
 */
export function rotateJwtState(args: {
  readonly state: JwtRotationState | undefined;
  readonly fallbackCurrent?: string;
  readonly now: Date;
  readonly graceMs: number;
  readonly secretFactory?: () => string;
}): JwtRotationState {
  const generate = args.secretFactory ?? (() => randomBytes(32).toString("hex"));
  const nowIso = args.now.toISOString();
  const validUntil = new Date(args.now.getTime() + args.graceMs).toISOString();
  const existingCurrent = args.state?.current ?? args.fallbackCurrent;
  if (!existingCurrent) {
    // First-time rotation with no prior state — promote a brand
    // new secret to current, no previous (nothing to grace).
    return { current: generate(), rotatedAt: nowIso, previous: [] };
  }
  const prunedPrev = args.state ? pruneExpiredPreviousSecrets(args.state, args.now).previous : [];
  const newPrevious: PreviousSecretEntry = {
    secret: existingCurrent,
    rotatedAt: args.state?.rotatedAt ?? nowIso,
    validUntil
  };
  return {
    current: generate(),
    rotatedAt: nowIso,
    previous: [newPrevious, ...prunedPrev]
  };
}

/**
 * Atomic write — tmp + rename + 0o600 mode chmod. Same pattern as
 * the other personal-store writers.
 */
export async function writeJwtRotationState(file: string, state: JwtRotationState): Promise<void> {
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  const tmp = `${file}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
  await withBestEffort(fs.chmod(file, 0o600), undefined);
}
