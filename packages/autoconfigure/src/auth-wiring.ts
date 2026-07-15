/**
 * Auth-service wiring extracted from the assembly hub: builds the
 * `MuseAuth` service (JWT provider + user store) from the environment,
 * including the fail-open JWT secret-rotation reader. Kept in its own
 * module so the runtime-assembly file stays focused on orchestration.
 */

import { readFileSync } from "node:fs";

import { AsyncAuth, Auth, DefaultAuthProvider, InMemoryUserStore, JwtTokenProvider, KyselyAuthProvider, KyselyUserStore, type MuseAuth } from "@muse/auth";
import { isRecord } from "@muse/shared";
import type { MuseDatabase } from "@muse/db";
import type { Kysely } from "kysely";

import { parseInteger } from "./env-parsers.js";
import type { MuseEnvironment } from "./index.js";

interface AutoconfigureJwtRotationState {
  readonly current: string;
  readonly previous: ReadonlyArray<{ readonly secret: string; readonly validUntil: string }>;
}

/**
 * Synchronous, fail-open reader for the JWT rotation
 * state file (`~/.muse/auth-secrets.json` by default; overridable
 * via `MUSE_AUTH_SECRETS_FILE`). Any read / parse / shape error
 * returns `undefined` so the auth service silently falls through
 * to the env-only path — a corrupted state file cannot lock an
 * operator out of their own daemon.
 */
function loadJwtRotationStateSync(env: MuseEnvironment): AutoconfigureJwtRotationState | undefined {
  const overridden = env.MUSE_AUTH_SECRETS_FILE?.trim();
  let file: string;
  if (overridden && overridden.length > 0) {
    file = overridden;
  } else {
    const envHome = (env.HOME ?? process.env.HOME)?.trim();
    if (!envHome || envHome.length === 0) return undefined;
    file = `${envHome}/.muse/auth-secrets.json`;
  }
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
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
  if (typeof parsed.current !== "string" || parsed.current.length < 32) return undefined;
  const previousRaw = Array.isArray(parsed.previous) ? parsed.previous : [];
  const previous: AutoconfigureJwtRotationState["previous"] = previousRaw.flatMap((entry: unknown) => {
    if (!isRecord(entry)) return [];
    if (typeof entry.secret !== "string" || entry.secret.length < 32) return [];
    if (typeof entry.validUntil !== "string") return [];
    return [{ secret: entry.secret, validUntil: entry.validUntil }];
  });
  return { current: parsed.current, previous };
}

export function createAuthService(env: MuseEnvironment, db: Kysely<MuseDatabase> | undefined): MuseAuth | undefined {
  const rotation = loadJwtRotationStateSync(env);
  const jwtSecret = rotation?.current ?? env.MUSE_AUTH_JWT_SECRET?.trim();

  if (!jwtSecret) {
    return undefined;
  }

  // Non-expired rotation `previous` secrets flow in for the grace
  // window; absent/malformed file → env-only.
  const previousJwtSecrets = rotation
    ? rotation.previous
        .filter((entry) => Date.parse(entry.validUntil) > Date.now())
        .map((entry) => entry.secret)
    : undefined;

  const jwt = new JwtTokenProvider({
    jwtExpirationMs: parseInteger(env.MUSE_AUTH_JWT_EXPIRATION_MS, 86_400_000),
    jwtSecret,
    ...(previousJwtSecrets && previousJwtSecrets.length > 0 ? { previousJwtSecrets } : {})
  });

  if (db) {
    const userStore = new KyselyUserStore(db);
    const provider = new KyselyAuthProvider(userStore);
    return new AsyncAuth({
      authProvider: provider,
      jwt,
      userStore
    });
  }

  const userStore = new InMemoryUserStore(parseInteger(env.MUSE_AUTH_MAX_USERS, 10_000));
  const provider = new DefaultAuthProvider(userStore);
  return new Auth({
    authProvider: provider,
    jwt,
    userStore
  });
}
