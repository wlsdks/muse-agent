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

import { randomUUID } from "node:crypto";

import { createBrowserActionTracker } from "@muse/agent-core";
import { resolveActionLogFile, resolveContactsFile, resolveHomeAssistantEnvironment, type MuseEnvironment } from "@muse/autoconfigure";
import { recordPendingApproval } from "@muse/messaging";
import { appendActionLog, queryContacts, resolveContact } from "@muse/stores";
import { createEmailForwardTool, createEmailReplyTool, createEmailSendTool, createHomeActionTool, createWebActionTool, createAllowlistPathValidator, type EmailApprovalGate, type HostLookup, type MessageApprovalGate, type WebActionApprovalGate } from "@muse/domain-tools";
import { defaultFileReadRoots, type FsWriteApprovalGate, type FsWriteDraft } from "@muse/fs";
import { isWebEgressAllowed } from "@muse/model";
import {
  createMacAppOpenTool,
  createMacAppReadTool,
  createMacClipboardSetTool,
  createMacContactsWriteTool,
  createMacMediaControlTool,
  createMacMessageSendTool,
  createMacSayTool,
  createMacScreenReadTool,
  createMacScreenshotTool,
  createMacShortcutRunTool,
  createMacSpotlightSearchTool,
  createMacSystemSetTool,
  type ContactApprovalGate
} from "@muse/macos";
import {
  createWinAppOpenTool,
  createWinAppReadTool,
  createWinClipboardSetTool,
  createWinMediaControlTool,
  createWinSayTool,
  createWinScreenshotTool,
  createWinSystemSetTool
} from "@muse/windows";
import {
  PuppeteerBrowserController,
  createBrowserBackTool,
  createBrowserLookTool,
  createBrowserClickTool,
  createBrowserFillFormTool,
  createBrowserHoverTool,
  createBrowserKeyTool,
  createBrowserOpenTool,
  createBrowserReadTool,
  createBrowserScrollTool,
  createBrowserTypeTool,
  createBrowserUploadTool,
  createBrowserWaitTool,
  type BrowserApprovalGate,
  type BrowserController
} from "@muse/browser";
import type { MuseTool } from "@muse/tools";
import { confirm, isCancel } from "@clack/prompts";
import { parseBooleanFromEnv } from "@muse/shared";

import { resolveBrowserMaxActions } from "./browser-action-budget-config.js";
import type { ProgramIO } from "./program.js";
import { confirmBoolean } from "./confirm-boolean.js";
import { isGmailConfigured, resolveGmailProvider } from "./resolve-gmail-provider.js";

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
export function summarizeActuators(env: MuseEnvironment, io: ProgramIO): ActuatorSummary {
  const webEgress = isWebEgressAllowed(env);
  // Resolve the Home Assistant endpoint once, before any token read. Its
  // local-only value is also the monotonic posture used for the Gmail rows.
  const homeAssistant = resolveHomeAssistantEnvironment(env);
  const localOnly = homeAssistant.localOnly;
  const armed: string[] = webEgress ? ["web_action"] : [];
  const unavailable: { name: string; hint: string }[] = [];
  if (!webEgress) {
    unavailable.push({ hint: "web egress is off (unset MUSE_WEB_EGRESS)", name: "web_action" });
  }

  if (localOnly) {
    unavailable.push({ hint: "Gmail is disabled while MUSE_LOCAL_ONLY=true", name: "email_send" });
    unavailable.push({ hint: "Gmail is disabled while MUSE_LOCAL_ONLY=true", name: "email_reply" });
    unavailable.push({ hint: "Gmail is disabled while MUSE_LOCAL_ONLY=true", name: "email_forward" });
  } else if (isGmailConfigured(io, env)) {
    armed.push("email_send", "email_reply", "email_forward");
  } else {
    unavailable.push({ hint: "run `muse setup email` (App Password or Google OAuth) or set MUSE_GMAIL_TOKEN", name: "email_send" });
    unavailable.push({ hint: "run `muse setup email` (App Password or Google OAuth) or set MUSE_GMAIL_TOKEN", name: "email_reply" });
    unavailable.push({ hint: "run `muse setup email` (App Password or Google OAuth) or set MUSE_GMAIL_TOKEN", name: "email_forward" });
  }

  if (homeAssistant.status === "configured") {
    armed.push("home_action");
  } else {
    unavailable.push({
      hint: homeAssistant.status === "blocked"
        ? homeAssistant.reason
        : "set MUSE_HOMEASSISTANT_URL + MUSE_HOMEASSISTANT_TOKEN",
      name: "home_action"
    });
  }

  // macOS native-app actuators (Shortcuts run, app read, iMessage send) are an
  // explicit opt-in power feature (darwin only) — off by default so a stray
  // box never arms an iMessage send, on when the user sets the flag.
  if (macActuatorsEnabled(env)) {
    armed.push(
      "mac_shortcut_run", "mac_screen_read", "mac_app_read", "mac_app_open", "mac_media_control", "mac_system_set",
      "mac_screenshot", "mac_clipboard_set", "mac_spotlight_search", "mac_say", "mac_message_send", "mac_contacts_write"
    );
  }

  if (windowsActuatorsEnabled(env)) {
    armed.push(
      "win_app_open", "win_app_read", "win_clipboard_set", "win_say", "win_screenshot",
      "win_media_control", "win_system_set"
    );
  }

  return { armed, unavailable };
}

