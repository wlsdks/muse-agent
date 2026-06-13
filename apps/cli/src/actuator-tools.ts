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
  appendActionLog,
  createEmailForwardTool,
  createEmailReplyTool,
  createEmailSendTool,
  createHomeActionTool,
  createWebActionTool,
  queryContacts,
  resolveContact,
  type EmailApprovalGate,
  type HostLookup,
  type MessageApprovalGate,
  type WebActionApprovalGate
} from "@muse/mcp";
import {
  createMacAppOpenTool,
  createMacAppReadTool,
  createMacClipboardSetTool,
  createMacMediaControlTool,
  createMacMessageSendTool,
  createMacSayTool,
  createMacScreenReadTool,
  createMacScreenshotTool,
  createMacShortcutRunTool,
  createMacSpotlightSearchTool,
  createMacSystemSetTool
} from "@muse/macos";
import {
  PuppeteerBrowserController,
  createBrowserBackTool,
  createBrowserLookTool,
  createBrowserClickTool,
  createBrowserHoverTool,
  createBrowserKeyTool,
  createBrowserOpenTool,
  createBrowserReadTool,
  createBrowserScrollTool,
  createBrowserTypeTool,
  createBrowserWaitTool,
  type BrowserApprovalGate,
  type BrowserController
} from "@muse/browser";
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

  // macOS native-app actuators (Shortcuts run, app read, iMessage send) are an
  // explicit opt-in power feature (darwin only) — off by default so a stray
  // box never arms an iMessage send, on when the user sets the flag.
  if (macActuatorsEnabled(env)) {
    armed.push(
      "mac_shortcut_run", "mac_screen_read", "mac_app_read", "mac_app_open", "mac_media_control", "mac_system_set",
      "mac_screenshot", "mac_clipboard_set", "mac_spotlight_search", "mac_say", "mac_message_send"
    );
  }

  return { armed, unavailable };
}

/**
 * The macOS-actuator opt-in. A power feature (it can run any user Shortcut and
 * send an iMessage), so it stays dark until explicitly enabled — mirrors the
 * env-gated posture of the email / smart-home actuators.
 */
