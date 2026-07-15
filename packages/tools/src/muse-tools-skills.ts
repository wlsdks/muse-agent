/**
 * Skill tools — `muse.skills.list`, `muse.skills.read`, `muse.skills.run`.
 *
 * `list` and `read` are pure metadata lookups against the
 * `SkillCatalog` (small struct) so they cost almost nothing. `run`
 * shells out via `node:child_process.spawn` but only against the
 * skill's declared `requires.bins` allowlist — the agent can't
 * inject arbitrary commands, only invocations of binaries the
 * skill author has pre-approved.
 *
 * `run` enforces:
 *   - 60s default timeout (overridable up to 10 minutes)
 *   - kill on timeout, surface partial output
 *   - declared-binary check — first token of `command` must be in
 *     the skill's `requires.bins` (or `requires.anyBins`)
 *   - stdout + stderr are length-capped at 16KB per stream
 */

import { spawn } from "node:child_process";

import { redactSecretsInText, runCommandWithTimeout, type JsonObject } from "@muse/shared";

import type { MuseTool } from "./index.js";
import { readOptionalNumber, readOptionalString } from "./muse-tools-helpers.js";

function readRequiredString(args: JsonObject, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`missing required string field: ${key}`);
  }
  return value;
}

export interface SkillCatalogToolEntry {
  readonly name: string;
  readonly description: string;
  readonly emoji?: string;
  readonly body: string;
  readonly requiresBins?: readonly string[];
  readonly requiresAnyBins?: readonly string[];
}

export interface SkillRegistryView {
  list(): readonly SkillCatalogToolEntry[];
  get(name: string): SkillCatalogToolEntry | undefined;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
const MAX_STREAM_CHARS = 16_384;
// UTF-8 encodes one code point in at most 4 bytes, so capping raw
// accumulation at 4x the char limit guarantees enough bytes survive to
// decode a full MAX_STREAM_CHARS string without cutting a multi-byte
// sequence mid-character at the truncation boundary. The final string
// returned to the caller is still truncated to MAX_STREAM_CHARS below.
const MAX_STREAM_BYTES = MAX_STREAM_CHARS * 4;

export function createSkillListTool(registry: SkillRegistryView): MuseTool {
  return {
    definition: {
      description:
        "List the SKILL.md catalog. Returns each skill's name, description, emoji, " +
        "and required binaries. Read the full body via muse.skills.read before invoking.",
      domain: "core",
      inputSchema: { additionalProperties: false, properties: {}, type: "object" },
      name: "muse.skills.list",
      risk: "read"
    },
    execute: (): JsonObject => ({
      skills: registry.list().map((skill) => ({
        ...(skill.emoji ? { emoji: skill.emoji } : {}),
        description: skill.description,
        name: skill.name,
        ...(skill.requiresBins ? { requiresBins: [...skill.requiresBins] } : {}),
        ...(skill.requiresAnyBins ? { requiresAnyBins: [...skill.requiresAnyBins] } : {})
      }))
    })
  };
}

export function createSkillReadTool(registry: SkillRegistryView): MuseTool {
  return {
    definition: {
      description:
        "Read a single SKILL.md's full markdown body. Use this before muse.skills.run " +
        "to learn the correct invocation flags, environment variables, and usage patterns.",
      domain: "core",
      inputSchema: {
        additionalProperties: false,
        properties: {
          name: { description: "Skill name as listed by muse.skills.list", type: "string" }
        },
        required: ["name"],
        type: "object"
      },
      name: "muse.skills.read",
      risk: "read"
    },
    execute: (args): JsonObject => {
      const name = readRequiredString(args, "name");
      const skill = registry.get(name);
      if (!skill) {
        return { error: `skill not found: ${name}` };
      }
      return {
        body: skill.body,
        description: skill.description,
        ...(skill.emoji ? { emoji: skill.emoji } : {}),
        name: skill.name,
        ...(skill.requiresBins ? { requiresBins: [...skill.requiresBins] } : {}),
        ...(skill.requiresAnyBins ? { requiresAnyBins: [...skill.requiresAnyBins] } : {})
      };
    }
  };
}

export interface SkillRunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly spawnImpl?: typeof spawn;
}

