import { promises as fs } from "node:fs";
import {
  backupPlaintextCredentialsFile,
  credentialEncryptionEnabled,
  decodeMaybeEncryptedCredentialsJson,
  encryptCredentialEnvelope,
  isCredentialsFileEncryptedAtRest,
  type JsonObject
} from "@muse/shared";

import { atomicWritePrivateFile, quarantineCorruptMessagingFile, withMessagingFileMutation } from "./messaging-file-store.js";

export type MessagingCredentials = JsonObject;

export interface MessagingCredentialStore {
  load(providerId: string): Promise<MessagingCredentials | undefined>;
  save(providerId: string, credentials: MessagingCredentials): Promise<void>;
  remove(providerId: string): Promise<void>;
  list(): Promise<readonly string[]>;
}

interface PersistedShape {
  readonly version: 1;
  readonly providers: Record<string, MessagingCredentials>;
}

/**
 * Single-file JSON credential store. Same chmod 600 atomic-write
 * pattern `FileCalendarCredentialStore` uses; lives in its own file
 * (default `~/.muse/messaging.json`) so revoking a calendar
 * credential doesn't accidentally touch a Telegram bot token.
 */
export class FileMessagingCredentialStore implements MessagingCredentialStore {
  private readonly file: string;
  private readonly env: NodeJS.ProcessEnv;

  /** `env` defaults to `process.env`; tests inject `MUSE_MEMORY_KEY` / `MUSE_CREDENTIALS_ENCRYPT`. */
  constructor(file: string, env: NodeJS.ProcessEnv = process.env) {
    this.file = file;
    this.env = env;
  }

  async load(providerId: string): Promise<MessagingCredentials | undefined> {
    const all = await this.readAll();
    const entry = all.providers[providerId];
    return entry ? { ...entry } : undefined;
  }

  async save(providerId: string, credentials: MessagingCredentials): Promise<void> {
    await this.mutateAll(async (all) => {
      await this.writeAll({
        providers: { ...all.providers, [providerId]: { ...credentials } },
        version: 1
      });
    });
  }

  async remove(providerId: string): Promise<void> {
    await this.mutateAll(async (all) => {
      if (!(providerId in all.providers)) {
        return;
      }
      const { [providerId]: _ignored, ...rest } = all.providers;
      await this.writeAll({ providers: rest, version: 1 });
    });
  }

  async list(): Promise<readonly string[]> {
    const all = await this.readAll();
    return Object.keys(all.providers).sort();
  }

  /**
   * Format-preserving read: transparently decrypts an encrypted envelope OR
   * reads legacy plaintext — an existing user's plaintext `messaging.json`
   * keeps working unchanged. A wrong `MUSE_MEMORY_KEY` on an ENCRYPTED file
   * THROWS (fail-closed) rather than silently returning an empty store.
   */
  private async readAll(): Promise<PersistedShape> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) {
        return { providers: emptyProviderMap(), version: 1 };
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await quarantineCorruptMessagingFile(this.file);
      return { providers: emptyProviderMap(), version: 1 };
    }
    parsed = decodeMaybeEncryptedCredentialsJson(parsed, this.env); // THROWS fail-closed on a wrong key
    const shape = parsed as Partial<PersistedShape>;
    if (!shape || typeof shape !== "object" || !shape.providers || typeof shape.providers !== "object") {
      await quarantineCorruptMessagingFile(this.file);
      return { providers: emptyProviderMap(), version: 1 };
    }
    const providers = emptyProviderMap();
    for (const [id, value] of Object.entries(shape.providers)) {
      providers[id] = value as MessagingCredentials;
    }
    return { providers, version: 1 };
  }

  /**
   * Atomic write. Encrypts only when `MUSE_CREDENTIALS_ENCRYPT` is enabled AND
   * a key is available, OR the file is ALREADY encrypted on disk (sticky).
   * Absent both, writes plaintext (chmod 600) exactly as before. The first
   * plaintext→encrypted transition backs up the existing plaintext first.
   */
  private async writeAll(value: PersistedShape): Promise<void> {
    const payload = `${JSON.stringify(value, null, 2)}\n`;
    const alreadyEncrypted = await isCredentialsFileEncryptedAtRest(this.file);
    const shouldEncrypt = credentialEncryptionEnabled(this.env) || alreadyEncrypted;
    if (shouldEncrypt && !alreadyEncrypted) {
      const existing = await fs.readFile(this.file, "utf8").catch(() => undefined);
      if (existing !== undefined) {
        await backupPlaintextCredentialsFile(this.file, existing);
      }
    }
    const content = shouldEncrypt ? `${JSON.stringify(encryptCredentialEnvelope(payload, this.env))}\n` : payload;
    await atomicWritePrivateFile(this.file, content);
    await fs.chmod(this.file, 0o600).catch(() => undefined);
  }

  private async mutateAll(mutator: (value: PersistedShape) => Promise<void>): Promise<void> {
    await withMessagingFileMutation(this.file, async () => {
      await mutator(await this.readAll());
    });
  }
}

function isFileNotFound(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { code?: string }).code === "ENOENT";
}

// Null-prototype so a providerId like `toString` / `__proto__` /
// `constructor` can't index an inherited Object.prototype member —
// otherwise `load` returns a bogus truthy value and `remove`'s `in`
// check false-hits. Mirrors FileCalendarCredentialStore.
function emptyProviderMap(): Record<string, MessagingCredentials> {
  return Object.create(null) as Record<string, MessagingCredentials>;
}
