import { useQuery } from "@tanstack/react-query";

import { deriveNotifyChannelOptions } from "./flow-notify-channels.js";
import { useI18n } from "../i18n/index.js";

import type { ApiClient } from "../api/client.js";
import type { MessagingSetupResponse } from "../api/types.js";

/**
 * Convenience picker shown above the notify text field: when the user has
 * messaging providers connected AND paired, offer them as ready-made
 * channels so choosing one fills in the exact `provider:destination` value —
 * no id to look up. Renders NOTHING when no deliverable channel exists
 * (local-only mode, or nothing paired yet), leaving the raw text field as
 * the sole input and source of truth in that case.
 */
export function NotifyChannelQuickPick({
  client,
  onPick
}: {
  client: ApiClient;
  onPick: (value: string) => void;
}) {
  const { t } = useI18n();
  const setup = useQuery({
    queryFn: () => client.get<MessagingSetupResponse>("/api/messaging/setup"),
    queryKey: ["messaging-setup", client.baseUrl],
    retry: 0,
    staleTime: 30_000
  });

  const options = deriveNotifyChannelOptions(setup.data);
  if (options.length === 0) {
    return null;
  }

  return (
    <select
      className="input"
      aria-label={t("auto.flows.notify.pickLabel")}
      value=""
      onChange={(event) => {
        if (event.target.value) {
          onPick(event.target.value);
        }
      }}
    >
      <option value="">{t("auto.flows.notify.pickPlaceholder")}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.displayName} · {option.destination}
        </option>
      ))}
    </select>
  );
}
