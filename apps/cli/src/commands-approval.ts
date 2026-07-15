/**
 * `muse approval list / approve / deny` — pending approval audit
 * trail. Advisory v1: not yet wired into the agent's runtime gate
 * (that's a deeper change), but the surface lets the user
 *
 *   - log a tool / action the agent wants to take but isn't yet
 *     trusted to run (file-backed at ~/.muse/pending-approvals.jsonl)
 *   - review pending entries and decide
 *   - approve → add the tool to the user's trust list (via
 *     `muse trust grant`), so subsequent runs skip the gate
 *
 * The agent integration is a separate iteration — when the runtime
 * encounters a "borderline" tool (today: anything not in
 * trust.trustedTools and not in trust.blockedTools, with
 * risk:"execute"), it will append a pending request and either
 * block / continue based on a per-user policy. Today the CLI
 * surface lets the user pre-populate that intent — e.g. after
 * reviewing notifications they can `muse approval approve mail.send`
 * which calls trust.grant.
 */

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { Command } from "commander";
import { isRecord } from "@muse/shared";

import { closestCommandName } from "./closest-command.js";
import { firstNonEmpty, resolvePersona } from "./program-helpers.js";
import type { ProgramIO } from "./program.js";
import { resolveDefaultUserKey } from "./user-id.js";

interface PendingRequest {
  readonly id: string;
  readonly toolName: string;
  readonly userKey: string;
  readonly askedAtIso: string;
  readonly reason?: string;
  readonly status: "pending" | "approved" | "denied" | "expired";
  readonly decidedAtIso?: string;
  readonly decidedBy?: string;
}
const APPROVAL_STATUSES = ["pending", "approved", "denied", "expired"] as const;
const APPROVAL_STATUS_SET = new Set<string>(APPROVAL_STATUSES);
type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

function isApprovalStatus(value: string): value is ApprovalStatus {
  return APPROVAL_STATUS_SET.has(value);
}

export function approvalsPath(): string {
  return firstNonEmpty(process.env.MUSE_APPROVALS_FILE) ?? join(homedir(), ".muse", "pending-approvals.jsonl");
}

export function trustPath(): string {
  return firstNonEmpty(process.env.MUSE_TRUST_FILE) ?? join(homedir(), ".muse", "trust.json");
}

async function readApprovals(): Promise<readonly PendingRequest[]> {
  try {
    const raw = await readFile(approvalsPath(), "utf8");
    const out: PendingRequest[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line);
        if (isPendingRequest(parsed)) {
          out.push(parsed);
        }
      } catch { /* skip */ }
    }
    return out;
  } catch { return []; }
}

function isPendingRequest(value: unknown): value is PendingRequest {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || value.id.length === 0) return false;
  if (typeof value.toolName !== "string" || value.toolName.length === 0) return false;
  if (typeof value.userKey !== "string" || value.userKey.length === 0) return false;
  if (typeof value.askedAtIso !== "string" || value.askedAtIso.length === 0) return false;
  if (typeof value.status !== "string" || !isApprovalStatus(value.status)) return false;
  if (value.decidedAtIso !== undefined && typeof value.decidedAtIso !== "string") return false;
  if (value.decidedBy !== undefined && typeof value.decidedBy !== "string") return false;
  if (value.reason !== undefined && typeof value.reason !== "string") return false;
  return true;
}

function isTrustUser(value: unknown): value is { trustedTools: string[]; blockedTools: string[] } {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.trustedTools) &&
    value.trustedTools.every((tool: unknown) => typeof tool === "string") &&
    Array.isArray(value.blockedTools) &&
    value.blockedTools.every((tool: unknown) => typeof tool === "string")
  );
}

function parseTrustDocument(raw: string): { version: 1; users: Record<string, { trustedTools: string[]; blockedTools: string[] }> } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.users)) return undefined;
  const users: Record<string, { trustedTools: string[]; blockedTools: string[] }> = {};
  for (const [userKey, value] of Object.entries(parsed.users)) {
    if (isTrustUser(value)) {
      users[userKey] = { blockedTools: [...value.blockedTools], trustedTools: [...value.trustedTools] };
    }
  }
  return { version: 1, users };
}

