/**
 * `MacosNotificationProvider` — credential-free outbound provider that
 * fires a native macOS Notification Center alert via `osascript`.
 *
 * Companion to `LogMessagingProvider`: that one logs to a file, this
 * one pops up on the user's screen. Together they cover the
 * "JARVIS without setting up a chat bot" surface for macOS users.
 *
 * Out of scope here: rich actions, replies, persistent notifications.
 * Notification Center's stock alert is enough for "Sir, you have a
 * meeting in 5 minutes." Anything richer routes through one of the
 * real messaging providers.
 *
 * Only valid on darwin; instantiation throws on other platforms so
 * `buildMessagingRegistry` can gate the registration.
 */

import { spawn } from "node:child_process";
import { platform } from "node:os";

import { errorMessage } from "@muse/shared";

import { runDesktopNotificationCommand, type DesktopNotificationRunResult } from "./desktop-notification-command.js";
import { MessagingProviderError, MessagingValidationError } from "./errors.js";
import type {
  MessagingProvider,
  MessagingProviderInfo,
  OutboundMessage,
  OutboundReceipt
} from "./types.js";
import { validateOutboundMessage } from "./validate.js";

/**
 * Result of spawning `osascript`. Tests inject a fake runner to
 * assert the script Muse sends without actually firing a desktop
 * notification.
 */
export type OsascriptRunResult = DesktopNotificationRunResult;

export type OsascriptRunner = (script: string) => Promise<OsascriptRunResult>;

export async function defaultRunner(
  script: string,
  spawnFn: typeof spawn = spawn
): Promise<OsascriptRunResult> {
  return runDesktopNotificationCommand({
    args: ["-e", script],
    command: "osascript",
    label: "osascript notification",
    spawnFn
  });
}

export interface MacosNotificationProviderOptions {
  readonly id?: string;
  /** Title shown in the notification banner. Default "Muse". */
  readonly title?: string;
  /** Override the osascript runner (tests). */
  readonly runner?: OsascriptRunner;
}

/**
 * Escapes user-supplied text so it survives interpolation into an
 * AppleScript string literal. AppleScript escapes are
 * backslash-style for `\\` and `"`, identical to JS/JSON.
 * Newlines are flattened to spaces — Notification Center collapses
 * them anyway, but doing it explicitly keeps the script single-line.
 */
function escapeForAppleScript(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ");
}

export class MacosNotificationProvider implements MessagingProvider {
  readonly id: string;

  private readonly title: string;
  private readonly runner: OsascriptRunner;

  constructor(options: MacosNotificationProviderOptions = {}) {
    if (platform() !== "darwin" && !options.runner) {
      // Refuse to register on non-darwin unless a test runner is
      // injected. Without this, the daemon would happily fan out to
      // an osascript that doesn't exist and every send would error.
      // UPSTREAM_FAILED is the closest of the 5 enumerated codes —
      // osascript IS our upstream.
      throw new MessagingProviderError(
        "macos-notification",
        "UPSTREAM_FAILED",
        `MacosNotificationProvider requires darwin; running on ${platform()}`
      );
    }
    this.id = options.id ?? "macos-notification";
    this.title = options.title ?? "Muse";
    this.runner = options.runner ?? defaultRunner;
  }

  describe(): MessagingProviderInfo {
    return {
      description:
        "Native macOS Notification Center alert via osascript. " +
        "No credentials. Set MUSE_MESSAGING_MACOS_NOTIFICATION_ENABLED=true to enable.",
      displayName: "macOS notification",
      id: this.id,
      local: true
    };
  }

  async send(message: OutboundMessage): Promise<OutboundReceipt> {
    validateOutboundMessage(message);
    if (typeof message.destination !== "string" || message.destination.length === 0) {
      throw new MessagingValidationError("destination", "destination is required");
    }
    const body = escapeForAppleScript(message.text);
    const title = escapeForAppleScript(this.title);
    const subtitle = escapeForAppleScript(message.destination);
    // Notification format: title = "Muse", subtitle = destination tag,
    // body = the notice text. macOS may truncate long bodies — Phase D
    // synthesis is already capped to ~200 chars so this is fine.
    const script = `display notification "${body}" with title "${title}" subtitle "${subtitle}"`;
    const result = await this.runner(script).catch((cause: unknown) => {
      throw new MessagingProviderError(
        this.id,
        "UPSTREAM_FAILED",
        `osascript spawn failed: ${errorMessage(cause, "osascript spawn failed")}`
      );
    });
    if (result.exitCode !== 0) {
      throw new MessagingProviderError(
        this.id,
        "UPSTREAM_FAILED",
        `osascript exited with code ${result.exitCode ?? "null"}: ${result.stderr.trim()}${result.truncated ? " (output truncated)" : ""}`
      );
    }
    return {
      destination: message.destination,
      messageId: `macos-notification-${Date.now().toString()}`,
      providerId: this.id,
      raw: { script }
    };
  }
}
