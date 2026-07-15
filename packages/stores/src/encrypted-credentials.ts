/**
 * Encrypted credential store shared by the CLI and the API server.
 *
 * Backs `muse auth login / status / logout` (and the implicit token
 * lookup that `apiRequest` does), plus the Gmail OAuth record `muse
 * setup email` writes. Tokens are stored as a JSON map keyed by API
 * base URL, encrypted with AES-256-GCM. The key is scrypt-derived
 * from `MUSE_CREDENTIAL_KEY` (or a per-host fallback built from
 * `userInfo().username + homedir() + hostname()`) and a random
 * per-write salt.
 *
 * Promoted out of `apps/cli/src/credential-store.ts` (which re-exports
 * everything here unchanged) so `apps/api` — which cannot import from
 * `apps/cli` — can read the SAME on-disk `~/.config/muse/credentials.json`
 * for read-only status surfaces (e.g. `GET /api/email/status`) without
 * duplicating the crypto. On-disk format is byte-compatible with the
 * pre-move code; no migration.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { hasNodeErrorCodeIn, isRecord, NODE_ERROR_CODES, withBestEffort } from "@muse/shared";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import path from "node:path";

/**
 * The minimal I/O seam the store needs. `apps/cli`'s `ProgramIO` (required
 * `stderr`, optional `configDir` / `credentialKey`) satisfies this
 * structurally — no adapter needed at the call sites.
 */
export interface CredentialStoreIO {
  readonly configDir?: string;
  readonly credentialKey?: string;
  readonly stderr?: (message: string) => void;
}

interface StoredCredential {
  readonly token: string;
  readonly updatedAt: string;
}

/**
 * The Gmail OAuth record `muse setup email` writes and `GmailTokenSource`
 * (gmail-oauth.ts) refreshes. `refreshTokenInvalid` is set (never cleared
 * automatically) when the token endpoint returns `invalid_grant` — the
 * refresh token is kept for diagnosis, but the flag short-circuits every
 * further refresh attempt until the user re-runs `muse setup email`.
 */
export interface GmailOAuthCredential {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly accessToken?: string;
  /** Epoch ms. */
  readonly accessTokenExpiresAt?: number;
  readonly refreshTokenInvalid?: boolean;
}

/**
 * The App Password (IMAP/SMTP) record `muse setup email`'s recommended
 * path writes — a SIBLING of `gmail` (OAuth), not a replacement: both can
 * exist, and `resolveGmailProvider` picks between them. Works for Gmail
 * (`imapHost`/`smtpHost` omitted → Gmail defaults) and any other IMAP
 * provider (Naver, Daum, …) by supplying the host overrides.
 */
export interface ImapEmailCredential {
  readonly email: string;
  readonly appPassword: string;
  readonly imapHost?: string;
  readonly smtpHost?: string;
}

interface CredentialStore {
  readonly tokens: Record<string, StoredCredential>;
  readonly gmail?: GmailOAuthCredential;
  readonly emailImap?: ImapEmailCredential;
}

interface EncryptedCredentialFile {
  readonly algorithm: "aes-256-gcm";
  readonly data: string;
  readonly iv: string;
  readonly salt: string;
  readonly tag: string;
  readonly version: 1;
}

export function defaultCredentialPath(home?: string): string {
  // A pre-cleared `HOME=` (or a stripped-env case where
  // `os.homedir()` also returns "") would silently resolve the
  // credentials store at the filesystem root — fail loud
  // instead of writing tokens to `/.config/muse/...`.
  const explicit = typeof home === "string" ? home.trim() : "";
  if (explicit.length > 0) return `${explicit}/.config/muse/credentials.json`;
  const envHome = process.env.HOME?.trim();
  if (envHome && envHome.length > 0) return `${envHome}/.config/muse/credentials.json`;
  const sysHome = homedir().trim();
  if (sysHome.length > 0) return `${sysHome}/.config/muse/credentials.json`;
  throw new Error("Cannot resolve home directory for credentials.json — HOME is empty and os.homedir() returned no value");
}

export function credentialPath(io: CredentialStoreIO): string {
  return io.configDir ? path.join(io.configDir, "credentials.json") : defaultCredentialPath();
}

export async function readStoredToken(io: CredentialStoreIO, baseUrl: string): Promise<string | undefined> {
  try {
    return (await readCredentialStore(io)).tokens[baseUrl]?.token;
  } catch (error) {
    // Corrupted / unreadable store on a READ path must degrade to
    // "no credentials" — every auth-aware command else crashes
    // with the raw error instead of falling back to anonymous mode.
    // Write paths (writeStoredToken / deleteStoredToken) keep
    // throwing so a silent overwrite can't clobber other-baseUrl
    // tokens behind a corrupted file.
    io.stderr?.(
      `(warning: credentials store unreadable: ${
        error instanceof Error ? error.message : String(error)
      }; treating as no credentials. Re-login with \`muse auth login\` to write a fresh store.)\n`
    );
    return undefined;
  }
}

