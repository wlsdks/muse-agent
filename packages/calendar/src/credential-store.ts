import { promises as fs } from "node:fs";

import type { JsonObject } from "@muse/shared";
import { atomicWriteFile, withFileLock, withFileMutationQueue } from "@muse/stores";

import { quarantineCorruptStore } from "./corrupt-quarantine.js";

export type ProviderCredentials = JsonObject;

export interface CalendarCredentialStore {
  load(providerId: string): Promise<ProviderCredentials | undefined>;
  save(providerId: string, credentials: ProviderCredentials): Promise<void>;
  remove(providerId: string): Promise<void>;
  list(): Promise<readonly string[]>;
}

interface PersistedShape {
  readonly version: 1;
  readonly providers: Record<string, ProviderCredentials>;
}

/**
 * Single-file JSON credential store at `options.file` (default
 * `~/.muse/credentials.json`). The file is created with mode 0600 so
 * other unix users on the same box can't read it. This is good enough
 * for a personal-pivot deployment; if real OS keychain support is
 * needed later, swap this for a `KeychainCalendarCredentialStore`
 * implementation behind the same interface.
 */
export class FileCalendarCredentialStore implements CalendarCredentialStore {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  async load(providerId: string): Promise<ProviderCredentials | undefined> {
    const all = await this.readAll();
    const entry = all.providers[providerId];
    return entry ? { ...entry } : undefined;
  }

  async save(providerId: string, credentials: ProviderCredentials): Promise<void> {
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

    try {
      const parsed = JSON.parse(raw) as Partial<PersistedShape>;
      if (!parsed || typeof parsed !== "object" || !parsed.providers || typeof parsed.providers !== "object") {
        await quarantineCorruptStore(this.file);
        return { providers: emptyProviderMap(), version: 1 };
      }

      const providers = emptyProviderMap();
      for (const [id, value] of Object.entries(parsed.providers)) {
        providers[id] = value as ProviderCredentials;
      }
      return { providers, version: 1 };
    } catch {
      await quarantineCorruptStore(this.file);
      return { providers: emptyProviderMap(), version: 1 };
    }
  }

  private async writeAll(value: PersistedShape): Promise<void> {
    await atomicWriteFile(this.file, `${JSON.stringify(value, null, 2)}\n`);
    await fs.chmod(this.file, 0o600).catch(() => undefined);
  }

  private async mutateAll(mutator: (value: PersistedShape) => Promise<void>): Promise<void> {
    await withFileMutationQueue(this.file, async () => {
      await withFileLock(this.file, async () => {
        await mutator(await this.readAll());
      });
    });
  }
}

// Null-prototype so a providerId like `toString` / `__proto__`
// can't index an inherited Object.prototype member (load would
// otherwise return a bogus truthy {} and `in` would false-hit).
function emptyProviderMap(): Record<string, ProviderCredentials> {
  return Object.create(null) as Record<string, ProviderCredentials>;
}

function isFileNotFound(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { code?: string }).code === "ENOENT";
}
