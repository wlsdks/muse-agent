import { promises as fs } from "node:fs";
import { dirname } from "node:path";

import type { JsonObject } from "@muse/shared";

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

  constructor(file: string) {
    this.file = file;
  }

  async load(providerId: string): Promise<MessagingCredentials | undefined> {
    const all = await this.readAll();
    const entry = all.providers[providerId];
    return entry ? { ...entry } : undefined;
  }

  async save(providerId: string, credentials: MessagingCredentials): Promise<void> {
    const all = await this.readAll();
    const next: PersistedShape = {
      providers: { ...all.providers, [providerId]: { ...credentials } },
      version: 1
    };
    await this.writeAll(next);
  }

  async remove(providerId: string): Promise<void> {
    const all = await this.readAll();
    if (!(providerId in all.providers)) {
      return;
    }
    const { [providerId]: _ignored, ...rest } = all.providers;
    await this.writeAll({ providers: rest, version: 1 });
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
        return { providers: {}, version: 1 };
      }
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedShape>;
      if (!parsed || typeof parsed !== "object" || !parsed.providers || typeof parsed.providers !== "object") {
        return { providers: {}, version: 1 };
      }
      return { providers: { ...parsed.providers }, version: 1 };
    } catch {
      return { providers: {}, version: 1 };
    }
  }

  private async writeAll(value: PersistedShape): Promise<void> {
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    await fs.mkdir(dirname(this.file), { recursive: true });
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, this.file);
    await fs.chmod(this.file, 0o600).catch(() => undefined);
  }
}

function isFileNotFound(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { code?: string }).code === "ENOENT";
}