export async function writeStoredToken(io: CredentialStoreIO, baseUrl: string, token: string): Promise<void> {
  const store = await readCredentialStore(io, { startFreshIfUnreadable: true });
  await writeCredentialStore(io, {
    tokens: {
      ...store.tokens,
      [baseUrl]: {
        token,
        updatedAt: new Date().toISOString()
      }
    }
  });
}

export async function deleteStoredToken(io: CredentialStoreIO, baseUrl: string): Promise<void> {
  const store = await readCredentialStore(io, { startFreshIfUnreadable: true });
  const { [baseUrl]: _removed, ...tokens } = store.tokens;
  await writeCredentialStore(io, { tokens });
}

export async function readGmailCredential(io: CredentialStoreIO): Promise<GmailOAuthCredential | undefined> {
  try {
    return (await readCredentialStore(io)).gmail;
  } catch {
    // Same degrade-to-undefined posture as readStoredToken: a corrupted
    // store on a read path must never crash a caller that only wants to
    // know whether Gmail is connected.
    return undefined;
  }
}

export async function writeGmailCredential(io: CredentialStoreIO, credential: GmailOAuthCredential): Promise<void> {
  const store = await readCredentialStore(io, { startFreshIfUnreadable: true });
  await writeCredentialStore(io, { ...store, gmail: credential });
}

export async function deleteGmailCredential(io: CredentialStoreIO): Promise<void> {
  const store = await readCredentialStore(io, { startFreshIfUnreadable: true });
  const { gmail: _removed, ...rest } = store;
  await writeCredentialStore(io, rest);
}

export async function readEmailImapCredential(io: CredentialStoreIO): Promise<ImapEmailCredential | undefined> {
  try {
    return (await readCredentialStore(io)).emailImap;
  } catch {
    // Same degrade-to-undefined posture as readGmailCredential.
    return undefined;
  }
}

export async function writeEmailImapCredential(io: CredentialStoreIO, credential: ImapEmailCredential): Promise<void> {
  const store = await readCredentialStore(io, { startFreshIfUnreadable: true });
  await writeCredentialStore(io, { ...store, emailImap: credential });
}

export async function deleteEmailImapCredential(io: CredentialStoreIO): Promise<void> {
  const store = await readCredentialStore(io, { startFreshIfUnreadable: true });
  const { emailImap: _removed, ...rest } = store;
  await writeCredentialStore(io, rest);
}

/**
 * Synchronous "is Gmail connected" check for callers that must stay sync
 * (`resolveGmailProvider` and the actuator availability banner, both of
 * which decide construction/armed-status before any async work starts).
 * Every crypto primitive here (scrypt / AES-GCM) is already sync — only the
 * fs read differs from `readCredentialStore`. Fail-soft: any read/parse/
 * decrypt failure reads as "not connected", never throws.
 */
export function hasStoredGmailCredentialSync(io: CredentialStoreIO): boolean {
  let raw: string;
  try {
    raw = readFileSync(credentialPath(io), "utf8");
  } catch {
    return false;
  }
  try {
    const file = JSON.parse(raw);
    if (!isEncryptedCredentialFile(file)) return false;
    const plaintext = decryptCredentialPayload(io, file);
    const store = JSON.parse(plaintext);
    return isCredentialStore(store) && store.gmail !== undefined && !store.gmail.refreshTokenInvalid;
  } catch {
    return false;
  }
}

/** Same synchronous, fail-soft posture as `hasStoredGmailCredentialSync`, for the App Password (IMAP) record. */
export function hasStoredEmailImapCredentialSync(io: CredentialStoreIO): boolean {
  return readEmailImapCredentialSync(io) !== undefined;
}

/**
 * Synchronous read of the App Password record — unlike Gmail's OAuth
 * provider (which only needs a lazily-resolving token SOURCE at
 * construction time and can defer the real decrypt), `ImapSmtpEmailProvider`
 * needs the full `{email, appPassword, ...}` record up front, so
 * `resolveGmailProvider` (which must stay synchronous — every existing
 * call site depends on that) needs a sync read, not just a sync boolean
 * check. Every crypto primitive here is already sync (see
 * `hasStoredGmailCredentialSync`); fail-soft: any read/parse/decrypt
 * failure reads as "not configured", never throws.
 */
export function readEmailImapCredentialSync(io: CredentialStoreIO): ImapEmailCredential | undefined {
  let raw: string;
  try {
    raw = readFileSync(credentialPath(io), "utf8");
  } catch {
    return undefined;
  }
  try {
    const file = JSON.parse(raw);
    if (!isEncryptedCredentialFile(file)) return undefined;
    const plaintext = decryptCredentialPayload(io, file);
    const store = JSON.parse(plaintext);
    return isCredentialStore(store) ? store.emailImap : undefined;
  } catch {
    return undefined;
  }
}

