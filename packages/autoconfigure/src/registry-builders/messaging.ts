/**
 * Messaging-registry builder — env + ~/.muse/messaging.json
 * tokens → MessagingProviderRegistry with the personal-JARVIS
 * subset (telegram / discord / slack / line / log / macos
 * notification). Lifted from `personal-providers.ts` to keep the
 * registry-builders leaf and the central wiring file focused.
 */

import {
  DiscordProvider,
  LineProvider,
  LinuxLibnotifyProvider,
  LogMessagingProvider,
  MacosNotificationProvider,
  MatrixProvider,
  MessagingProviderRegistry,
  SlackProvider,
  TelegramProvider
} from "@muse/messaging";
import { isLocalOnlyEnabled } from "@muse/model";

import type { MuseEnvironment } from "../index.js";
import { parseBoolean } from "../env-parsers.js";
import {
  resolveDiscordAfterFile,
  resolveDiscordInboxFile,
  resolveLineInboxFile,
  resolveMatrixInboxFile,
  resolveMatrixSinceFile,
  resolveMessagingCredentialsFile,
  resolveSlackAfterFile,
  resolveSlackInboxFile,
  resolveTelegramInboxFile,
  resolveTelegramOffsetFile
} from "../provider-paths.js";
import { readCredentialsSync, stringField } from "../provider-utils.js";

export function buildMessagingRegistry(env: MuseEnvironment): MessagingProviderRegistry {
  const registry = new MessagingProviderRegistry();
  // T2-B1: do this before resolving the messaging file or any remote token.
  // The credential-free log/native providers remain useful local surfaces.
  if (isLocalOnlyEnabled(env)) {
    registerLocalMessagingProviders(registry, env);
    return registry;
  }

  const file = readCredentialsSync(resolveMessagingCredentialsFile(env), env);
  const tokenFor = (envKey: string, providerId: string): string | undefined => {
    const fromEnv = env[envKey]?.trim();
    if (fromEnv && fromEnv.length > 0) {
      return fromEnv;
    }
    const fromFile = stringField(file[providerId], "token");
    return fromFile && fromFile.length > 0 ? fromFile : undefined;
  };
  const telegramToken = tokenFor("MUSE_TELEGRAM_BOT_TOKEN", "telegram");
  if (telegramToken) {
    // `offsetFile` and `inboxFile` are always wired. The provider
    // only touches them on demand: `pollUpdates` reads/writes the
    // offset; `fetchInbound` reads the inbox when configured (and
    // otherwise falls through to a snapshot poll). The polling
    // daemon appends new messages to the same inbox so the web
    // panel / REST converge on a single store.
    registry.register(new TelegramProvider({
      inboxFile: resolveTelegramInboxFile(env),
      offsetFile: resolveTelegramOffsetFile(env),
      token: telegramToken
    }));
  }
  const discordToken = tokenFor("MUSE_DISCORD_BOT_TOKEN", "discord");
  if (discordToken) {
    // afterFile drives pollUpdates' cursor.
    // inboxFile makes fetchInbound serve the
    // daemon-fed store (channel-filtered when source is given).
    // Both files are wired unconditionally; the provider only
    // touches them on demand, so an absent file is fine.
    registry.register(new DiscordProvider({
      afterFile: resolveDiscordAfterFile(env),
      inboxFile: resolveDiscordInboxFile(env),
      token: discordToken
    }));
  }
  const slackToken = tokenFor("MUSE_SLACK_BOT_TOKEN", "slack");
  if (slackToken) {
    // afterFile drives pollUpdates' per-channel ts
    // cursor. inboxFile makes fetchInbound serve the
    // daemon-fed store (channel-filtered when source is given).
    // Both files are wired unconditionally; the provider only
    // touches them on demand, so an absent file is fine.
    registry.register(new SlackProvider({
      afterFile: resolveSlackAfterFile(env),
      inboxFile: resolveSlackInboxFile(env),
      token: slackToken
    }));
  }
  const matrixToken = tokenFor("MUSE_MATRIX_ACCESS_TOKEN", "matrix");
  const matrixHomeserver = env.MUSE_MATRIX_HOMESERVER_URL?.trim() || stringField(file["matrix"], "homeserverUrl");
  // Fail-close: matrix needs BOTH the token and a homeserver URL —
  // there is no fixed default host to guess against.
  if (matrixToken && matrixHomeserver) {
    // sinceFile drives pollUpdates' next_batch cursor. inboxFile
    // makes fetchInbound serve the daemon-fed store. Both files are
    // wired unconditionally; the provider only touches them on
    // demand, so an absent file is fine.
    registry.register(new MatrixProvider({
      accessToken: matrixToken,
      homeserverUrl: matrixHomeserver,
      inboxFile: resolveMatrixInboxFile(env),
      sinceFile: resolveMatrixSinceFile(env)
    }));
  }
  const lineToken = tokenFor("MUSE_LINE_CHANNEL_ACCESS_TOKEN", "line");
  if (lineToken) {
    // Always pass the inbox file path; LineProvider only reads the
    // file when fetchInbound is called, so an absent file is fine.
    // The webhook handler creates it on first delivery.
    registry.register(new LineProvider({
      inboxFile: resolveLineInboxFile(env),
      token: lineToken
    }));
  }
  registerLocalMessagingProviders(registry, env);
  return registry;
}