export function macActuatorsEnabled(env: MuseEnvironment): boolean {
  const value = env.MUSE_MACOS_ACTUATORS?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
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
  /** DNS resolver for the web_action SSRF guard; defaults to the system lookup (tests inject a fake public resolver). */
  readonly lookup?: HostLookup;
  /**
   * Local vision callback for mac_screen_read (bound by the CLI to the
   * assembly's model AFTER assembly creation — hence resolved lazily at
   * call time). Absent ⇒ the tool reports the vision model unavailable.
   */
  readonly describeScreenImage?: (input: { readonly imageBase64: string; readonly mimeType: string; readonly question?: string }) => Promise<{ readonly ok: boolean; readonly text?: string; readonly error?: string }>;
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

/**
 * Fail-closed draft-first gate for browser page acts (click / type). Same
 * contract as the messaging/web gates: shows the exact action + target page and
 * fires ONLY on confirm; in a non-interactive context the confirm can't be
 * delivered, so the act is DENIED (outbound-safety — a wrong autonomous
 * click/submit toward a third-party site can't be rolled back).
 */
export function buildBrowserApprovalGate(deps: {
  readonly io: ProgramIO;
  readonly confirmAction: (message: string) => Promise<boolean>;
  readonly isInteractive?: () => boolean;
}): BrowserApprovalGate {
  const interactive = deps.isInteractive ?? DEFAULT_INTERACTIVE;
  return async (draft) => {
    if (!interactive()) {
      return { approved: false, reason: "non-interactive — browser actions need a live confirm" };
    }
    const what = draft.action === "type" ? `Type into ${draft.target}: ${draft.text ?? ""}` : `Click ${draft.target}`;
    deps.io.stdout(`\n${what}\n(on ${draft.url})\n\n`);
    return (await deps.confirmAction(draft.action === "type" ? "Type this in the browser?" : "Click this in the browser?"))
      ? { approved: true }
      : { approved: false, reason: "user did not confirm" };
  };
}

export interface BrowserToolsDeps {
  readonly io: ProgramIO;
  readonly confirmAction?: (message: string) => Promise<boolean>;
  readonly isInteractive?: () => boolean;
  /** Receives the live controller so the caller can disconnect() after a one-shot run. */
  readonly onController?: (controller: BrowserController) => void;
  /** Local vision callback for browser_look (bound by the CLI to the assembly's model). Absent ⇒ browser_look is omitted. */
  readonly describeImage?: (input: { readonly imageBase64: string; readonly mimeType: string; readonly question?: string }) => Promise<{ readonly ok: boolean; readonly text?: string; readonly error?: string }>;
}

/**
 * Muse's native browser-control tools, available BY DEFAULT under `--with-tools`
 * (not gated behind `--actuators`): reads/navigation (browser_open/read/back)
 * are free; the state-changing acts (browser_click/type) carry the draft-first
 * gate above. One lazy Chrome controller is shared across the tools — Chrome
 * launches only on first actual use.
 */
export function buildBrowserTools(deps: BrowserToolsDeps): MuseTool[] {
  const confirmAction =
    deps.confirmAction ??
    ((message: string) => confirm({ message }).then((answer) => !isCancel(answer) && answer === true));
  const controller = new PuppeteerBrowserController();
  // One-shot callers (muse ask) MUST disconnect after the run: the open CDP
  // socket pins the Node event loop, so without this the process never exits
  // (Chrome itself stays up for the next invocation to reconnect to).
  deps.onController?.(controller);
  const gate = buildBrowserApprovalGate({
    confirmAction,
    io: deps.io,
    ...(deps.isInteractive ? { isInteractive: deps.isInteractive } : {})
  });
  return [
    createBrowserOpenTool({ controller }),
    createBrowserReadTool({ controller }),
    createBrowserBackTool({ controller }),
    createBrowserScrollTool({ controller }),
    createBrowserWaitTool({ controller }),
    createBrowserHoverTool({ controller }),
    createBrowserKeyTool({ approvalGate: gate, controller }),
    createBrowserClickTool({ approvalGate: gate, controller }),
    createBrowserTypeTool({ approvalGate: gate, controller }),
    // browser_look (vision over the page) only when a vision callback is wired.
    ...(deps.describeImage ? [createBrowserLookTool({ controller, describeImage: deps.describeImage })] : [])
  ];
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
  tools.push(createWebActionTool({ actionLogFile, approvalGate: webGate, fetchImpl, ...(deps.lookup ? { lookup: deps.lookup } : {}), userId }));

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

  if (macActuatorsEnabled(env)) {
    // Only the third-party send (mac_message_send) needs the draft-first gate;
    // mac_shortcut_run (local, user-authored) and mac_app_read (read-only) carry
    // no outbound-to-human risk, so they ride the runtime's execute/localMode
    // gating like muse.skills.run, with no bespoke per-call confirm.
    const macMessageGate = buildMessagingApprovalGate({
      confirmAction,
      io,
      ...(deps.isInteractive ? { isInteractive: deps.isInteractive } : {})
    });
    tools.push(
      createMacShortcutRunTool(),
      createMacScreenReadTool({
        describeImage: deps.describeScreenImage ?? (async () => ({ error: "the local vision model is not available in this run", ok: false }))
      }),
      createMacAppReadTool(),
      createMacAppOpenTool(),
      createMacMediaControlTool(),
      createMacSystemSetTool(),
      createMacScreenshotTool(),
      createMacClipboardSetTool(),
      createMacSpotlightSearchTool(),
      createMacSayTool(),
      // @muse/macos takes the action logger AND the recipient resolver by
      // injection (it never depends on @muse/mcp); the CLI binds the logger to
      // the same append-only action log the other outbound actuators write, and
      // resolves a NAME → number from the contacts graph here (Rule 3: resolved,
      // never guessed) — bringing iMessage to email's recipient-resolution parity.
      createMacMessageSendTool({
        actionLog: (entry) => appendActionLog(actionLogFile, entry),
        approvalGate: macMessageGate,
        resolveRecipient: async (name) => {
          const resolution = resolveContact(await queryContacts(resolveContactsFile(env)), name);
          if (resolution.status === "ambiguous") {
            return { candidates: resolution.matches.map((contact) => contact.name), matchCount: resolution.matches.length, status: "ambiguous" };
          }
          if (resolution.status === "unknown") {
            return { status: "unknown" };
          }
          const recipient = resolution.contact.phone ?? resolution.contact.email;
          return recipient ? { name: resolution.contact.name, recipient, status: "resolved" } : { status: "unknown" };
        },
        userId
      })
    );
  }

  return tools;
}
