/**
 * `muse trust` — per-user tool trust list.
 *
 * Skills trust calibration is what stops JARVIS from accidentally
 * launching the suit when you say "turn on the lights". Muse tools
 * already carry a `risk` annotation; this CLI layers a per-user
 * trust list on top:
 *
 *   trusted   tool may run without confirmation
 *   blocked   tool must never run
 *   (default) tool runs after the agent runtime's existing risk
 *             gates (today: a no-op; future iteration wires it into
 *             the tool exposure policy)
 *
 * Stored at `~/.muse/trust.json` keyed by userId (or
 * `<user>@<persona>` if the user passed --persona).
 *
 * The list IS the surface today — tool registry consumption is a
 * follow-up. Even without runtime integration, surfacing the
 * trust list lets the user audit what would be auto-trusted before
 * the agent wires it.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

interface TrustEntry {
  readonly trustedTools: string[];
  readonly blockedTools: string[];
}

interface TrustFile {
  readonly version: 1;
  readonly users: Record<string, TrustEntry>;
}

function trustPath(): string {
  return process.env.MUSE_TRUST_FILE?.trim() ?? join(homedir(), ".muse", "trust.json");
}

function emptyFile(): TrustFile {
  return { users: {}, version: 1 };
}

async function readTrustFile(path: string): Promise<TrustFile> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as TrustFile;
    if (parsed && parsed.version === 1 && parsed.users) {
      return parsed;
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  return emptyFile();
}

async function writeTrustFile(path: string, data: TrustFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

function defaultUserKey(persona: string | undefined): string {
  const base = process.env.MUSE_USER_ID ?? process.env.USER ?? "default";
  return persona && persona.length > 0 ? `${base}@${persona}` : base;
}

function entryFor(file: TrustFile, key: string): TrustEntry {
  return file.users[key] ?? { blockedTools: [], trustedTools: [] };
}

async function mutate(
  key: string,
  patch: (entry: TrustEntry) => TrustEntry
): Promise<TrustEntry> {
  const path = trustPath();
  const file = await readTrustFile(path);
  const next = { ...file, users: { ...file.users, [key]: patch(entryFor(file, key)) } };
  await writeTrustFile(path, next);
  return next.users[key]!;
}

function uniqInsert(list: readonly string[], value: string): string[] {
  return list.includes(value) ? [...list] : [...list, value];
}

function withoutValue(list: readonly string[], value: string): string[] {
  return list.filter((v) => v !== value);
}

/**
 * Goal 053 — split each tool name on the first '.' and group by
 * the prefix so the user sees "I trust 3 tools from notion + 1
 * from gcal" instead of a flat alphabetised list. A tool name
 * without a dot lands in an `(unscoped)` bucket so it stays
 * visible. Exported for direct unit-test coverage.
 */
export function groupToolsByDomain(tools: readonly string[]): Record<string, readonly string[]> {
  const grouped: Record<string, string[]> = {};
  for (const tool of tools) {
    const dot = tool.indexOf(".");
    const domain = dot > 0 ? tool.slice(0, dot) : "(unscoped)";
    const bucket = grouped[domain] ?? [];
    bucket.push(tool);
    grouped[domain] = bucket;
  }
  return grouped;
}

