import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface DaemonConfig {
  readonly provider?: string;
  readonly destination?: string;
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
    const config: { provider?: string; destination?: string } = {};
    if (typeof parsed.provider === "string") config.provider = parsed.provider;
    if (typeof parsed.destination === "string") config.destination = parsed.destination;
    return config;
  } catch {
    return {};
  }
}

export function writeDaemonConfig(file: string, config: DaemonConfig): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
