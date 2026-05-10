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
 * imports the helpers directly; `commands-auth.ts` (round 94) takes
 * them via DI from `program.ts` and stays unchanged.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
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

export function defaultCredentialPath(home: string = process.env.HOME ?? homedir()): string {
  return `${home}/.config/muse/credentials.json`;
}

export function credentialPath(io: ProgramIO): string {
  return io.configDir ? path.join(io.configDir, "credentials.json") : defaultCredentialPath();
}

export async function readStoredToken(io: ProgramIO, baseUrl: string): Promise<string | undefined> {
  return (await readCredentialStore(io)).tokens[baseUrl]?.token;
}

export async function writeStoredToken(io: ProgramIO, baseUrl: string, token: string): Promise<void> {
  const store = await readCredentialStore(io);
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
  const store = await readCredentialStore(io);
  const { [baseUrl]: _removed, ...tokens } = store.tokens;
  await writeCredentialStore(io, { tokens });
}

async function readCredentialStore(io: ProgramIO): Promise<CredentialStore> {
  try {
    const raw = await readFile(credentialPath(io), "utf8");
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
    if (isNodeError(error) && error.code === "ENOENT") {
      return { tokens: {} };
    }

    throw error;
  }
}

async function writeCredentialStore(io: ProgramIO, store: CredentialStore): Promise<void> {
  const filePath = credentialPath(io);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(encryptCredentialPayload(io, JSON.stringify(store)), null, 2)}\n`, {
    mode: 0o600
  });
  await chmod(filePath, 0o600);
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
