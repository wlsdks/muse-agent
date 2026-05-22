/**
 * `muse ask --with-tools --actuators` — wires the gated state-changing
 * actuators (email send, web action, smart-home) into the agent runtime
 * as tools so a real `muse ask` conversation can trigger them. Each
 * tool carries a clack confirm as its fail-closed gate: the exact draft
 * is shown and nothing fires without explicit confirmation (per
 * `.claude/rules/outbound-safety.md`). Off by default; opt-in per
 * invocation. Providers resolve from env — email needs MUSE_GMAIL_TOKEN,
 * smart-home needs MUSE_HOMEASSISTANT_URL + _TOKEN; web action is always
 * available. NOT for payments / money movement (out of scope).
 */

import type { MuseEnvironment } from "@muse/autoconfigure";
import { resolveActionLogFile, resolveContactsFile } from "@muse/autoconfigure";
import {
  GmailEmailProvider,
  createEmailSendTool,
  createHomeActionTool,
  createWebActionTool,
  queryContacts,
  type EmailApprovalGate,
  type WebActionApprovalGate
} from "@muse/mcp";
import type { MuseTool } from "@muse/tools";
import { confirm, isCancel } from "@clack/prompts";

import type { ProgramIO } from "./program.js";

export interface ActuatorToolsDeps {
  readonly env: MuseEnvironment;
  readonly io: ProgramIO;
  readonly userId: string;
  /**
   * Confirmation primitive — returns true to proceed. Defaults to a
   * clack `confirm`; tests inject a deterministic decision so the gate
   * threading can be verified without a TTY.
   */
  readonly confirmAction?: (message: string) => Promise<boolean>;
  readonly fetchImpl?: typeof fetch;
}

export function buildActuatorTools(deps: ActuatorToolsDeps): MuseTool[] {
  const { env, io, userId } = deps;
  const fetchImpl = deps.fetchImpl ?? io.fetch ?? globalThis.fetch;
  const confirmAction =
    deps.confirmAction ??
    ((message: string) => confirm({ message }).then((answer) => !isCancel(answer) && answer === true));
  const actionLogFile = resolveActionLogFile(env);
  const tools: MuseTool[] = [];

  const webGate: WebActionApprovalGate = async (action) => {
    io.stdout(
      `\n${action.summary}\n${action.request.method ?? "POST"} ${action.request.url}\n${action.request.body ? `${action.request.body}\n` : ""}\n`
    );
    return (await confirmAction("Perform this web action?"))
      ? { approved: true }
      : { approved: false, reason: "user did not confirm" };
  };
  tools.push(createWebActionTool({ actionLogFile, approvalGate: webGate, fetchImpl, userId }));

  const gmailToken = env.MUSE_GMAIL_TOKEN?.trim();
  if (gmailToken) {
    const contactsFile = resolveContactsFile(env);
    const emailGate: EmailApprovalGate = async (draft) => {
      io.stdout(`\nTo: ${draft.recipientName} <${draft.to}>\nSubject: ${draft.subject}\n\n${draft.body}\n\n`);
      return (await confirmAction("Send this email?"))
        ? { approved: true }
        : { approved: false, reason: "user did not confirm" };
    };
    tools.push(
      createEmailSendTool({
        actionLogFile,
        approvalGate: emailGate,
        contacts: () => queryContacts(contactsFile),
        sender: new GmailEmailProvider(gmailToken, fetchImpl),
        userId
      })
    );
  }

  const haUrl = env.MUSE_HOMEASSISTANT_URL?.trim();
  const haToken = env.MUSE_HOMEASSISTANT_TOKEN?.trim();
  if (haUrl && haToken) {
    const homeGate: WebActionApprovalGate = async (action) => {
      io.stdout(
        `\n${action.summary}\n${action.request.method ?? "POST"} ${action.request.url}\n${action.request.body ? `${action.request.body}\n` : ""}\n`
      );
      return (await confirmAction("Perform this smart-home action?"))
        ? { approved: true }
        : { approved: false, reason: "user did not confirm" };
    };
    tools.push(
      createHomeActionTool({ actionLogFile, approvalGate: homeGate, baseUrl: haUrl, fetchImpl, token: haToken, userId })
    );
  }

  return tools;
}