async function appendApproval(entry: PendingRequest): Promise<void> {
  const path = approvalsPath();
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

/**
 * Rewrites the entire pending-approvals file with the given list.
 * Used when decisions land — we replace the matching entry with the
 * decided form. Tmp+rename keeps the visible state atomic.
 */
async function rewriteApprovals(entries: readonly PendingRequest[]): Promise<void> {
  const path = approvalsPath();
  const tmp = `${path}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, `${entries.map((e) => JSON.stringify(e)).join("\n")}${entries.length > 0 ? "\n" : ""}`, { mode: 0o600 });
  await rename(tmp, path);
}

function defaultUserKey(persona: string | undefined): string {
  const base = resolveDefaultUserKey();
  const resolved = resolvePersona(persona);
  return resolved ? `${base}@${resolved}` : base;
}

/** Public helper for the agent runtime to log a pending request. */
async function logPendingApproval(input: {
  readonly toolName: string;
  readonly userKey: string;
  readonly reason?: string;
}): Promise<PendingRequest> {
  const entry: PendingRequest = {
    askedAtIso: new Date().toISOString(),
    id: `pa_${Date.now().toString()}_${Math.random().toString(36).slice(2, 10)}`,
    status: "pending",
    toolName: input.toolName,
    userKey: input.userKey,
    ...(input.reason ? { reason: input.reason } : {})
  };
  await appendApproval(entry);
  return entry;
}

export function registerApprovalCommands(program: Command, io: ProgramIO): void {
  const approval = program.command("approval").description("Tool-call trust decisions — audit pending tool requests, grant/deny to your trust list (for outbound sends see `muse approvals`)");

  approval
    .command("list")
    .description("Show pending (or recently decided) approval requests")
    .option("--user <id>", "Filter by user identity")
    .option("--persona <slot>", "Persona slot")
    .option("--all", "Include approved + denied + expired entries")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: { readonly user?: string; readonly persona?: string; readonly all?: boolean; readonly json?: boolean }) => {
      const userKey = options.user
        ? (options.persona ? `${options.user}@${options.persona}` : options.user)
        : defaultUserKey(options.persona);
      const all = await readApprovals();
      const filtered = all.filter((e) => e.userKey === userKey && (options.all || e.status === "pending"));
      if (options.json) {
        io.stdout(`${JSON.stringify({ entries: filtered, total: filtered.length, userKey }, null, 2)}\n`);
        return;
      }
      io.stdout(`Approvals for ${userKey} (${filtered.length.toString()}):\n`);
      if (filtered.length === 0) {
        io.stdout("  (none)\n");
      }
      for (const entry of filtered) {
        const flag = entry.status === "approved" ? "✓" : entry.status === "denied" ? "✗" : entry.status === "expired" ? "⊘" : "·";
        io.stdout(`  ${flag} ${entry.id}  ${entry.toolName}  [${entry.status}]\n`);
        io.stdout(`      asked ${entry.askedAtIso}${entry.reason ? ` — ${entry.reason}` : ""}\n`);
        if (entry.decidedAtIso) {
          io.stdout(`      decided ${entry.decidedAtIso}${entry.decidedBy ? ` by ${entry.decidedBy}` : ""}\n`);
        }
      }
    });

  approval
    .command("approve")
    .description("Mark a pending approval as approved AND grant the tool to the user's trust list")
    .argument("<id>", "Approval request id (from `muse approval list`)")
    .action(async (id: string) => {
      const all = await readApprovals();
      const target = all.find((e) => e.id === id);
      if (!target) {
        const suggestion = closestCommandName(id, all.map((e) => e.id));
        const hint = suggestion ? ` — did you mean '${suggestion}'?` : "";
        io.stderr(`Request '${id}' not found.${hint} (run \`muse approval list\` to see pending ids)\n`);
        process.exitCode = 1;
        return;
      }
      if (target.status !== "pending") {
        io.stderr(`Request '${id}' is already ${target.status}.\n`);
        process.exitCode = 1;
        return;
      }
      const updated: PendingRequest = {
        ...target,
        decidedAtIso: new Date().toISOString(),
        decidedBy: "cli-approve",
        status: "approved"
      };

      // Trust grant — mirror the muse trust grant logic inline so
      // we don't need a circular import. Same on-disk file shape.
      const trustFilePath = trustPath();
      let trustDoc: { version: 1; users: Record<string, { trustedTools: string[]; blockedTools: string[] }> } = { users: {}, version: 1 };
      try {
        const raw = await readFile(trustFilePath, "utf8");
        const parsed = parseTrustDocument(raw);
        if (parsed) {
          trustDoc = parsed;
        }
      } catch { /* empty */ }
      const entry = trustDoc.users[target.userKey] ?? { blockedTools: [], trustedTools: [] };
      if (!entry.trustedTools.includes(target.toolName)) {
        entry.trustedTools.push(target.toolName);
      }
      entry.blockedTools = entry.blockedTools.filter((t) => t !== target.toolName);
      trustDoc.users[target.userKey] = entry;
      await mkdir(dirname(trustFilePath), { recursive: true });
      const tmp = `${trustFilePath}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
      await writeFile(tmp, `${JSON.stringify(trustDoc, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, trustFilePath);

      // Flip the approval entry's state ONLY after the trust write succeeds,
      // so a malformed trust.json can't leave the entry approved on disk
      // while the grant never landed.
      await rewriteApprovals(all.map((e) => e.id === id ? updated : e));

      io.stdout(`Approved ${id} → '${target.toolName}' added to trust list for ${target.userKey}\n`);
    });

  approval
    .command("deny")
    .description("Mark a pending approval as denied (does NOT block the tool in future — use `muse trust block` for that)")
    .argument("<id>", "Approval request id")
    .action(async (id: string) => {
      const all = await readApprovals();
      const target = all.find((e) => e.id === id);
      if (!target) {
        const suggestion = closestCommandName(id, all.map((e) => e.id));
        const hint = suggestion ? ` — did you mean '${suggestion}'?` : "";
        io.stderr(`Request '${id}' not found.${hint} (run \`muse approval list\` to see pending ids)\n`);
        process.exitCode = 1;
        return;
      }
      if (target.status !== "pending") {
        io.stderr(`Request '${id}' is already ${target.status}.\n`);
        process.exitCode = 1;
        return;
      }
      const updated: PendingRequest = {
        ...target,
        decidedAtIso: new Date().toISOString(),
        decidedBy: "cli-deny",
        status: "denied"
      };
      await rewriteApprovals(all.map((e) => e.id === id ? updated : e));
      io.stdout(`Denied ${id} — '${target.toolName}' NOT added to trust list. Use 'muse trust block ${target.toolName}' to hard-block.\n`);
    });

  // Internal helper exposed as a hidden command for testing /
  // future agent-runtime hook integration. Logs a synthetic
  // pending request without going through the runtime.
  approval
    .command("request")
    .description("Append a synthetic pending-approval entry (used by the agent runtime and tests)")
    .argument("<tool-name>", "Tool the agent wants to call")
    .option("--user <id>", "User identity")
    .option("--persona <slot>", "Persona slot")
    .option("--reason <text>", "Why approval is being requested")
    .action(async (tool: string, options: { readonly user?: string; readonly persona?: string; readonly reason?: string }) => {
      const userKey = options.user
        ? (options.persona ? `${options.user}@${options.persona}` : options.user)
        : defaultUserKey(options.persona);
      const entry = await logPendingApproval({
        toolName: tool,
        userKey,
        ...(options.reason ? { reason: options.reason } : {})
      });
      io.stdout(`Pending: ${entry.id} (tool=${tool}, user=${userKey})\n  Review: muse approval list --user ${userKey}\n`);
    });
}