/**
 * The macOS-actuator opt-in. A power feature (it can run any user Shortcut and
 * send an iMessage), so it stays dark until explicitly enabled — mirrors the
 * env-gated posture of the email / smart-home actuators.
 */
function macActuatorsEnabled(env: MuseEnvironment): boolean {
  return parseBooleanFromEnv(env.MUSE_MACOS_ACTUATORS, false);
}

/** The Windows-actuator opt-in — same dark-by-default posture as macOS. */
function windowsActuatorsEnabled(env: MuseEnvironment): boolean {
  return parseBooleanFromEnv(env.MUSE_WINDOWS_ACTUATORS, false);
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

/**
 * Draft-first approval gate for `mac_contacts_write`. Mirrors
 * `buildMessagingApprovalGate` exactly: shows the EXACT {name, phone, email}
 * about to be created and fires ONLY on explicit confirm; a non-interactive
 * context (no TTY → the confirm can't be delivered) denies, never writes.
 */
export function buildContactsApprovalGate(deps: {
  readonly io: ProgramIO;
  readonly confirmAction: (message: string) => Promise<boolean>;
  readonly isInteractive?: () => boolean;
}): ContactApprovalGate {
  const interactive = deps.isInteractive ?? (() => Boolean(process.stdout.isTTY && process.stdin.isTTY));
  return async (draft) => {
    if (!interactive()) {
      return { approved: false, reason: "non-interactive — review and add via Contacts.app directly" };
    }
    const lines = [
      `\nAdd contact:\n  Name: ${draft.name}`,
      draft.phone ? `  Phone: ${draft.phone}` : undefined,
      draft.email ? `  Email: ${draft.email}` : undefined,
      "\n"
    ].filter((line): line is string => line !== undefined);
    deps.io.stdout(lines.join("\n"));
    return (await deps.confirmAction("Add this contact?"))
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
function buildBrowserApprovalGate(deps: {
  readonly io: ProgramIO;
  readonly confirmAction: (message: string) => Promise<boolean>;
  readonly isInteractive?: () => boolean;
}): BrowserApprovalGate {
  const interactive = deps.isInteractive ?? DEFAULT_INTERACTIVE;
  return async (draft) => {
    if (!interactive()) {
      return { approved: false, reason: "non-interactive — browser actions need a live confirm" };
    }
    let what: string;
    let question: string;
    if (draft.action === "fill") {
      const lines = (draft.fields ?? []).map((field) => `  • ${field.target}: ${field.value}`).join("\n");
      what = `Fill these fields:\n${lines}`;
      question = "Fill these fields in the browser?";
    } else if (draft.action === "upload") {
      what = `Attach file ${draft.path ?? ""}\n  → ${draft.target}`;
      question = "Attach this file in the browser?";
    } else if (draft.action === "type") {
      what = `Type into ${draft.target}: ${draft.text ?? ""}`;
      question = "Type this in the browser?";
    } else {
      what = `Click ${draft.target}`;
      question = "Click this in the browser?";
    }
    deps.io.stdout(`\n${what}\n(on ${draft.url})\n\n`);
    return (await deps.confirmAction(question))
      ? { approved: true }
      : { approved: false, reason: "user did not confirm" };
  };
}

const PENDING_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Maps a refused fs-write draft onto the SAME pending-approval store the
 * channel-approval gate uses (`packages/messaging/pending-approval-store`),
 * so a write staged from a non-interactive `muse ask` run shows up in
 * `muse approvals list` alongside a refused Telegram/etc. action. The
 * staged entry carries only the capped preview the draft already has —
 * NOT the full write payload — so it is a reviewable worklist item, not a
 * re-runnable one; re-running a staged fs write is a follow-up.
 */
export function buildCliPendingApprovalStager(deps: {
  readonly file: string;
  readonly now?: () => Date;
  readonly ttlMs?: number;
}): (draft: FsWriteDraft) => Promise<void> {
  const now = deps.now ?? (() => new Date());
  const ttlMs = deps.ttlMs ?? PENDING_APPROVAL_TTL_MS;
  return async (draft) => {
    const createdAt = now();
    await recordPendingApproval(deps.file, {
      arguments: { action: draft.action, path: draft.path },
      createdAt: createdAt.toISOString(),
      draft: draft.summary,
      expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString(),
      id: randomUUID(),
      providerId: "cli",
      risk: "write",
      source: "cli-local-write",
      tool: `file_${draft.action}`
    });
  };
}

/**
 * Fail-closed approval gate for the @muse/fs write tools (file_write /
 * file_edit / file_multi_edit). Shows the exact target path + a content
 * preview and writes ONLY on confirm; in a non-interactive context the
 * confirm can't be delivered, so the write is DENIED (a wrong autonomous
 * overwrite of a local file is not trivially reversible). The path is
 * already home-sandboxed + deny-listed inside the tool; this is the
 * human-in-the-loop layer on top. When `stagePendingApproval` is provided,
 * a non-interactive refusal is ALSO recorded as a pending approval — best
 * effort (a staging failure still denies the write, never approves it).
 */
export function buildFsWriteApprovalGate(deps: {
  readonly io: ProgramIO;
  readonly confirmAction: (message: string) => Promise<boolean>;
  readonly isInteractive?: () => boolean;
  readonly stagePendingApproval?: (draft: FsWriteDraft) => Promise<void>;
}): FsWriteApprovalGate {
  const interactive = deps.isInteractive ?? DEFAULT_INTERACTIVE;
  return async (draft) => {
    if (!interactive()) {
      if (deps.stagePendingApproval) {
        try {
          await deps.stagePendingApproval(draft);
        } catch {
          // best-effort — a staging failure still falls through to the deny below
        }
        return { approved: false, reason: "staged for approval — review with `muse approvals`" };
      }
      return { approved: false, reason: "non-interactive — file writes need a live confirm" };
    }
    deps.io.stdout(`\n${draft.summary}\n--- preview ---\n${draft.preview}\n\n`);
    return (await deps.confirmAction("Write this to disk?"))
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
  /** Source of MUSE_BROWSER_MAX_ACTIONS for the per-task action budget. Defaults to process.env. */
  readonly env?: Record<string, string | undefined>;
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
    ((message: string) => confirmBoolean(confirm, isCancel, message));
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
  // browser_upload reads a LOCAL file to attach it — so its source path goes
  // through the SAME allowlist + symlink guard file_read uses (Downloads /
  // Desktop / Documents). The validator is injected, never an allow-all read.
  const validatePath = createAllowlistPathValidator({ roots: defaultFileReadRoots() });
  // A single shared per-task budget across click/type/fill — an 8B model
  // stuck in a retry loop is bounded rather than free to act indefinitely.
  const actionBudget = createBrowserActionTracker(resolveBrowserMaxActions(deps.env ?? process.env));
  return [
    createBrowserOpenTool({ controller }),
    createBrowserReadTool({ controller }),
    createBrowserBackTool({ controller }),
    createBrowserScrollTool({ controller }),
    createBrowserWaitTool({ controller }),
    createBrowserHoverTool({ controller }),
    createBrowserKeyTool({ approvalGate: gate, controller }),
    createBrowserClickTool({ actionBudget, approvalGate: gate, controller }),
    createBrowserTypeTool({ actionBudget, approvalGate: gate, controller }),
    createBrowserFillFormTool({ actionBudget, approvalGate: gate, controller }),
    createBrowserUploadTool({ approvalGate: gate, controller, validatePath }),
    // browser_look (vision over the page) only when a vision callback is wired.
    ...(deps.describeImage ? [createBrowserLookTool({ controller, describeImage: deps.describeImage })] : [])
  ];
}

export function buildActuatorTools(deps: ActuatorToolsDeps): MuseTool[] {
  const { env, io, userId } = deps;
  // The resolver evaluates the monotonic ambient-or-injected posture before
  // it touches the HA token, so this interactive builder cannot become a
  // remote credential/reflection bypass.
  const homeAssistant = resolveHomeAssistantEnvironment(env);
  const localOnly = homeAssistant.localOnly;
  const fetchImpl = deps.fetchImpl ?? io.fetch ?? globalThis.fetch;
  const confirmAction =
    deps.confirmAction ??
    ((message: string) => confirmBoolean(confirm, isCancel, message));
  const actionLogFile = resolveActionLogFile(env);
  const tools: MuseTool[] = [];

  // web_action reaches the public web — the master web-egress switch (airplane
  // mode) drops it, independent of MUSE_LOCAL_ONLY (which governs cloud-LLM egress).
  if (isWebEgressAllowed(env)) {
    const webGate = buildWebApprovalGate({
      confirmAction,
      io,
      ...(deps.isInteractive ? { isInteractive: deps.isInteractive } : {}),
      prompt: "Perform this web action?"
    });
    tools.push(createWebActionTool({ actionLogFile, approvalGate: webGate, fetchImpl, ...(deps.lookup ? { lookup: deps.lookup } : {}), userId }));
  }

  const gmail = localOnly ? undefined : resolveGmailProvider({ env, fetchImpl, io });
  if (gmail) {
    const contactsFile = resolveContactsFile(env);
    const emailGate = buildEmailApprovalGate({
      confirmAction,
      io,
      ...(deps.isInteractive ? { isInteractive: deps.isInteractive } : {})
    });
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

  if (homeAssistant.status === "configured") {
    const homeGate = buildWebApprovalGate({
      confirmAction,
      io,
      ...(deps.isInteractive ? { isInteractive: deps.isInteractive } : {}),
      prompt: "Perform this smart-home action?"
    });
    tools.push(
      createHomeActionTool({
        actionLogFile,
        approvalGate: homeGate,
        baseUrl: homeAssistant.baseUrl,
        fetchImpl,
        localOnly: homeAssistant.localOnly,
        token: homeAssistant.token,
        userId
      })
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
      createMacSystemSetTool({
        ...(env.MUSE_FOCUS_ON_SHORTCUT?.trim() ? { focusOnShortcut: env.MUSE_FOCUS_ON_SHORTCUT.trim() } : {}),
        ...(env.MUSE_FOCUS_OFF_SHORTCUT?.trim() ? { focusOffShortcut: env.MUSE_FOCUS_OFF_SHORTCUT.trim() } : {}),
        ...(env.MUSE_BLUETOOTH_ON_SHORTCUT?.trim() ? { bluetoothOnShortcut: env.MUSE_BLUETOOTH_ON_SHORTCUT.trim() } : {}),
        ...(env.MUSE_BLUETOOTH_OFF_SHORTCUT?.trim() ? { bluetoothOffShortcut: env.MUSE_BLUETOOTH_OFF_SHORTCUT.trim() } : {}),
        ...(env.MUSE_BRIGHTNESS_SHORTCUT?.trim() ? { brightnessShortcut: env.MUSE_BRIGHTNESS_SHORTCUT.trim() } : {})
      }),
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
      }),
      createMacContactsWriteTool({
        actionLog: (entry) => appendActionLog(actionLogFile, entry),
        approvalGate: buildContactsApprovalGate({
          confirmAction,
          io,
          ...(deps.isInteractive ? { isInteractive: deps.isInteractive } : {})
        }),
        userId
      })
    );
  }

  if (windowsActuatorsEnabled(env)) {
    // All seven are local-effect only (no outbound-to-human path), so they ride
    // the runtime's execute/localMode gating with no bespoke per-call confirm.
    tools.push(
      createWinAppOpenTool(),
      createWinAppReadTool(),
      createWinClipboardSetTool(),
      createWinSayTool(),
      createWinScreenshotTool(),
      createWinMediaControlTool(),
      createWinSystemSetTool()
    );
  }

  return tools;
}