async function readCredentialStore(
  io: CredentialStoreIO,
  options: { readonly startFreshIfUnreadable?: boolean } = {}
): Promise<CredentialStore> {
  let raw: string;
  try {
    raw = await readFile(credentialPath(io), "utf8");
  } catch (error) {
    if (hasNodeErrorCodeIn(error, NODE_ERROR_CODES.ENOENT)) {
      return { tokens: {} };
    }
    // A genuine filesystem error (permissions, etc.) is not a "content
    // unreadable" condition — surface it on every path.
    throw error;
  }

  try {
    const file = JSON.parse(raw);
    if (!isEncryptedCredentialFile(file)) {
      throw new Error("Invalid Muse credential store format");
    }

    const plaintext = decryptCredentialPayload(io, file);
    const store = JSON.parse(plaintext);
    if (!isCredentialStore(store)) {
      throw new Error("Invalid Muse credential payload");
    }

    return store;
  } catch (error) {
    // Content can't be interpreted (corrupt JSON, bad format, or — the
    // common one — the per-host fallback key changed because the hostname
    // changed, so AES-GCM auth fails). On a WRITE the existing ciphertext
    // is unrecoverable anyway, so there are no tokens left to preserve:
    // start fresh so `muse auth login` can actually recover (the warning
    // on the read path promises exactly this). Reads still rethrow → their
    // own catch degrades to "no credentials".
    if (options.startFreshIfUnreadable) {
      return { tokens: {} };
    }
    throw error;
  }
}

async function writeCredentialStore(io: CredentialStoreIO, store: CredentialStore): Promise<void> {
  const filePath = credentialPath(io);
  await mkdir(path.dirname(filePath), { recursive: true });
  // Atomic tmp+rename: a crash / OS panic / disk-full between
  // open(O_TRUNC) and write would otherwise leave `credentials.json`
  // at 0 bytes — JSON.parse "" fails on next read → treated as
  // no creds → forced re-login. Every other store in the codebase
  // (telegram-offset / slack-after / discord-after / inbox-store /
  // inbox-injection-cursor / inbox-reply-cursor) uses this pattern
  // for exactly this reason; credential-store was the missed site.
  const tmp = `${filePath}.tmp-${process.pid.toString()}-${randomBytes(8).toString("hex")}`;
  await writeFile(tmp, `${JSON.stringify(encryptCredentialPayload(io, JSON.stringify(store)), null, 2)}\n`, {
    mode: 0o600
  });
  await rename(tmp, filePath);
    await withBestEffort(chmod(filePath, 0o600), undefined);
}

function encryptCredentialPayload(io: CredentialStoreIO, plaintext: string): EncryptedCredentialFile {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveCredentialKey(io, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    algorithm: "aes-256-gcm",
    data: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    salt: salt.toString("base64"),
    tag: tag.toString("base64"),
    version: 1
  };
}

function decryptCredentialPayload(io: CredentialStoreIO, file: EncryptedCredentialFile): string {
  const salt = Buffer.from(file.salt, "base64");
  const iv = Buffer.from(file.iv, "base64");
  const tag = Buffer.from(file.tag, "base64");
  const key = deriveCredentialKey(io, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(file.data, "base64")), decipher.final()]).toString("utf8");
}

function deriveCredentialKey(io: CredentialStoreIO, salt: Buffer): Buffer {
  return scryptSync(io.credentialKey ?? process.env.MUSE_CREDENTIAL_KEY ?? localCredentialSecret(), salt, 32);
}

function localCredentialSecret(): string {
  return [
    "muse-cli",
    userInfo().username,
    homedir(),
    hostname()
  ].join(":");
}

function isEncryptedCredentialFile(value: unknown): value is EncryptedCredentialFile {
  return isRecord(value)
    && value.version === 1
    && value.algorithm === "aes-256-gcm"
    && typeof value.data === "string"
    && typeof value.iv === "string"
    && typeof value.salt === "string"
    && typeof value.tag === "string";
}

function isCredentialStore(value: unknown): value is CredentialStore {
  return isRecord(value)
    && isRecord(value.tokens)
    && Object.values(value.tokens).every((credential) => isRecord(credential)
      && typeof credential.token === "string"
      && typeof credential.updatedAt === "string")
    // `gmail` is a new, optional field — an OLD credentials.json (written
    // before this field existed) has no `gmail` key at all and must keep
    // loading exactly as it did before (backward compatibility). `emailImap`
    // is the same shape of addition (E2): absence must read cleanly too.
    && (value.gmail === undefined || isGmailOAuthCredential(value.gmail))
    && (value.emailImap === undefined || isImapEmailCredential(value.emailImap));
}

function isGmailOAuthCredential(value: unknown): value is GmailOAuthCredential {
  return isRecord(value)
    && typeof value.clientId === "string"
    && typeof value.clientSecret === "string"
    && typeof value.refreshToken === "string"
    && (value.accessToken === undefined || typeof value.accessToken === "string")
    && (value.accessTokenExpiresAt === undefined || typeof value.accessTokenExpiresAt === "number")
    && (value.refreshTokenInvalid === undefined || typeof value.refreshTokenInvalid === "boolean");
}

function isImapEmailCredential(value: unknown): value is ImapEmailCredential {
  return isRecord(value)
    && typeof value.email === "string"
    && typeof value.appPassword === "string"
    && (value.imapHost === undefined || typeof value.imapHost === "string")
    && (value.smtpHost === undefined || typeof value.smtpHost === "string");
}