function registerLocalMessagingProviders(registry: MessagingProviderRegistry, env: MuseEnvironment): void {
  // `log` is the credential-free, local-only outbound surface — write
  // every notice to `~/.muse/notifications.log` (override via
  // `MUSE_MESSAGING_LOG_FILE`). On by default so the proactive daemon
  // works end-to-end without any external chat-bot setup; opt out
  // with `MUSE_MESSAGING_LOG_ENABLED=false`.
  if (parseBoolean(env.MUSE_MESSAGING_LOG_ENABLED, true)) {
    const logFile = env.MUSE_MESSAGING_LOG_FILE?.trim();
    registry.register(new LogMessagingProvider(logFile ? { file: logFile } : {}));
  }
  // `macos-notification` is OPT-IN — native popups are more invasive
  // than a log file, so users have to flip the flag deliberately.
  // Only registers on darwin; the provider constructor throws when
  // the host isn't macOS, so the try/catch leaves the registry intact
  // on Linux / Windows where the env var would be a no-op.
  if (parseBoolean(env.MUSE_MESSAGING_MACOS_NOTIFICATION_ENABLED, false)) {
    try {
      const title = env.MUSE_MESSAGING_MACOS_NOTIFICATION_TITLE?.trim();
      registry.register(new MacosNotificationProvider(title ? { title } : {}));
    } catch {
      // Non-darwin host — skip silently. The opt-in flag is a hint,
      // not a hard requirement, and a stray flag in a shared dotfile
      // shouldn't break boot on Linux.
    }
  }
  // Linux parallel of the macOS notification provider — opt-in,
  // skips on wrong OS via the provider's own constructor guard.
  if (parseBoolean(env.MUSE_MESSAGING_LIBNOTIFY_ENABLED, false)) {
    try {
      const title = env.MUSE_MESSAGING_LIBNOTIFY_TITLE?.trim();
      const urgencyRaw = env.MUSE_MESSAGING_LIBNOTIFY_URGENCY?.trim().toLowerCase();
      const urgency = urgencyRaw === "low" || urgencyRaw === "critical" ? urgencyRaw : undefined;
      registry.register(new LinuxLibnotifyProvider({
        ...(title ? { title } : {}),
        ...(urgency ? { urgency } : {})
      }));
    } catch {
      // Non-linux host — skip silently. Mirrors the macOS path so a
      // shared dotfile that exports both flags doesn't break boot.
    }
  }
}
