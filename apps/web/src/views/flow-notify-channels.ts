import { schedulerDeliveryValue } from "./integrations-logic.js";

import type { MessagingSetupResponse } from "../api/types.js";

export interface NotifyChannelOption {
  /** The exact `provider:destination` the scheduler's `parseNotificationChannel` expects. */
  readonly value: string;
  readonly providerId: string;
  readonly displayName: string;
  readonly destination: string;
}

/**
 * Deliverable channels for the Builder's notify picker. Only a provider that
 * is configured AND live-registered AND paired to a known owner chat can
 * actually receive a scheduled result, so ONLY those become options — a
 * saved-but-not-live or unpaired provider would compile to a channel id that
 * fails at send time, so it is never offered. The option `value` is the
 * resolved `provider:destination`, so the user picks a channel by name
 * instead of typing an id they'd have to look up.
 */
export function deriveNotifyChannelOptions(
  setup: MessagingSetupResponse | undefined
): readonly NotifyChannelOption[] {
  if (!setup) {
    return [];
  }
  const options: NotifyChannelOption[] = [];
  for (const provider of setup.providers) {
    const owner = provider.pairedOwner?.trim();
    if (provider.configured && provider.registered && owner) {
      options.push({
        destination: owner,
        displayName: provider.displayName,
        providerId: provider.id,
        value: schedulerDeliveryValue(provider.id, owner)
      });
    }
  }
  return options;
}
