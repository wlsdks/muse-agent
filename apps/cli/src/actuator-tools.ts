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
  createEmailForwardTool,
  createEmailReplyTool,
  createEmailSendTool,
  createHomeActionTool,
  createWebActionTool,
  queryContacts,
  type EmailApprovalGate,
  type MessageApprovalGate,
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
    armed.push("email_send", "email_reply", "email_forward");
  } else {
    unavailable.push({ hint: "set MUSE_GMAIL_TOKEN", name: "email_send" });
    unavailable.push({ hint: "set MUSE_GMAIL_TOKEN", name: "email_reply" });
    unavailable.push({ hint: "set MUSE_GMAIL_TOKEN", name: "email_forward" });
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
  /** Injectable TTY check so tests exercise the non-interactive fail-close. */
  readonly isInteractive?: () => boolean;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Draft-first approval gate for the agent's `muse.messaging.send` (a default
 * loopback tool, threaded into the assembly under `--actuators`). Mirrors the
 * email/web/home gates: shows the EXACT {provider → destination + text} and
 * fires ONLY on explicit confirm. Fail-closed in a NON-interactive context (no
 * TTY → the confirm can't be delivered → deny, never send) per outbound-safety.
 */
export function buildMessagingApprovalGate(deps: {
  readonly io: ProgramIO;
  readonly confirmAction: (message: string) => Promise<boolean>;
  readonly isInteractive?: () => boolean;
}): MessageApprovalGate {
  const interactive = deps.isInteractive ?? (() => Boolean(process.stdout.isTTY && process.stdin.isTTY));
  return async (draft) => {
    if (!interactive()) {
      return { approved: false, reason: "non-interactive — review and send via `muse messaging send`" };
    }
    deps.io.stdout(`\nSend to ${draft.providerId} → ${draft.destination}:\n${draft.text}\n\n`);
    return (await deps.confirmAction("Send this message?"))
      ? { approved: true }
      : { approved: false, reason: "user did not confirm" };
  };
}

const DEFAULT_INTERACTIVE = (): boolean => Boolean(process.stdout.isTTY && process.stdin.isTTY);

/**
 * Shared fail-closed approval gate for web/home actions. Same contract as the
 * messaging gate: in a NON-interactive context the confirm cannot be delivered,
 * so the action is DENIED, never performed (outbound-safety rule 2 — a piped
 * stdin byte must not be consumable as the confirmation keypress).
 */
export function buildWebApprovalGate(deps: {
  readonly io: ProgramIO;
  readonly confirmAction: (message: string) => Promise<boolean>;
  readonly prompt: string;
  readonly isInteractive?: () => boolean;
}): WebActionApprovalGate {
  const interactive = deps.isInteractive ?? DEFAULT_INTERACTIVE;
  return async (action) => {
    if (!interactive()) {
      return { approved: false, reason: "non-interactive — actions need a live confirm" };
    }
    deps.io.stdout(
      `\n${action.summary}\n${action.request.method ?? "POST"} ${action.request.url}\n${action.request.body ? `${action.request.body}\n` : ""}\n`
    );
    return (await deps.confirmAction(deps.prompt))
      ? { approved: true }
      : { approved: false, reason: "user did not confirm" };
  };
}

/** Fail-closed email draft gate — same non-interactive deny as the other actuators. */
export function buildEmailApprovalGate(deps: {
  readonly io: ProgramIO;
  readonly confirmAction: (message: string) => Promise<boolean>;
  readonly isInteractive?: () => boolean;
}): EmailApprovalGate {
  const interactive = deps.isInteractive ?? DEFAULT_INTERACTIVE;
  return async (draft) => {
    if (!interactive()) {
      return { approved: false, reason: "non-interactive — review and send interactively" };
    }
    deps.io.stdout(`\nTo: ${draft.recipientName} <${draft.to}>\nSubject: ${draft.subject}\n\n${draft.body}\n\n`);
    return (await deps.confirmAction("Send this email?"))
      ? { approved: true }
      : { approved: false, reason: "user did not confirm" };
  };
}

export function buildActuatorTools(deps: ActuatorToolsDeps): MuseTool[] {
  const { env, io, userId } = deps;
  const fetchImpl = deps.fetchImpl ?? io.fetch ?? globalThis.fetch;
  const confirmAction =
    deps.confirmAction ??
    ((message: string) => confirm({ message }).then((answer) => !isCancel(answer) && answer === true));
  const actionLogFile = resolveActionLogFile(env);
  const tools: MuseTool[] = [];

  const webGate = buildWebApprovalGate({
    confirmAction,
    io,
    ...(deps.isInteractive ? { isInteractive: deps.isInteractive } : {}),
    prompt: "Perform this web action?"
  });
  tools.push(createWebActionTool({ actionLogFile, approvalGate: webGate, fetchImpl, userId }));

  const gmailToken = env.MUSE_GMAIL_TOKEN?.trim();
  if (gmailToken) {
    const contactsFile = resolveContactsFile(env);
    const emailGate = buildEmailApprovalGate({
      confirmAction,
      io,
      ...(deps.isInteractive ? { isInteractive: deps.isInteractive } : {})
    });
    const gmail = new GmailEmailProvider(gmailToken, fetchImpl);
    tools.push(
      createEmailSendTool({
        actionLogFile,
        approvalGate: emailGate,
        contacts: () => queryContacts(contactsFile),
        sender: gmail,
        userId
      }),
      createEmailReplyTool({
        actionLogFile,
        approvalGate: emailGate,
        reader: gmail,
        sender: gmail,
        userId
      }),
      createEmailForwardTool({
        actionLogFile,
        approvalGate: emailGate,
        contacts: () => queryContacts(contactsFile),
        reader: gmail,
        sender: gmail,
        userId
      })
    );
  }

  const haUrl = env.MUSE_HOMEASSISTANT_URL?.trim();
  const haToken = env.MUSE_HOMEASSISTANT_TOKEN?.trim();
  if (haUrl && haToken) {
    const homeGate = buildWebApprovalGate({
      confirmAction,
      io,
      ...(deps.isInteractive ? { isInteractive: deps.isInteractive } : {}),
      prompt: "Perform this smart-home action?"
    });
    tools.push(
      createHomeActionTool({ actionLogFile, approvalGate: homeGate, baseUrl: haUrl, fetchImpl, token: haToken, userId })
    );
  }

  return tools;
}
