/**
 * Encrypted credential store for the Muse CLI.
 *
 * Backs `muse auth login / status / logout` (and the implicit token
 * lookup that `apiRequest` does). Tokens are stored as a JSON map
 * keyed by API base URL, encrypted with AES-256-GCM. The key is
 * scrypt-derived from `MUSE_CREDENTIAL_KEY` (or a per-host fallback
 * built from `userInfo().username + homedir() + hostname()`) and a
 * random per-write salt.
 *
 * Lifted out of `program.ts` (which had grown past 800 LOC) so the
 * crypto + on-disk storage code is one focused module. `program.ts`
 * imports the helpers directly; `commands-auth.ts` takes
 * them via DI from `program.ts` and stays unchanged.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { isRecord } from "@muse/shared";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, hostname, userInfo } from "node:os";
import path from "node:path";

import type { ProgramIO } from "./program.js";

interface StoredCredential {
  readonly token: string;
  readonly updatedAt: string;
}

export interface CredentialStore {
  readonly tokens: Record<string, StoredCredential>;
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

export function credentialPath(io: ProgramIO): string {
  return io.configDir ? path.join(io.configDir, "credentials.json") : defaultCredentialPath();
}

export async function readStoredToken(io: ProgramIO, baseUrl: string): Promise<string | undefined> {
  try {
    return (await readCredentialStore(io)).tokens[baseUrl]?.token;
  } catch (error) {
    // Corrupted / unreadable store on a READ path must degrade to
    // "no credentials" — every auth-aware command else crashes
    // with the raw error instead of falling back to anonymous mode.
    // Write paths (writeStoredToken / deleteStoredToken) keep
    // throwing so a silent overwrite can't clobber other-baseUrl
    // tokens behind a corrupted file.
    io.stderr(
      `(warning: credentials store unreadable: ${
        error instanceof Error ? error.message : String(error)
      }; treating as no credentials. Re-login with \`muse auth login\` to write a fresh store.)\n`
    );
    return undefined;
  }
}

export async function writeStoredToken(io: ProgramIO, baseUrl: string, token: string): Promise<void> {
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

export async function deleteStoredToken(io: ProgramIO, baseUrl: string): Promise<void> {
  const store = await readCredentialStore(io, { startFreshIfUnreadable: true });
  const { [baseUrl]: _removed, ...tokens } = store.tokens;
  await writeCredentialStore(io, { tokens });
}

async function readCredentialStore(
  io: ProgramIO,
  options: { readonly startFreshIfUnreadable?: boolean } = {}
): Promise<CredentialStore> {
  let raw: string;
  try {
    raw = await readFile(credentialPath(io), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { tokens: {} };
    }
    // A genuine filesystem error (permissions, etc.) is not a "content
    // unreadable" condition — surface it on every path.
    throw error;
  }

  try {
    const file = JSON.parse(raw) as unknown;
    if (!isEncryptedCredentialFile(file)) {
      throw new Error("Invalid Muse credential store format");
    }

    const plaintext = decryptCredentialPayload(io, file);
    const store = JSON.parse(plaintext) as unknown;
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

async function writeCredentialStore(io: ProgramIO, store: CredentialStore): Promise<void> {
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
  await chmod(filePath, 0o600).catch(() => undefined);
}

function encryptCredentialPayload(io: ProgramIO, plaintext: string): EncryptedCredentialFile {
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

function decryptCredentialPayload(io: ProgramIO, file: EncryptedCredentialFile): string {
  const salt = Buffer.from(file.salt, "base64");
  const iv = Buffer.from(file.iv, "base64");
  const tag = Buffer.from(file.tag, "base64");
  const key = deriveCredentialKey(io, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(file.data, "base64")), decipher.final()]).toString("utf8");
}

function deriveCredentialKey(io: ProgramIO, salt: Buffer): Buffer {
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
      && typeof credential.updatedAt === "string");
}

export { isRecord } from "@muse/shared";

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