export function createSkillRunTool(registry: SkillRegistryView, options: SkillRunOptions = {}): MuseTool {
  const spawnImpl = options.spawnImpl ?? spawn;
  return {
    definition: {
      description:
        "Run a binary the named skill has declared in `requires.bins` (or `requires.anyBins`). " +
        "The first token of `command` is checked against the allowlist; everything else " +
        "passes through as arguments. Capped at 10-minute timeout, 16KB per stream.",
      domain: "core",
      inputSchema: {
        additionalProperties: false,
        properties: {
          command: {
            description: "Full command string. First token must be an allowed binary.",
            type: "string"
          },
          name: { description: "Skill name as listed by muse.skills.list", type: "string" },
          stdin: { description: "Optional stdin payload.", type: "string" },
          timeoutMs: { description: "Per-invocation timeout in ms (default 60000, max 600000).", type: "number" }
        },
        required: ["name", "command"],
        type: "object"
      },
      name: "muse.skills.run",
      risk: "execute"
    },
    execute: async (args): Promise<JsonObject> => {
      const nameRaw = args["name"];
      const commandRaw = args["command"];
      if (typeof nameRaw !== "string" || nameRaw.trim().length === 0) {
        return { error: "name must be a non-empty string" };
      }
      if (typeof commandRaw !== "string" || commandRaw.trim().length === 0) {
        return { error: "command must not be empty" };
      }
      const name = nameRaw;
      const command = commandRaw;
      const skill = registry.get(name);
      if (!skill) {
        return { error: `skill not found: ${name}` };
      }
      const allowlist = collectAllowlist(skill);
      if (allowlist.size === 0) {
        return { error: `skill ${name} declares no requires.bins / requires.anyBins, refusing to run` };
      }
      const trimmed = command.trim();
      const tokens = parseShellTokens(trimmed);
      const first = tokens[0];
      if (!first || !allowlist.has(first)) {
        return {
          allowedBins: [...allowlist],
          error: `command does not start with an allowed binary: ${first ?? "(empty)"}`
        };
      }
      const timeoutMs = clampTimeout(readOptionalNumber(args, "timeoutMs"));
      const stdin = readOptionalString(args, "stdin");
      try {
        const result = await runChild(spawnImpl, first, tokens.slice(1), {
          cwd: options.cwd,
          env: options.env,
          stdin,
          timeoutMs
        });
        // Skill subprocess output is untrusted and can echo a secret (an env
        // dump, a config print) — mask before it enters the model context.
        return {
          exitCode: result.exitCode,
          ...(result.signal ? { signal: result.signal } : {}),
          stderr: redactSecretsInText(result.stderr),
          stdout: redactSecretsInText(result.stdout),
          timedOut: result.timedOut
        };
      } catch (cause) {
        return { error: cause instanceof Error ? cause.message : String(cause) };
      }
    }
  };
}

function collectAllowlist(skill: SkillCatalogToolEntry): Set<string> {
  const set = new Set<string>();
  for (const bin of skill.requiresBins ?? []) {
    if (typeof bin === "string" && bin.length > 0) set.add(bin);
  }
  for (const bin of skill.requiresAnyBins ?? []) {
    if (typeof bin === "string" && bin.length > 0) set.add(bin);
  }
  return set;
}

function clampTimeout(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(MAX_TIMEOUT_MS, Math.trunc(raw));
}

/**
 * Tiny shell tokenizer — splits on whitespace but respects single
 * and double quotes. Enough for the typical `binary arg1 "arg with
 * spaces"` invocations a skill produces; not a full POSIX shell.
 */
function parseShellTokens(input: string): readonly string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) {
        quote = undefined;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/u.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

interface RunChildResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
}

interface RunChildOptions {
  readonly stdin?: string;
  readonly timeoutMs: number;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

function runChild(
  spawnFn: typeof spawn,
  bin: string,
  args: readonly string[],
  options: RunChildOptions
): Promise<RunChildResult> {
  return (async (): Promise<RunChildResult> => {
    const result = await runCommandWithTimeout({
    command: bin,
    args: [...args],
    stdin: options.stdin,
    timeoutMs: options.timeoutMs,
    spawnImpl: spawnFn,
    maxStdoutBytes: MAX_STREAM_BYTES,
    maxStderrBytes: MAX_STREAM_BYTES,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {})
    });
    return {
      exitCode: result.exitCode,
      signal: result.signal,
      stderr: decodeCapped(result.stderr),
      stdout: decodeCapped(result.stdout),
      timedOut: result.timedOut
    };
  })();
}

function decodeCapped(value: string): string {
  return value.length > MAX_STREAM_CHARS ? `${value.slice(0, MAX_STREAM_CHARS)}\n…[truncated]` : value;
}
