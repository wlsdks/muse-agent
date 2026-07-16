/**
 * `LinuxLibnotifyProvider` — credential-free outbound provider
 * that fires a libnotify desktop alert via `notify-send` (the
 * CLI shipped with every major Linux desktop).
 *
 * Parallel to `MacosNotificationProvider`. Same posture: throws
 * on non-Linux hosts so the messaging registry skips it cleanly
 * when running on macOS / Windows / WSL-without-libnotify.
 *
 * Adds Linux to the credential-free messaging surface
 * Muse had only on macOS before. Together they cover the
 * "JARVIS without setting up a chat bot" surface on both OSes.
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

export type LibnotifyUrgency = "low" | "normal" | "critical";

/**
 * Spawn result + injection hook mirroring the MacosNotificationProvider
 * pattern. Tests pass a stub `runner` to assert argv shape without
 * actually firing a desktop notification.
 */
export type NotifySendRunResult = DesktopNotificationRunResult;

export type NotifySendRunner = (args: readonly string[]) => Promise<NotifySendRunResult>;

export async function defaultRunner(
  args: readonly string[],
  spawnFn: typeof spawn = spawn
): Promise<NotifySendRunResult> {
  return runDesktopNotificationCommand({
    args,
    command: "notify-send",
    label: "notify-send",
    spawnFn
  });
}

export interface LinuxLibnotifyProviderOptions {
  readonly id?: string;
  /** App name surfaced in the notification ("Muse"). */
  readonly title?: string;
  /** notify-send `--urgency` value. Default "normal". */
  readonly urgency?: LibnotifyUrgency;
  /** Override the notify-send runner (tests). */
  readonly runner?: NotifySendRunner;
}

export class LinuxLibnotifyProvider implements MessagingProvider {
  readonly id: string;

  private readonly title: string;
  private readonly urgency: LibnotifyUrgency;
  private readonly runner: NotifySendRunner;

  constructor(options: LinuxLibnotifyProviderOptions = {}) {
    if (platform() !== "linux" && !options.runner) {
      // Refuse to register on non-linux unless a test runner is
      // injected. Without this, the daemon would fan out to a
      // notify-send that doesn't exist on macOS / Windows and
      // every send would error.
      throw new MessagingProviderError(
        "libnotify",
        "UPSTREAM_FAILED",
        `LinuxLibnotifyProvider requires linux; running on ${platform()}`
      );
    }
    this.id = options.id ?? "libnotify";
    this.title = options.title ?? "Muse";
    this.urgency = options.urgency ?? "normal";
    this.runner = options.runner ?? defaultRunner;
  }

  describe(): MessagingProviderInfo {
    return {
      description:
        "Native Linux desktop alert via notify-send (libnotify). " +
        "No credentials. Set MUSE_MESSAGING_LIBNOTIFY_ENABLED=true to enable.",
      displayName: "libnotify",
      id: this.id,
      local: true
    };
  }

  async send(message: OutboundMessage): Promise<OutboundReceipt> {
    validateOutboundMessage(message);
    if (typeof message.destination !== "string" || message.destination.length === 0) {
      throw new MessagingValidationError("destination", "destination is required");
    }
    const args = buildNotifySendArgv({
      appName: this.id,
      urgency: this.urgency,
      title: this.title,
      subtitle: message.destination,
      body: message.text
    });
    const result = await this.runner(args).catch((cause: unknown) => {
      throw new MessagingProviderError(
        this.id,
        "UPSTREAM_FAILED",
        `notify-send spawn failed: ${errorMessage(cause, "notify-send spawn failed")}`
      );
    });
    if (result.exitCode !== 0) {
      throw new MessagingProviderError(
        this.id,
        "UPSTREAM_FAILED",
        `notify-send exited with code ${result.exitCode ?? "null"}: ${result.stderr.trim()}${result.truncated ? " (output truncated)" : ""}`
      );
    }
    return {
      destination: message.destination,
      messageId: `libnotify-${Date.now().toString()}`,
      providerId: this.id,
      raw: { args }
    };
  }
}

/**
 * Pure argv builder. Exported so the unit test pins
 * the exact notify-send command-line without having to spawn it.
 *
 * Shape:
 *   notify-send --app-name <app> --urgency <u> "<title> — <subtitle>" <body>
 *
 * notify-send's positional args are `<summary> [<body>]`. We
 * fold the destination subtitle into the summary with an em-dash
 * because libnotify has no subtitle slot equivalent to macOS.
 */
export function buildNotifySendArgv(args: {
  readonly appName: string;
  readonly urgency: LibnotifyUrgency;
  readonly title: string;
  readonly subtitle: string;
  readonly body: string;
}): readonly string[] {
  const summary = args.subtitle.length > 0
    ? `${args.title} — ${args.subtitle}`
    : args.title;
  return [
    "--app-name", args.appName,
    "--urgency", args.urgency,
    summary,
    args.body
  ];
}
