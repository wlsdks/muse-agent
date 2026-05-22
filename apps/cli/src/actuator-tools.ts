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

export interface ActuatorSummary {
  readonly armed: readonly string[];
  readonly unavailable: readonly { readonly name: string; readonly hint: string }[];
}

/**
 * Which actuators `--actuators` arms for a given env, and how to arm
 * the rest. Kept in lockstep with `buildActuatorTools` (a test asserts
 * the armed set equals the built tool names) so the banner never claims
 * a capability the agent can't actually use.
 */
export function summarizeActuators(env: MuseEnvironment): ActuatorSummary {
  const armed: string[] = ["web_action"];
  const unavailable: { name: string; hint: string }[] = [];

  if (env.MUSE_GMAIL_TOKEN?.trim()) {
    armed.push("email_send");
  } else {
    unavailable.push({ hint: "set MUSE_GMAIL_TOKEN", name: "email_send" });
  }

  if (env.MUSE_HOMEASSISTANT_URL?.trim() && env.MUSE_HOMEASSISTANT_TOKEN?.trim()) {
    armed.push("home_action");
  } else {
    unavailable.push({ hint: "set MUSE_HOMEASSISTANT_URL + MUSE_HOMEASSISTANT_TOKEN", name: "home_action" });
  }

  return { armed, unavailable };
}

export function formatActuatorBanner(summary: ActuatorSummary): string {
  const lines = [
    `(actuators armed: ${summary.armed.join(", ")} — every action shows the exact draft and fires only on your confirm)`
  ];
  for (const { name, hint } of summary.unavailable) {
    lines.push(`(actuator unavailable: ${name} — ${hint})`);
  }
  return `${lines.join("\n")}\n`;
}

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
