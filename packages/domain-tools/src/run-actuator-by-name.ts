/**
 * Re-run a gated actuator (email_send / web_action / home_action) by
 * name with its persisted args, through the SAME fail-closed
 * `*WithApproval` orchestration the agent tools use — the shared
 * dispatcher behind both `muse approvals approve` and the (opt-in)
 * in-chat approval auto-completion. The approval gate is injected: the
 * CLI passes a clack confirm; the chat path passes auto-approve (the
 * inbound "yes" reply IS the explicit confirm of the already-shown
 * draft, per outbound-safety). NOT for payments — out of scope.
 */

import type { JsonObject } from "@muse/shared";

import { createEmailSendTool } from "./email-tool.js";
import { GmailEmailProvider } from "./email-provider.js";
import type { Contact } from "@muse/stores";
import type { EmailApprovalGate } from "./email-send.js";
import { createHomeActionTool } from "./smart-home-tool.js";
import { createWebActionTool } from "./web-action-tool.js";
import type { WebActionApprovalGate } from "./web-action.js";
import type { HostLookup } from "./web-url-guard.js";

export interface RunActuatorByNameDeps {
  readonly actionLogFile: string;
  readonly userId: string;
  readonly fetchImpl?: typeof fetch;
  readonly emailApprovalGate: EmailApprovalGate;
  readonly webApprovalGate: WebActionApprovalGate;
  readonly contacts?: () => Promise<readonly Contact[]> | readonly Contact[];
  readonly gmailToken?: string;
  readonly homeAssistantBaseUrl?: string;
  readonly homeAssistantToken?: string;
  /** Composition-owned local-only posture; false never overrides ambient strictness. */
  readonly localOnly?: boolean;
  /** DNS resolver for SSRF guard on web_action; defaults to the system lookup (tests inject a fake). */
  readonly lookup?: HostLookup;
}

export type RunActuatorResult =
  | { readonly ran: true }
  | { readonly ran: false; readonly reason: "declined" | "unavailable" | "unknown-tool" | "failed"; readonly detail?: string };

function classifyFailure(result: Record<string, unknown>): RunActuatorResult {
  const reason = result["reason"];
  const detail = typeof result["detail"] === "string" ? result["detail"] : (typeof reason === "string" ? reason : undefined);
  return { ran: false, reason: reason === "denied" ? "declined" : "failed", ...(detail !== undefined ? { detail } : {}) };
}

export async function runActuatorByName(
  tool: string,
  args: JsonObject,
  deps: RunActuatorByNameDeps
): Promise<RunActuatorResult> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const ctx = { runId: `actuator-${Date.now().toString()}`, userId: deps.userId };

  if (tool === "email_send") {
    if (!deps.gmailToken || !deps.contacts) {
      return { ran: false, reason: "unavailable", detail: "email_send needs MUSE_GMAIL_TOKEN + contacts" };
    }
    const result = (await createEmailSendTool({
      actionLogFile: deps.actionLogFile,
      approvalGate: deps.emailApprovalGate,
      contacts: deps.contacts,
      sender: new GmailEmailProvider(deps.gmailToken, fetchImpl),
      userId: deps.userId
    }).execute(args, ctx)) as Record<string, unknown>;
    return result["sent"] === true ? { ran: true } : classifyFailure(result);
  }

  if (tool === "web_action") {
    const result = (await createWebActionTool({
      actionLogFile: deps.actionLogFile,
      approvalGate: deps.webApprovalGate,
      fetchImpl,
      userId: deps.userId,
      ...(deps.lookup !== undefined ? { lookup: deps.lookup } : {})
    }).execute(args, ctx)) as Record<string, unknown>;
    return result["performed"] === true ? { ran: true } : classifyFailure(result);
  }

  if (tool === "home_action") {
    if (!deps.homeAssistantBaseUrl || !deps.homeAssistantToken) {
      return { ran: false, reason: "unavailable", detail: "home_action needs MUSE_HOMEASSISTANT_URL + MUSE_HOMEASSISTANT_TOKEN" };
    }
    const result = (await createHomeActionTool({
      actionLogFile: deps.actionLogFile,
      approvalGate: deps.webApprovalGate,
      baseUrl: deps.homeAssistantBaseUrl,
      fetchImpl,
      token: deps.homeAssistantToken,
      userId: deps.userId,
      ...(deps.localOnly ? { localOnly: true } : {})
    }).execute(args, ctx)) as Record<string, unknown>;
    return result["performed"] === true ? { ran: true } : classifyFailure(result);
  }

  return { ran: false, reason: "unknown-tool", detail: tool };
}
