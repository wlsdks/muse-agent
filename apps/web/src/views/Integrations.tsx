import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { AsyncBlock, Badge, Button, Card, Icon, Tooltip } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";
import { canDisconnect, providerStatus } from "./integrations-logic.js";

import type { ApiClient } from "../api/client.js";
import type { StringKey } from "../i18n/strings.js";
import type { DaemonFlagsResponse, MessagingConnectResponse, MessagingSetupProvider, MessagingSetupResponse } from "../api/types.js";

const GUIDE_STEPS: Readonly<Record<string, number>> = { discord: 4, line: 3, slack: 4, telegram: 3 };
const DAEMON_KEYS = ["MUSE_TELEGRAM_POLL_ENABLED", "MUSE_INBOUND_REPLY_ENABLED"] as const;

/**
 * Integrations — connect external messaging channels with one paste + click.
 * The token is verified LIVE against the provider's own identity endpoint
 * before it is saved (fail-close: an invalid token saves nothing), stored in
 * `~/.muse/messaging.json` (chmod 600), and hot-registered so sending works
 * without a server restart. The token itself is never echoed back here.
 */
export function IntegrationsView({ client }: { client: ApiClient }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const setup = useQuery({
    queryFn: () => client.get<MessagingSetupResponse>("/api/messaging/setup"),
    queryKey: ["messaging-setup", client.baseUrl]
  });
  const daemons = useQuery({
    queryFn: () => client.get<DaemonFlagsResponse>("/api/settings/daemon-flags"),
    queryKey: ["daemon-flags", client.baseUrl]
  });

  const daemonFlags = (daemons.data?.flags ?? []).filter((flag) =>
    (DAEMON_KEYS as readonly string[]).includes(flag.key)
  );

  return (
    <div className="content-narrow">
      <p className="eyebrow">{t("group.workspace")}</p>
      <h1 className="page-title">{t("nav.integrations")}</h1>
      <p className="muted" style={{ marginTop: 4 }}>
        {t("int.subtitle")}
      </p>

      <Card title={t("int.how")} className="lifted" >
        <p className="subtle" style={{ fontSize: 13, margin: 0 }}>
          {t("int.explain.flow")}
        </p>
        <p className="subtle" style={{ fontSize: 13, marginBottom: 0 }}>
          <Icon.shield className="nav-icon" /> {t("int.explain.safety")}
        </p>
      </Card>

      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <AsyncBlock loading={setup.isLoading} error={setup.error} empty={false}>
          {(setup.data?.providers ?? []).map((provider) => (
            <ProviderCard
              key={provider.id}
              client={client}
              provider={provider}
              onChanged={() => void queryClient.invalidateQueries({ queryKey: ["messaging-setup", client.baseUrl] })}
            />
          ))}
        </AsyncBlock>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t("int.daemons")}>
          <p className="subtle" style={{ fontSize: 13, marginTop: 0 }}>
            {t("int.daemons.sub")}
          </p>
          <AsyncBlock loading={daemons.isLoading} error={daemons.error} empty={daemonFlags.length === 0}>
            {daemonFlags.map((flag) => (
              <div className="row" key={flag.key}>
                <div className="row-main">
                  <div className="row-title">
                    {t(flag.key === "MUSE_TELEGRAM_POLL_ENABLED" ? "int.daemon.poll" : "int.daemon.reply")}
                    {" "}
                    <Tooltip tip={t(flag.key === "MUSE_TELEGRAM_POLL_ENABLED" ? "int.tip.daemon.poll" : "int.tip.daemon.reply")}>
                      <Icon.alert className="nav-icon" aria-hidden />
                    </Tooltip>
                  </div>
                  <div className="row-meta mono">{flag.key}</div>
                </div>
                <Badge tone={flag.enabled ? "ok" : "neutral"}>
                  {t(flag.enabled ? "int.daemon.on" : "int.daemon.off")}
                </Badge>
              </div>
            ))}
          </AsyncBlock>
        </Card>
      </div>

      <p className="subtle" style={{ fontSize: 12, marginTop: 12 }}>
        {t("int.security")}
      </p>
    </div>
  );
}

