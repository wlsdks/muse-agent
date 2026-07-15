import { errorMessage } from "@muse/shared";

import {
  DiscordProvider,
  SlackProvider,
  TelegramProvider,
  appendInbound,
  type InboundMessage,
  type MessagingProviderRegistry
} from "@muse/messaging";

import { parseCsv } from "./env-parsers.js";
import {
  resolveDiscordInboxFile,
  resolveSlackInboxFile,
  resolveTelegramInboxFile
} from "./personal-providers.js";

import type { MuseEnvironment } from "./index.js";

export interface MessagingPollDispatchers {
  /**
   * Agent-triggered off-cadence pull for a single provider. Walks the
   * per-provider concrete `pollUpdates → appendInbound` chain so the
   * LLM can say "check Telegram now" without waiting on the poll
   * daemon's interval. LINE is webhook-fed only and raises a clear
   * error instead of silently succeeding with `ingested: 0`.
   */
  readonly pollNow: (providerId: string, source?: string) => Promise<{ ingested: number }>;
  /**
   * Pull every wired provider in one call. Per-channel providers use
   * the same channel CSVs the daemon respects
   * (`MUSE_DISCORD_POLL_CHANNELS` / `MUSE_SLACK_POLL_CHANNELS`); LINE
   * is webhook-fed and skipped. One bad channel per provider emits an
   * error entry but doesn't black out the rest.
   */
  readonly pollAll: () => Promise<{
    readonly ingestedByProvider: Readonly<Record<string, number>>;
    readonly errors: readonly { readonly providerId: string; readonly message: string }[];
  }>;
}

export function createMessagingPollDispatchers(
  env: MuseEnvironment,
  messagingRegistry: MessagingProviderRegistry
): MessagingPollDispatchers {
  const pollNow = async (providerId: string, source?: string): Promise<{ ingested: number }> => {
    const provider = messagingRegistry.require(providerId);
    let inbound: readonly InboundMessage[];
    let inboxFile: string;
    if (provider instanceof TelegramProvider) {
      inbound = await provider.pollUpdates();
      inboxFile = resolveTelegramInboxFile(env);
    } else if (provider instanceof DiscordProvider) {
      if (!source) {
        throw new Error("source (channel id) is required for discord");
      }
      inbound = await provider.pollUpdates({ source });
      inboxFile = resolveDiscordInboxFile(env);
    } else if (provider instanceof SlackProvider) {
      if (!source) {
        throw new Error("source (channel id) is required for slack");
      }
      inbound = await provider.pollUpdates({ source });
      inboxFile = resolveSlackInboxFile(env);
    } else {
      throw new Error(`poll_now is not supported for provider: ${providerId} (LINE uses webhooks; call inbox directly)`);
    }
    for (const message of inbound) {
      await appendInbound(inboxFile, message);
    }
    return { ingested: inbound.length };
  };

  const discordChannelsForPollAll = parseCsv(env.MUSE_DISCORD_POLL_CHANNELS) ?? [];
  const slackChannelsForPollAll = parseCsv(env.MUSE_SLACK_POLL_CHANNELS) ?? [];
  const pollAll = async (): Promise<{
    ingestedByProvider: Record<string, number>;
    errors: { providerId: string; message: string }[];
  }> => {
    const ingestedByProvider: Record<string, number> = {};
    const errors: { providerId: string; message: string }[] = [];
    for (const provider of messagingRegistry.list()) {
      if (provider instanceof TelegramProvider) {
        try {
          const got = await pollNow("telegram");
          ingestedByProvider["telegram"] = got.ingested;
        } catch (cause) {
          errors.push({ message: errorMessage(cause), providerId: "telegram" });
        }
      } else if (provider instanceof DiscordProvider) {
        let total = 0;
        for (const channel of discordChannelsForPollAll) {
          try {
            const got = await pollNow("discord", channel);
            total += got.ingested;
          } catch (cause) {
            errors.push({
              message: `channel ${channel}: ${errorMessage(cause)}`,
              providerId: "discord"
            });
          }
        }
        ingestedByProvider["discord"] = total;
      } else if (provider instanceof SlackProvider) {
        let total = 0;
        for (const channel of slackChannelsForPollAll) {
          try {
            const got = await pollNow("slack", channel);
            total += got.ingested;
          } catch (cause) {
            errors.push({
              message: `channel ${channel}: ${errorMessage(cause)}`,
              providerId: "slack"
            });
          }
        }
        ingestedByProvider["slack"] = total;
      }
      // LINE intentionally skipped — webhook-fed, nothing to poll.
    }
    return { errors, ingestedByProvider };
  };

  return { pollAll, pollNow };
}
