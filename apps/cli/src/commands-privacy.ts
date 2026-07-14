/**
 * `muse privacy` — the "it can't tell anyone" half of Muse's identity made
 * VISIBLE: a read-only inventory of every personal store at rest, showing which
 * are ENCRYPTED vs PLAINTEXT and whether the encryption key is the strong
 * explicit `MUSE_MEMORY_KEY` or the DERIVABLE per-host fallback. `muse doctor`
 * reports the cloud-egress (local-only) posture; this reports the at-rest
 * encryption posture — the discretion the other half of the contract depends on.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  resolveActionLogFile,
  resolveContactsFile,
  resolveEpisodesFile,
  resolveNotesDir,
  resolvePlaybookFile,
  resolveReflectionsFile,
  resolveRemindersFile,
  resolveTasksFile
} from "@muse/autoconfigure";
import { isFileEncryptedAtRest } from "@muse/stores";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

type Env = Record<string, string | undefined>;

export interface PrivacyStore {
  readonly name: string;
  readonly path: string;
  readonly exists: boolean;
  readonly encryptable: boolean;
  readonly encrypted: boolean;
  /** The command to encrypt this store, when it is encryptable but still plaintext. */
  readonly encryptCommand?: string;
}

export interface PrivacyPosture {
  readonly stores: readonly PrivacyStore[];
  /** True when `MUSE_MEMORY_KEY` is set (a strong explicit key); false = derivable per-host fallback. */
  readonly explicitKey: boolean;
  readonly anyEncrypted: boolean;
}

export interface PrivacyPostureRuntime {
  readonly homeDir?: string;
  readonly userMemoryFile?: string;
}

function memoryFile(env: Env, runtime: PrivacyPostureRuntime = {}): string {
  const explicit = runtime.userMemoryFile?.trim();
  if (explicit && explicit.length > 0) return explicit;
  const configured = env.MUSE_USER_MEMORY_FILE?.trim();
  if (configured && configured.length > 0) return configured;
  const runtimeHome = runtime.homeDir?.trim();
  if (runtimeHome && runtimeHome.length > 0) return join(runtimeHome, ".muse", "user-memory.json");
  const envHome = env.HOME?.trim();
  if (envHome && envHome.length > 0) return join(envHome, ".muse", "user-memory.json");
  return join(homedir(), ".muse", "user-memory.json");
}

function storeDefs(env: Env, runtime: PrivacyPostureRuntime = {}): readonly { name: string; path: string; encryptable: boolean; encryptCommand?: string }[] {
  return [
    { encryptCommand: "muse memory encrypt", encryptable: true, name: "user-memory", path: memoryFile(env, runtime) },
    { encryptCommand: "muse episode encrypt", encryptable: true, name: "episodes", path: resolveEpisodesFile(env) },
    { encryptCommand: "muse actions encrypt", encryptable: true, name: "action-log", path: resolveActionLogFile(env) },
    { encryptCommand: "muse contacts encrypt", encryptable: true, name: "contacts", path: resolveContactsFile(env) },
    { encryptCommand: "muse playbook encrypt", encryptable: true, name: "playbook", path: resolvePlaybookFile(env) },
    { encryptCommand: "muse reflections encrypt", encryptable: true, name: "reflections", path: resolveReflectionsFile(env) },
    { encryptable: false, name: "tasks", path: resolveTasksFile(env) },
    { encryptable: false, name: "reminders", path: resolveRemindersFile(env) },
    { encryptable: false, name: "notes", path: resolveNotesDir(env) }
  ];
}

/**
 * Read-only inventory of every personal store at rest + the key posture. An
 * encryptable store is checked with `isFileEncryptedAtRest` (the same envelope
 * sniff the per-store encrypt commands use); a missing file is reported as
 * not-created (never a false "plaintext"). No decryption, no key needed.
 */
