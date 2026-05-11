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
    this.cacheTtlMs = options.cacheTtlMs ?? 30_000;
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

    return value.toLowerCase() === "true";
  }

  async getNumber(key: string, defaultValue: number): Promise<number> {
    const value = await this.getValue(key);
    const parsed = parseFiniteNumber(value);

    return parsed ?? defaultValue;
  }

  async getInteger(key: string, defaultValue: number): Promise<number> {
    const value = await this.getValue(key);
    const parsed = parseFiniteNumber(value);

    return parsed !== undefined && Number.isInteger(parsed) ? parsed : defaultValue;
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

export interface WebSearchRuntimeSettings {
  readonly enabled: boolean;
  readonly maxUses: number;
}

const DEFAULT_WEB_SEARCH: WebSearchRuntimeSettings = { enabled: true, maxUses: 5 };

export async function readWebSearchSettings(
  store: RuntimeSettingsStore,
  env: Readonly<Record<string, string | undefined>>
): Promise<WebSearchRuntimeSettings> {
  const enabledRaw = await store.findValue("webSearch.enabled");
  const maxRaw = await store.findValue("webSearch.maxUses");
  let enabled = enabledRaw === undefined ? DEFAULT_WEB_SEARCH.enabled : enabledRaw === "true";
  let maxUses = DEFAULT_WEB_SEARCH.maxUses;
  if (maxRaw !== undefined) {
    const n = Number.parseInt(maxRaw, 10);
    if (Number.isFinite(n) && n > 0) maxUses = n;
  }
  const envFlag = env.MUSE_WEB_SEARCH?.toLowerCase();
  if (envFlag === "off") enabled = false;
  const envMax = env.MUSE_WEB_SEARCH_MAX_USES;
  if (envMax !== undefined) {
    const n = Number.parseInt(envMax, 10);
    if (Number.isFinite(n) && n > 0) maxUses = n;
  }
  return { enabled, maxUses };
}

export { KyselyRuntimeSettingsStore } from "./kysely-store.js";
export type { KyselyRuntimeSettingsStoreOptions } from "./kysely-store.js";