function ProviderCard({
  client,
  provider,
  onChanged
}: {
  client: ApiClient;
  provider: MessagingSetupProvider;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [token, setToken] = useState("");
  const [account, setAccount] = useState<string | null>(null);
  const status = providerStatus(provider);

  const connect = useMutation({
    mutationFn: () => client.post<MessagingConnectResponse>(`/api/messaging/setup/${provider.id}`, { token: token.trim() }),
    onSuccess: (response) => {
      setToken("");
      setAccount(response.account ?? null);
      onChanged();
    }
  });
  const disconnect = useMutation({
    mutationFn: () => client.del(`/api/messaging/setup/${provider.id}`),
    onSuccess: () => {
      setAccount(null);
      onChanged();
    }
  });

  const stepCount = GUIDE_STEPS[provider.id] ?? 0;
  const steps = Array.from({ length: stepCount }, (_, i) => t(`int.step.${provider.id}.${(i + 1).toString()}` as StringKey));

  return (
    <Card
      title={provider.displayName}
      action={
        <Tooltip tip={t(statusTip(status.labelKey))}>
          <Badge tone={status.tone}>{t(status.labelKey)}</Badge>
        </Tooltip>
      }
    >
      <p className="subtle" style={{ fontSize: 13, marginTop: 0 }}>
        {t(`int.desc.${provider.id}` as StringKey)}
      </p>

      {account && (
        <div className="banner" style={{ marginBottom: 10 }}>
          <Icon.check className="nav-icon" /> {t("int.connectedAs", { account })}
        </div>
      )}

      {steps.length > 0 && (
        <details style={{ marginBottom: 10 }}>
          <summary className="field-label" style={{ cursor: "pointer" }}>
            {t("int.guide")}
          </summary>
          <ol style={{ fontSize: 13, margin: "8px 0 0", paddingLeft: 20 }}>
            {steps.map((step, i) => (
              <li key={i} style={{ marginBottom: 4 }}>
                {step}
              </li>
            ))}
          </ol>
          <a className="subtle" href={provider.docsUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
            {t("int.docs")} ↗
          </a>
        </details>
      )}

      <div style={{ display: "grid", gap: 8 }}>
        <div style={{ alignItems: "center", display: "flex", gap: 8 }}>
          <input
            id={`int-token-${provider.id}`}
            aria-label={t("int.token")}
            className="input"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder={t("int.tokenPlaceholder")}
          />
          <Tooltip tip={t("int.tip.connect")}>
            <Button
              variant="primary"
              size="sm"
              disabled={token.trim().length === 0 || connect.isPending}
              onClick={() => connect.mutate()}
            >
              {connect.isPending ? t("int.connecting") : t("int.connect")}
            </Button>
          </Tooltip>
        </div>

        {connect.error && <div className="banner err">{(connect.error as Error).message}</div>}
        {disconnect.error && <div className="banner err">{(disconnect.error as Error).message}</div>}

        {provider.configured && (
          <div>
            {canDisconnect(provider) ? (
              <Tooltip tip={t("int.tip.disconnect")}>
                <Button variant="ghost" size="sm" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
                  <Icon.trash className="nav-icon" /> {t("int.disconnect")}
                </Button>
              </Tooltip>
            ) : (
              <Tooltip tip={t("int.tip.envDisconnect")}>
                <span>
                  <Button variant="ghost" size="sm" disabled>
                    <Icon.trash className="nav-icon" /> {t("int.disconnect")}
                  </Button>
                </span>
              </Tooltip>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function statusTip(labelKey: string): StringKey {
  switch (labelKey) {
    case "int.status.connectedEnv":
      return "int.tip.env";
    case "int.status.savedNotLive":
      return "int.tip.savedNotLive";
    case "int.status.connected":
      return "int.tip.connected";
    default:
      return "int.tip.notConnected";
  }
}