export async function collectPrivacyPosture(env: Env, runtime: PrivacyPostureRuntime = {}): Promise<PrivacyPosture> {
  const stores = await Promise.all(storeDefs(env, runtime).map(async (def) => {
    const exists = existsSync(def.path);
    const encrypted = exists && def.encryptable ? await isFileEncryptedAtRest(def.path).catch(() => false) : false;
    return {
      encryptable: def.encryptable,
      encrypted,
      exists,
      name: def.name,
      path: def.path,
      ...(def.encryptCommand ? { encryptCommand: def.encryptCommand } : {})
    };
  }));
  return { anyEncrypted: stores.some((store) => store.encrypted), explicitKey: Boolean(env.MUSE_MEMORY_KEY?.trim()), stores };
}

/** Human-readable privacy report. Pure. */
export function formatPrivacyPosture(posture: PrivacyPosture): string {
  const lines: string[] = ["🔒 Privacy posture — your confided data at rest:", ""];
  for (const store of posture.stores) {
    const label = store.name.padEnd(12);
    if (!store.encryptable) {
      lines.push(`  ▫️  ${label} — plaintext (not yet encryptable)`);
    } else if (!store.exists) {
      lines.push(`  ·   ${label} — not created yet`);
    } else if (store.encrypted) {
      lines.push(`  ✅ ${label} — encrypted at rest`);
    } else {
      lines.push(`  ⚠️  ${label} — PLAINTEXT — run \`${store.encryptCommand ?? ""}\``);
    }
  }
  lines.push("");
  if (posture.anyEncrypted) {
    lines.push(posture.explicitKey
      ? "Key: ✅ explicit MUSE_MEMORY_KEY — a strong secret."
      : "Key: ⚠️  DERIVABLE per-host fallback (muse-memory + your username / home / hostname) — anyone who can recompute that could decrypt these stores. Set MUSE_MEMORY_KEY to a strong secret for real protection.");
  } else {
    lines.push("Nothing is encrypted yet — run the `… encrypt` command on any store above to protect it at rest (set MUSE_MEMORY_KEY first for a strong key).");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The at-rest encryption posture as a `muse doctor` health check — so the
 * "it can't tell anyone" discretion gap surfaces in the STANDARD health command,
 * not only the dedicated `muse privacy`. Warns when any existing sensitive store
 * is plaintext OR when encrypted stores rely on the derivable per-host key. Pure.
 */
export function atRestDoctorCheck(posture: PrivacyPosture): { readonly name: string; readonly status: "ok" | "warn" | "fail"; readonly detail: string } {
  const name = "at-rest encryption";
  const encryptable = posture.stores.filter((store) => store.encryptable && store.exists);
  const plaintext = encryptable.filter((store) => !store.encrypted);
  if (encryptable.length === 0) {
    return { detail: "no sensitive stores created yet (nothing to encrypt)", name, status: "ok" };
  }
  if (plaintext.length > 0) {
    return { detail: `${plaintext.length.toString()}/${encryptable.length.toString()} sensitive store(s) PLAINTEXT (${plaintext.map((store) => store.name).join(", ")}) — run \`muse privacy\``, name, status: "warn" };
  }
  if (!posture.explicitKey) {
    return { detail: `all ${encryptable.length.toString()} encrypted but under the DERIVABLE per-host key — set MUSE_MEMORY_KEY (see \`muse privacy\`)`, name, status: "warn" };
  }
  return { detail: `all ${encryptable.length.toString()} sensitive store(s) encrypted with a strong MUSE_MEMORY_KEY`, name, status: "ok" };
}

export function registerPrivacyCommand(program: Command, io: ProgramIO): void {
  program
    .command("privacy")
    .description("Inventory your confided data at rest — which personal stores are encrypted vs plaintext, and whether the key is strong (read-only)")
    .option("--json", "Emit the posture as JSON")
    .action(async (options: { readonly json?: boolean }) => {
      const posture = await collectPrivacyPosture(process.env);
      if (options.json) {
        io.stdout(`${JSON.stringify(posture, null, 2)}\n`);
        return;
      }
      io.stdout(formatPrivacyPosture(posture));
    });
}
