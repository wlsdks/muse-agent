/**
 * Pure filter over `GET /api/muse/loopback`'s catalog for the Builder's
 * tool-flow picker. A scheduled job runs UNATTENDED (no draft-first review
 * per firing), so which risk tiers may be scheduled is a human policy
 * decision, not something the Builder decides silently. 진안's ruling
 * (2026-07-18): read AND write tools may be scheduled — a write flow shows
 * a one-time state-change confirmation at create/re-point time — while
 * `execute` (shell-class) stays excluded, and a tool with NO declared risk
 * is excluded too (fail-closed default). Outbound sends are unaffected:
 * they keep their own draft-first gate regardless of this picker.
 */

import type { LoopbackCatalogResponse } from "../api/types.js";

// Write tools on these servers can transmit toward arbitrary third parties
// (messaging.send takes any platform destination) — scheduling one
// unattended would be an autonomous outbound send, which stays draft-first
// per .claude/rules/outbound-safety.md regardless of the write ruling.
const OUTBOUND_WRITE_SERVERS: ReadonlySet<string> = new Set(["muse.messaging"]);

export interface SchedulableToolOption {
  readonly serverName: string;
  readonly serverDescription: string;
  readonly toolName: string;
  readonly toolDescription: string;
  readonly risk: "read" | "write";
}

export function schedulableToolOptions(catalog: LoopbackCatalogResponse): readonly SchedulableToolOption[] {
  const options: SchedulableToolOption[] = [];
  for (const server of catalog.servers) {
    for (const tool of server.tools) {
      const writeAllowed = tool.risk === "write" && !OUTBOUND_WRITE_SERVERS.has(server.name);
      if (tool.risk === "read" || writeAllowed) {
        options.push({
          risk: tool.risk,
          serverDescription: server.description,
          serverName: server.name,
          toolDescription: tool.description,
          toolName: tool.name
        });
      }
    }
  }
  return options;
}

/** True when the currently selected pair is a state-CHANGING tool — the
 * create/edit forms show the one-time confirmation styling off this. */
export function isWriteToolSelection(
  options: readonly SchedulableToolOption[],
  serverName: string,
  toolName: string
): boolean {
  return options.some(
    (option) => option.serverName === serverName && option.toolName === toolName && option.risk === "write"
  );
}

export function uniqueServerNames(options: readonly SchedulableToolOption[]): readonly string[] {
  return [...new Set(options.map((option) => option.serverName))];
}

export function toolsForServer(
  options: readonly SchedulableToolOption[],
  serverName: string
): readonly SchedulableToolOption[] {
  return options.filter((option) => option.serverName === serverName);
}
