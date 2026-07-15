/**
 * Persistent per-server OAuth 2.1 state for remote MCP servers.
 *
 * One file per server at `<oauthDir>/<serverId>.json` holding the tokens,
 * the Dynamic-Client-Registration client info, the in-flight PKCE code
 * verifier, and the CSRF state. Kept in a dedicated store (NOT the
 * `mcp.json` server registry) so a bearer token never lands in the config
 * a user edits or shares. Contents are encrypted at rest via the shared
 * credential-encryption envelope when `MUSE_CREDENTIALS_ENCRYPT` is enabled
 * (or the file is already encrypted — sticky), mirroring
 * `FileMessagingCredentialStore`; plaintext JSON (chmod 0600) otherwise.
 *
 * A corrupt/undecryptable-as-corruption file is treated as EMPTY (quarantined
 * once, like the calendar store) so a garbled sidecar never blocks a connect.
 * A wrong `MUSE_MEMORY_KEY` on a genuinely-encrypted file THROWS fail-closed
 * (via `decodeMaybeEncryptedCredentialsJson`) rather than silently discarding
 * a live token.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  backupPlaintextCredentialsFile,
  credentialEncryptionEnabled,
  decodeMaybeEncryptedCredentialsJson,
  encryptCredentialEnvelope,
  isCredentialsFileEncryptedAtRest,
  isRecord
} from "@muse/shared";

import { quarantineCorruptStore } from "./corrupt-quarantine.js";

export interface OAuthRecord {
  readonly tokens?: OAuthTokens;
  readonly clientInformation?: OAuthClientInformationFull;
  readonly codeVerifier?: string;
  readonly state?: string;
}

export type OAuthClearScope = "all" | "tokens" | "client" | "verifier";

interface PersistedShape {
  readonly version: 1;
  readonly oauth: OAuthRecord;
}

/**
 * Map a Muse serverId onto ONE safe filename. A serverId is Muse-generated
 * (usually a UUID) but this store must never let a crafted id escape the
 * oauth dir via `..`/slashes: the sanitized stem keeps it readable, and an
 * 8-char hash suffix of the RAW id restores uniqueness two ids could lose to
 * sanitization. Security-relevant — this is the path-traversal guard.
 */
export function oauthRecordPath(dir: string, serverId: string): string {
  const stem = serverId.replace(/[^A-Za-z0-9._-]/gu, "_").replace(/^\.+/u, "_").slice(0, 64);
  const suffix = createHash("sha256").update(serverId).digest("hex").slice(0, 8);
  return join(dir, `${stem || "server"}-${suffix}.json`);
}

export async function loadOAuthRecord(
  dir: string,
  serverId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<OAuthRecord> {
  const file = oauthRecordPath(dir, serverId);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) {
      return {};
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await quarantineCorruptStore(file);
    return {};
  }

  // THROWS fail-closed on a wrong key for a genuinely-encrypted envelope —
  // never swallow a live token as "corruption".
  parsed = decodeMaybeEncryptedCredentialsJson(parsed, env);

  if (!isRecord(parsed) || !parsed.oauth || !isRecord(parsed.oauth)) {
    return {};
  }
  return { ...parsed.oauth };
}

export async function loadTokens(
  dir: string,
  serverId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<OAuthTokens | undefined> {
  return (await loadOAuthRecord(dir, serverId, env)).tokens;
}

export async function saveTokens(
  dir: string,
  serverId: string,
  tokens: OAuthTokens,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  await mutate(dir, serverId, env, (record) => ({ ...record, tokens }));
}

export async function loadClientInformation(
  dir: string,
  serverId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<OAuthClientInformationFull | undefined> {
  return (await loadOAuthRecord(dir, serverId, env)).clientInformation;
}

export async function saveClientInformation(
  dir: string,
  serverId: string,
  clientInformation: OAuthClientInformationFull,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  await mutate(dir, serverId, env, (record) => ({ ...record, clientInformation }));
}

export async function loadCodeVerifier(
  dir: string,
  serverId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | undefined> {
  return (await loadOAuthRecord(dir, serverId, env)).codeVerifier;
}

export async function saveCodeVerifier(
  dir: string,
  serverId: string,
  codeVerifier: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  await mutate(dir, serverId, env, (record) => ({ ...record, codeVerifier }));
}

export async function loadState(
  dir: string,
  serverId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | undefined> {
  return (await loadOAuthRecord(dir, serverId, env)).state;
}

export async function saveState(
  dir: string,
  serverId: string,
  state: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  await mutate(dir, serverId, env, (record) => ({ ...record, state }));
}

export async function clearOAuth(
  dir: string,
  serverId: string,
  scope: OAuthClearScope,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (scope === "all") {
    await fs.rm(oauthRecordPath(dir, serverId), { force: true });
    return;
  }
  await mutate(dir, serverId, env, (record) => {
    const next = { ...record };
    if (scope === "tokens") {
      const { tokens: _tokens, ...rest } = next;
      return rest;
    } else if (scope === "client") {
      const { clientInformation: _clientInformation, ...rest } = next;
      return rest;
    } else if (scope === "verifier") {
      const { codeVerifier: _codeVerifier, ...rest } = next;
      return rest;
    }
    return next;
  });
}

async function mutate(
  dir: string,
  serverId: string,
  env: NodeJS.ProcessEnv,
  apply: (record: OAuthRecord) => OAuthRecord
): Promise<void> {
  const current = await loadOAuthRecord(dir, serverId, env);
  await writeRecord(dir, serverId, apply(current), env);
}

async function writeRecord(
  dir: string,
  serverId: string,
  record: OAuthRecord,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const file = oauthRecordPath(dir, serverId);
  await fs.mkdir(dir, { recursive: true });
  const payload = `${JSON.stringify({ oauth: record, version: 1 } satisfies PersistedShape, null, 2)}\n`;
  const alreadyEncrypted = await isCredentialsFileEncryptedAtRest(file);
  const shouldEncrypt = credentialEncryptionEnabled(env) || alreadyEncrypted;
  if (shouldEncrypt && !alreadyEncrypted) {
    const existing = await fs.readFile(file, "utf8").catch(() => undefined);
    if (existing !== undefined) {
      await backupPlaintextCredentialsFile(file, existing);
    }
  }
  const content = shouldEncrypt ? `${JSON.stringify(encryptCredentialEnvelope(payload, env))}\n` : payload;
  const tmp = `${file}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
  await fs.writeFile(tmp, content, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
}

function isFileNotFound(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  return error.code === "ENOENT";
}
