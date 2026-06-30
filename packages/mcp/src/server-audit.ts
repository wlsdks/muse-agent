/**
 * Static security audit for external MCP stdio servers.
 *
 * Muse already gates external MCP servers by NAME ALLOWLIST
 * (`McpSecurityPolicyProvider.isServerAllowed`) and pins binary
 * hashes (`verifyServerFingerprint`), but neither inspects WHAT an
 * allowed server will actually run. A stdio MCP server launches a
 * local COMMAND with args + env; a compromised or hostile config can
 * smuggle arbitrary code execution through that launch line even when
 * the command basename is a blessed runner. This module is the
 * pre-connect static scanner that closes that gap: a pure,
 * deterministic, fail-close vet of command + args + env.
 *
 * It is deterministic code, not a model prompt — security in Muse is
 * never a please-be-careful instruction (CLAUDE.md non-negotiable).
 *
 * Pattern (NOT copied code) is the convergence of two prior-art
 * static auditors, credited here:
 *   - openclaw `src/security/audit.ts` (MIT) — static config audit
 *     before launching an untrusted server.
 *   - hermes `tools/osv_check.py` + `skills_ast_audit.py` (Apache-2.0)
 *     — static pattern/AST vetting of third-party capabilities.
 * Muse's variant is a self-contained regex/string scanner with no
 * network and no subprocess (an OSV feed and a tool-AST pass are the
 * obvious next layers, deliberately out of scope here).
 */

import type { JsonObject, JsonValue } from "@muse/shared";

import type { McpTransportType } from "./index.js";

export interface McpServerAuditTarget {
  readonly transportType: McpTransportType;
  readonly config?: JsonObject;
}

export interface McpServerAuditResult {
  readonly safe: boolean;
  readonly reasons: readonly string[];
}

// curl/wget/fetch piped into an interpreter — the canonical
// download-and-execute one-liner.
const DOWNLOAD_EXEC =
  /\b(?:curl|wget|fetch)\b[\s\S]*?\|\s*(?:sh|bash|zsh|dash|ksh|fish|python3?|perl|ruby|node)\b/iu;

// base64/xxd/openssl decode piped into a shell — obfuscated payload.
const DECODE_EXEC =
  /\b(?:base64|xxd|openssl)\b[\s\S]*?(?:-d|--decode|enc\s+-d)[\s\S]*?\|\s*(?:sh|bash|zsh|dash)\b/iu;

// echo/printf a payload straight into a shell.
const ECHO_PIPE_SH = /\b(?:echo|printf)\b[\s\S]*?\|\s*(?:sh|bash|zsh|dash)\b/iu;

// reverse shells: /dev/tcp redirection or netcat -e.
const REVERSE_SHELL = /\/dev\/tcp\/|\bn(?:c|cat)\b[\s\S]*?\s-[a-z]*e\b/iu;

