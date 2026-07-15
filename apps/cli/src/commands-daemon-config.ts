import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** `muse setup briefing`'s config — the daemon-config-extension idiom (AC1): read LIVE each tick, no restart needed. */
export interface DailyBriefConfig {
  readonly enabled: boolean;
  /** Local "HH:MM", 24-hour — see `parseDailyBriefTime` in daily-brief.ts. */
  readonly time: string;
}

export interface DaemonConfig {
  readonly provider?: string;
  readonly destination?: string;
  readonly dailyBrief?: DailyBriefConfig;
}

export function resolveDaemonConfigFile(env: NodeJS.ProcessEnv): string {
  const explicit = env.MUSE_DAEMON_CONFIG_FILE?.trim();
  if (explicit && explicit.length > 0) return explicit;
  const home = env.HOME?.trim()?.length ? env.HOME.trim() : homedir();
  return join(home, ".config", "muse", "daemon.json");
}

// Tolerant: a missing / malformed config file yields no defaults
// (the daemon still runs from flags + env), never throws.
export function readDaemonConfig(file: string): DaemonConfig {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const config: { provider?: string; destination?: string; dailyBrief?: DailyBriefConfig } = {};
    if (typeof parsed.provider === "string") config.provider = parsed.provider;
    if (typeof parsed.destination === "string") config.destination = parsed.destination;
    const db = parsed.dailyBrief;
    if (db && typeof db === "object") {
      const record = db as Record<string, unknown>;
      if (typeof record.time === "string" && record.time.trim().length > 0) {
        config.dailyBrief = { enabled: record.enabled === true, time: record.time.trim() };
      }
    }
    return config;
  } catch {
    return {};
  }
}

export function writeDaemonConfig(file: string, config: DaemonConfig): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
