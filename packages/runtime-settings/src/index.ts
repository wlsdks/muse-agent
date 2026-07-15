import type { JsonValue } from "@muse/shared";

export type Awaitable<T> = T | Promise<T>;
export type RuntimeSettingType = "string" | "number" | "boolean" | "json";

export interface RuntimeSetting {
  readonly key: string;
  readonly value: string;
  readonly type: RuntimeSettingType;
  readonly category: string;
  readonly description?: string;
  readonly updatedBy?: string;
  readonly updatedAt: Date;
}

export interface RuntimeSettingUpsert {
  readonly key: string;
  readonly value: string;
  readonly type?: RuntimeSettingType;
  readonly category?: string;
  readonly description?: string | null;
  readonly updatedBy?: string | null;
  readonly updatedAt?: Date;
}

export interface RuntimeSettingsStore {
  findValue(key: string): Awaitable<string | undefined>;
  find(key: string): Awaitable<RuntimeSetting | undefined>;
  list(): Awaitable<readonly RuntimeSetting[]>;
  upsert(input: RuntimeSettingUpsert): Awaitable<RuntimeSetting>;
  delete(key: string): Awaitable<void>;
}

export interface RuntimeSettingsOptions {
  readonly cacheTtlMs?: number;
  readonly now?: () => Date;
}

export class InMemoryRuntimeSettingsStore implements RuntimeSettingsStore {
  private readonly settings = new Map<string, RuntimeSetting>();
  private readonly now: () => Date;

  constructor(settings: readonly RuntimeSetting[] = [], options: { readonly now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());

    for (const setting of settings) {
      this.settings.set(setting.key, setting);
    }
  }

  findValue(key: string): string | undefined {
    return this.settings.get(key)?.value;
  }

  find(key: string): RuntimeSetting | undefined {
    return this.settings.get(key);
  }

  list(): readonly RuntimeSetting[] {
    return [...this.settings.values()].sort(compareRuntimeSettings);
  }

  upsert(input: RuntimeSettingUpsert): RuntimeSetting {
    const existing = this.settings.get(input.key);
    const setting: RuntimeSetting = {
      category: input.category ?? existing?.category ?? "general",
      description:
        input.description === undefined ? existing?.description : input.description ?? undefined,
      key: input.key,
      type: input.type ?? existing?.type ?? "string",
      updatedAt: input.updatedAt ?? this.now(),
      updatedBy: input.updatedBy ?? undefined,
      value: input.value
    };

    this.settings.set(setting.key, setting);
    return setting;
  }

  delete(key: string): void {
    this.settings.delete(key);
  }
}

export class RuntimeSettings {
  private readonly cache = new Map<string, CachedSetting>();
  private readonly cacheTtlMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly store: RuntimeSettingsStore,
    options: RuntimeSettingsOptions = {}
  ) {
    // `??` does NOT catch NaN / Infinity / 0 / negative. NaN poisons
    // `now + NaN = NaN`; every later `expiresAt > now` is false →
    // silent always-miss → store hit on every getValue. Infinity
    // never expires → stale cache survives runtime-setting writes
    // from sibling tools that bypass `this.set()`. Fail safe to the
    // documented 30-second default.
    const rawTtl = options.cacheTtlMs ?? 30_000;
    this.cacheTtlMs = Number.isFinite(rawTtl) && rawTtl > 0 ? rawTtl : 30_000;
    this.now = options.now ?? (() => new Date());
  }

  async getString(key: string, defaultValue: string): Promise<string> {
    return (await this.getValue(key)) ?? defaultValue;
  }

  async getBoolean(key: string, defaultValue: boolean): Promise<boolean> {
    const value = await this.getValue(key);

    if (value === undefined) {
      return defaultValue;
    }

    // Unknown spellings fall back to defaultValue (not false) so an
    // admin's intent isn't silently inverted.
    const parsed = parseBooleanValue(value);
    return parsed ?? defaultValue;
  }

  async getNumber(key: string, defaultValue: number): Promise<number> {
    const value = await this.getValue(key);
    const parsed = parseFiniteNumber(value);

    return parsed ?? defaultValue;
  }

  async getInteger(key: string, defaultValue: number): Promise<number> {
    const value = await this.getValue(key);
    const parsed = parseFiniteNumber(value);

    return parsed !== undefined && Number.isSafeInteger(parsed) ? parsed : defaultValue;
  }

  async getJson<T extends JsonValue>(key: string, defaultValue: T): Promise<T> {
    const value = await this.getValue(key);

    if (value === undefined) {
      return defaultValue;
    }

    try {
      return JSON.parse(value) as T;
    } catch {
      return defaultValue;
    }
  }

  async set(input: RuntimeSettingUpsert): Promise<RuntimeSetting> {
    const setting = await this.store.upsert(input);
    this.cache.delete(input.key);
    return setting;
  }

  async delete(key: string): Promise<void> {
    await this.store.delete(key);
    this.cache.delete(key);
  }

  find(key: string): Awaitable<RuntimeSetting | undefined> {
    return this.store.find(key);
  }

  list(): Awaitable<readonly RuntimeSetting[]> {
    return this.store.list();
  }

  refreshCache(): void {
    this.cache.clear();
  }

  private async getValue(key: string): Promise<string | undefined> {
    const cached = this.cache.get(key);

    if (cached && cached.expiresAt > this.now().getTime()) {
      return cached.value;
    }

    const value = await this.store.findValue(key);
    this.cache.set(key, {
      expiresAt: this.now().getTime() + this.cacheTtlMs,
      value
    });
    return value;
  }
}

interface CachedSetting {
  readonly expiresAt: number;
  readonly value: string | undefined;
}

function compareRuntimeSettings(left: RuntimeSetting, right: RuntimeSetting): number {
  return left.category.localeCompare(right.category) || left.key.localeCompare(right.key);
}

function parseFiniteNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Recognises the common admin spellings of true / false (case-
 * insensitive, trimmed): `true / 1 / yes / on` → true,
 * `false / 0 / no / off` → false, anything else → undefined.
 *
 * Exported so consumers wiring custom boolean-shaped RuntimeSetting
 * values (or env-flag readers that need a tri-state distinguishing
 * "unset" from "explicit value") share the same parser used
 * internally by `RuntimeSettings.getBoolean`.
 */
export function parseBooleanSetting(value: string | undefined): boolean | undefined {
  return parseBooleanValue(value);
}

const TRUTHY_VALUES: ReadonlySet<string> = new Set(["true", "1", "yes", "on"]);
const FALSY_VALUES: ReadonlySet<string> = new Set(["false", "0", "no", "off"]);

function parseBooleanValue(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalised = value.trim().toLowerCase();
  if (TRUTHY_VALUES.has(normalised)) return true;
  if (FALSY_VALUES.has(normalised)) return false;
  return undefined;
}

export { KyselyRuntimeSettingsStore } from "./kysely-store.js";
export type { KyselyRuntimeSettingsStoreOptions } from "./kysely-store.js";