export function registerTrustCommands(program: Command, io: ProgramIO): void {
  const trust = program.command("trust").description("Per-user tool trust list (skills trust calibration)");

  trust
    .command("list")
    .description("Show trusted + blocked tools for a user")
    .option("--user <id>", "User identity (default: $MUSE_USER_ID or $USER)")
    .option("--persona <slot>", "Persona slot")
    .option("--json", "Print machine-readable JSON")
    .option("--by-domain", "Group entries by MCP server domain (the tool-name prefix before the first '.') (goal 053)")
    .action(async (options: { readonly user?: string; readonly persona?: string; readonly json?: boolean; readonly byDomain?: boolean }) => {
      const key = options.user
        ? (options.persona ? `${options.user}@${options.persona}` : options.user)
        : defaultUserKey(options.persona);
      const file = await readTrustFile(trustPath());
      const entry = entryFor(file, key);
      const byDomain = options.byDomain
        ? { trusted: groupToolsByDomain(entry.trustedTools), blocked: groupToolsByDomain(entry.blockedTools) }
        : undefined;
      if (options.json) {
        io.stdout(`${JSON.stringify({ key, ...entry, ...(byDomain ? { byDomain } : {}) }, null, 2)}\n`);
        return;
      }
      io.stdout(`Trust for ${key}:\n`);
      if (byDomain) {
        const renderGroup = (label: string, glyph: string, grouped: ReturnType<typeof groupToolsByDomain>): void => {
          const domains = Object.keys(grouped).sort();
          const total = domains.reduce((sum, d) => sum + grouped[d]!.length, 0);
          io.stdout(`  ${label} (${total.toString()} across ${domains.length.toString()} domain${domains.length === 1 ? "" : "s"}):\n`);
          if (total === 0) io.stdout(`    (none)\n`);
          for (const domain of domains) {
            const tools = grouped[domain]!.slice().sort();
            io.stdout(`    [${domain}] ${tools.length.toString()}\n`);
            for (const tool of tools) io.stdout(`      ${glyph} ${tool}\n`);
          }
        };
        renderGroup("trusted", "+", byDomain.trusted);
        renderGroup("blocked", "×", byDomain.blocked);
        return;
      }
      io.stdout(`  trusted (${entry.trustedTools.length.toString()}):\n`);
      for (const tool of entry.trustedTools.sort()) io.stdout(`    + ${tool}\n`);
      if (entry.trustedTools.length === 0) io.stdout(`    (none)\n`);
      io.stdout(`  blocked (${entry.blockedTools.length.toString()}):\n`);
      for (const tool of entry.blockedTools.sort()) io.stdout(`    × ${tool}\n`);
      if (entry.blockedTools.length === 0) io.stdout(`    (none)\n`);
    });

  trust
    .command("grant")
    .description("Add a tool to the trusted list — agent will run it without per-call confirmation")
    .argument("<tool>", "Tool name (e.g. muse.tasks.add)")
    .option("--user <id>", "User identity")
    .option("--persona <slot>", "Persona slot")
    .action(async (tool: string, options: { readonly user?: string; readonly persona?: string }) => {
      const key = options.user
        ? (options.persona ? `${options.user}@${options.persona}` : options.user)
        : defaultUserKey(options.persona);
      const entry = await mutate(key, (e) => ({
        blockedTools: withoutValue(e.blockedTools, tool),
        trustedTools: uniqInsert(e.trustedTools, tool)
      }));
      io.stdout(`Granted '${tool}' for ${key} (now ${entry.trustedTools.length.toString()} trusted)\n`);
    });

  trust
    .command("revoke")
    .description("Remove a tool from the trusted list — drops to default risk gate")
    .argument("<tool>", "Tool name")
    .option("--user <id>", "User identity")
    .option("--persona <slot>", "Persona slot")
    .action(async (tool: string, options: { readonly user?: string; readonly persona?: string }) => {
      const key = options.user
        ? (options.persona ? `${options.user}@${options.persona}` : options.user)
        : defaultUserKey(options.persona);
      const entry = await mutate(key, (e) => ({
        blockedTools: [...e.blockedTools],
        trustedTools: withoutValue(e.trustedTools, tool)
      }));
      io.stdout(`Revoked '${tool}' for ${key} (now ${entry.trustedTools.length.toString()} trusted)\n`);
    });

  trust
    .command("block")
    .description("Add a tool to the blocked list — agent must never run it for this user")
    .argument("<tool>", "Tool name")
    .option("--user <id>", "User identity")
    .option("--persona <slot>", "Persona slot")
    .action(async (tool: string, options: { readonly user?: string; readonly persona?: string }) => {
      const key = options.user
        ? (options.persona ? `${options.user}@${options.persona}` : options.user)
        : defaultUserKey(options.persona);
      const entry = await mutate(key, (e) => ({
        blockedTools: uniqInsert(e.blockedTools, tool),
        trustedTools: withoutValue(e.trustedTools, tool)
      }));
      io.stdout(`Blocked '${tool}' for ${key} (now ${entry.blockedTools.length.toString()} blocked)\n`);
    });

  trust
    .command("unblock")
    .description("Remove a tool from the blocked list")
    .argument("<tool>", "Tool name")
    .option("--user <id>", "User identity")
    .option("--persona <slot>", "Persona slot")
    .action(async (tool: string, options: { readonly user?: string; readonly persona?: string }) => {
      const key = options.user
        ? (options.persona ? `${options.user}@${options.persona}` : options.user)
        : defaultUserKey(options.persona);
      const entry = await mutate(key, (e) => ({
        blockedTools: withoutValue(e.blockedTools, tool),
        trustedTools: [...e.trustedTools]
      }));
      io.stdout(`Unblocked '${tool}' for ${key} (now ${entry.blockedTools.length.toString()} blocked)\n`);
    });
}

/**
 * Read the trust list for a userKey. Future iterations of the agent
 * runtime can call this to gate tool calls. Today it's exposed for
 * `muse status` and similar surfaces.
 */
export async function readTrust(userKey: string): Promise<TrustEntry> {
  const file = await readTrustFile(trustPath());
  return entryFor(file, userKey);
}