// inline-code that spawns a subprocess (node -e, python -c, …).
const INLINE_EXEC =
  /child_process|os\.system|subprocess\.(?:Popen|call|run|check_output)|Runtime\.getRuntime|\bexecSync\b|\bspawnSync\b|popen\s*\(/iu;

// Script interpreters that, given an INLINE-CODE flag (`-e`/`-c`/`--eval`/`--exec`), run arbitrary
// code rather than a script/module. A real MCP server runs a script or a module (`-m`), never inline
// code, so `python3 -c '…'` / `perl -e '…'` / `ruby -e '…'` / `node -e '…'` is a code-injection launch
// line whatever the body says. `-m` (module) is NOT in the flag set, so `python -m mcp_server` is safe.
const SCRIPT_INTERPRETERS = new Set(["python", "python3", "perl", "ruby", "node", "nodejs", "deno", "bun", "php", "lua"]);
const INLINE_CODE_FLAG = /^(?:-[ce]|--eval|--exec)$/iu;

// $(...) or `...` command substitution.
const CMD_SUBST = /\$\([^)]*\)|`[^`]*`/u;

// Shell control metacharacters that have NO place in a plain package
// spec / flag / value. A lone `&` is deliberately omitted — URL query
// strings legitimately contain it and an argv element is not re-parsed
// by a shell, so flagging `&` would false-block normal servers. `;`,
// pipes, `&&`/`||`, substitution, and redirects ARE flagged: a legit
// `npx @scope/pkg --port 3000` / `uvx mcp-server-git` never contains
// any of them.
const SHELL_META = /[;`]|\$\(|&&|\|\||\||>>?|(?:^|\s)<|\r|\n/u;

const SHELL_NAMES = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh"]);

/**
 * Pure static audit of a stdio MCP server's launch configuration.
 * Returns `{ safe, reasons }`; `safe === false` ⇒ the caller MUST NOT
 * connect (fail-close). Non-stdio transports carry no command line, so
 * they are out of scope here (their URLs are vetted by the SSRF
 * validators) and pass. No network, no subprocess, no filesystem.
 */
export function auditMcpServerConfig(target: McpServerAuditTarget): McpServerAuditResult {
  if (target.transportType !== "stdio") {
    return { safe: true, reasons: [] };
  }

  const config = target.config ?? {};
  const command = typeof config.command === "string" ? config.command : "";
  const args = readStringArray(config.args);
  const env = readEnv(config.env);
  const reasons: string[] = [];

  // Unwrap one `env` layer first: `env [NAME=VALUE]... python3 -c '…'` hides the real interpreter
  // (and its inline-code flag) behind `env`, which would bypass the commandBase checks below.
  const { command: effectiveCommand, args: effectiveArgs } = unwrapEnvWrapper(command, args);
  const commandBase = basename(effectiveCommand);

  const pathReason = suspiciousCommandPath(effectiveCommand);
  if (pathReason) reasons.push(pathReason);

  // A shell wrapper (`sh -c "<body>"`) whose body is a known
  // exec/exfil pattern. The generic per-arg sweep below also catches
  // the body, but naming the shell wrapper explicitly makes the
  // refusal legible.
  if (SHELL_NAMES.has(commandBase) && effectiveArgs.some((arg) => /^-[a-z]*c$/iu.test(arg))) {
    const body = effectiveArgs.filter((arg) => !arg.startsWith("-")).join(" ");
    const bodyReason = dangerousText(body);
    if (bodyReason) {
      reasons.push(`shell wrapper "${commandBase} -c" ${bodyReason}`);
    }
  }

  // A script interpreter launched with an inline-code flag is a code-injection launch line,
  // whatever the body says (a real MCP server runs a script/module, never `-c`/`-e`/`--eval`).
  if (SCRIPT_INTERPRETERS.has(commandBase) && effectiveArgs.some((arg) => INLINE_CODE_FLAG.test(arg))) {
    reasons.push(`runs interpreter "${commandBase}" with an inline-code flag (-c/-e/--eval) — an MCP server runs a script or module, not inline code`);
  }

  for (const arg of args) {
    const dangerous = dangerousText(arg);
    if (dangerous) {
      reasons.push(`arg ${dangerous}`);
    } else if (SHELL_META.test(arg)) {
      reasons.push(`arg contains a shell control metacharacter (;, |, &&, $(), backtick, or redirect): ${truncate(arg)}`);
    }
  }

  for (const { key, value } of env) {
    const dangerous = dangerousText(value);
    if (dangerous) {
      reasons.push(`env ${key} ${dangerous}`);
    }
  }

  return { safe: reasons.length === 0, reasons: dedupe(reasons) };
}

function dangerousText(text: string): string | undefined {
  if (DOWNLOAD_EXEC.test(text)) return "downloads and pipes to a shell (e.g. curl … | sh)";
  if (DECODE_EXEC.test(text)) return "decodes and pipes to a shell (e.g. base64 -d | sh)";
  if (ECHO_PIPE_SH.test(text)) return "echoes/printfs straight into a shell";
  if (REVERSE_SHELL.test(text)) return "opens a reverse shell (/dev/tcp or nc -e)";
  if (INLINE_EXEC.test(text)) return "spawns a subprocess from inline code (child_process/os.system/subprocess)";
  if (CMD_SUBST.test(text)) return "contains a shell command substitution ($(…) or backticks)";
  return undefined;
}

/**
 * Flag a command that runs from a world-writable temp dir or a hidden
 * stash dir rather than a system/toolchain location. A bare command
 * name (no `/`) carries no path signal — its identity is the
 * allowlist's job — so it passes here.
 */
// `env [opts] [NAME=VALUE]... CMD [ARG]...` runs CMD, so a launch line can hide the real interpreter
// (and its inline-code flag) behind `env` — `env python3 -c '…'` would otherwise pass the
// commandBase checks. Unwrap ONE env layer to the real command: an option taking a value
// (-u/-C/-S/-P) consumes the next token; bare flags and NAME=VALUE assignments are skipped; the first
// remaining token is the real command. Not env ⇒ returned unchanged.
function unwrapEnvWrapper(command: string, args: readonly string[]): { command: string; args: readonly string[] } {
  if (basename(command) !== "env") return { command, args };
  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (a === "--") { i += 1; break; }
    if (a === "-u" || a === "-C" || a === "-S" || a === "-P") { i += 2; continue; }
    if (a.startsWith("-")) { i += 1; continue; }
    if (/^[A-Za-z_]\w*=/u.test(a)) { i += 1; continue; }
    break;
  }
  if (i >= args.length) return { command, args };
  return { command: args[i]!, args: args.slice(i + 1) };
}

function suspiciousCommandPath(command: string): string | undefined {
  const norm = command.replace(/\\/gu, "/");
  if (!norm.includes("/")) return undefined;

  // ONLY a world-writable temp dir is flagged — that is the real plant-and-run vector (an attacker
  // who can write there can drop a binary). A HIDDEN dir under the user's own home is NOT flagged:
  // node_modules/.bin/<server>, ~/.config/<app>/server, .vscode/extensions/.../server, .venv/bin/…
  // are all normal, recommended MCP install locations the user controls — blocking them breaks
  // legitimate project-local servers (the worse failure for a security gate), with no real gain
  // since the user already owns those paths.
  if (/^(?:\/private)?\/tmp\//u.test(norm) || /^\/var\/tmp\//u.test(norm) || /^\/dev\/shm\//u.test(norm)) {
    return `command runs from a world-writable temp directory: ${truncate(command)}`;
  }

  return undefined;
}

function basename(command: string): string {
  const norm = command.replace(/\\/gu, "/");
  return norm.slice(norm.lastIndexOf("/") + 1);
}

function readStringArray(value: JsonValue | undefined): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function readEnv(value: JsonValue | undefined): readonly { key: string; value: string }[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, val]) => ({ key, value: val }));
}

function truncate(text: string): string {
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

function dedupe(reasons: readonly string[]): readonly string[] {
  return [...new Set(reasons)];
}
