import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { AsyncBlock, Badge, Button, Card, Icon, Tooltip } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";
import { severityTone, sortChecks, worstSeverity } from "./doctor-logic.js";
import { canDisconnect, daemonBadge, emailStatusView, providerStatus, requiresHomeserver, schedulerDeliveryValue } from "./integrations-logic.js";
import { errorMessage } from "../lib/error-message.js";

import type { ApiClient } from "../api/client.js";
import type { Translate } from "../i18n/index.js";
import type { StringKey } from "../i18n/strings.js";
import type { DaemonFlagsResponse, DoctorResponse, EmailStatusResponse, MessagingConnectResponse, MessagingSetupProvider, MessagingSetupResponse } from "../api/types.js";

const GUIDE_STEPS: Readonly<Record<string, number>> = { discord: 4, line: 3, matrix: 3, slack: 4, telegram: 3 };
const DAEMON_KEYS = ["MUSE_TELEGRAM_POLL_ENABLED", "MUSE_MATRIX_POLL_ENABLED", "MUSE_INBOUND_REPLY_ENABLED"] as const;
const DAEMON_LABEL_KEYS: Readonly<Record<string, StringKey>> = {
  MUSE_INBOUND_REPLY_ENABLED: "int.daemon.reply",
  MUSE_MATRIX_POLL_ENABLED: "int.daemon.matrixSync",
  MUSE_TELEGRAM_POLL_ENABLED: "int.daemon.poll"
};
const DAEMON_TIP_KEYS: Readonly<Record<string, StringKey>> = {
  MUSE_INBOUND_REPLY_ENABLED: "int.tip.daemon.reply",
  MUSE_MATRIX_POLL_ENABLED: "int.tip.daemon.matrix",
  MUSE_TELEGRAM_POLL_ENABLED: "int.tip.daemon.poll"
};

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
  const email = useQuery({
    queryFn: () => client.get<EmailStatusResponse>("/api/email/status"),
    queryKey: ["email-status", client.baseUrl]
  });

  const daemonFlags = (daemons.data?.flags ?? []).filter((flag) =>
    (DAEMON_KEYS as readonly string[]).includes(flag.key)
  );
  const [restartNote, setRestartNote] = useState<string | null>(null);
  const toggleDaemon = useMutation({
    mutationFn: (input: { key: string; enabled: boolean }) =>
      client.patch<{ appliedLive: boolean }>("/api/settings/daemon-flags", { enabled: input.enabled, key: input.key }),
    onSuccess: (result, input) => {
      setRestartNote(result.appliedLive ? null : input.key);
      void queryClient.invalidateQueries({ queryKey: ["daemon-flags", client.baseUrl] });
    }
  });

  return (
    <div className="content-narrow">
      <p className="eyebrow">{t("group.workspace")}</p>
      <h1 className="page-title">{t("nav.integrations")}</h1>
      <p className="muted" style={{ marginTop: 4 }}>
        {t("int.subtitle")}
      </p>

      <div style={{ marginBottom: 16, marginTop: 16 }}>
        <DoctorCard client={client} />
      </div>

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
        <AsyncBlock loading={email.isLoading} error={email.error} empty={false}>
          <EmailStatusCard status={email.data} t={t} />
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
                    {t(DAEMON_LABEL_KEYS[flag.key] ?? "int.daemon.reply")}
                    {" "}
                    <Tooltip tip={t(DAEMON_TIP_KEYS[flag.key] ?? "int.tip.daemon.reply")}>
                      <Icon.alert className="nav-icon" aria-hidden />
                    </Tooltip>
                  </div>
                  <div className="row-meta mono">{flag.key}</div>
                  {flag.lastIngestAtIso && (
                    <div className="row-meta">{t("int.daemon.lastIngest", { time: new Date(flag.lastIngestAtIso).toLocaleTimeString() })}</div>
                  )}
                  {flag.lastError && <div className="row-meta" style={{ color: "var(--danger)" }}>{t("int.daemon.lastError", { error: flag.lastError })}</div>}
                </div>
                <div style={{ alignItems: "center", display: "flex", gap: 8 }}>
                  {restartNote === flag.key && <span className="subtle" style={{ fontSize: 12 }}>{t("int.daemon.appliedRestart")}</span>}
                  <Tooltip tip={t(daemonBadge(flag).tone === "warn" ? "int.tip.daemon.notRunning" : "int.tip.daemon.state")}>
                    <Badge tone={daemonBadge(flag).tone}>{t(daemonBadge(flag).labelKey)}</Badge>
                  </Tooltip>
                  <Tooltip tip={t("int.tip.daemon.toggle")}>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={toggleDaemon.isPending}
                      onClick={() => toggleDaemon.mutate({ enabled: !flag.enabled, key: flag.key })}
                    >
                      {t(flag.enabled ? "int.daemon.turnOff" : "int.daemon.turnOn")}
                    </Button>
                  </Tooltip>
                </div>
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

/**
 * One-click self-diagnosis: the deterministic /api/doctor checks with a
 * fix button per repairable issue (e.g. "channel connected but the reply
 * daemon is off — Muse reads but never answers"). The fix POST reuses the
 * same persist+live-apply seam as the daemon toggles below.
 */
function DoctorCard({ client }: { client: ApiClient }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const doctor = useQuery({
    queryFn: () => client.get<DoctorResponse>("/api/doctor"),
    queryKey: ["doctor", client.baseUrl],
    refetchInterval: 60_000
  });
  const fix = useMutation({
    mutationFn: (fixId: string) => client.post<{ appliedLive: boolean }>("/api/doctor/fix", { id: fixId }),
    onSuccess: () => {
      for (const key of ["doctor", "daemon-flags", "messaging-setup"]) {
        void queryClient.invalidateQueries({ queryKey: [key, client.baseUrl] });
      }
    }
  });

  const checks = sortChecks(doctor.data?.checks ?? []);
  const overall = worstSeverity(checks);
  const issueCount = checks.filter((check) => check.severity !== "ok").length;

  return (
    <Card
      title={t("int.doctor")}
      className="lifted"
      action={
        <div style={{ alignItems: "center", display: "flex", gap: 8 }}>
          {doctor.data && (
            <Badge tone={severityTone(overall)}>
              {overall === "ok" ? t("int.doctor.healthy") : t("int.doctor.issues", { n: String(issueCount) })}
            </Badge>
          )}
          <Button variant="ghost" size="sm" disabled={doctor.isFetching} onClick={() => void doctor.refetch()}>
            {t("int.doctor.rerun")}
          </Button>
        </div>
      }
    >
      <p className="subtle" style={{ fontSize: 13, marginTop: 0 }}>
        {t("int.doctor.sub")}
      </p>
      <AsyncBlock loading={doctor.isLoading} error={doctor.error} empty={checks.length === 0}>
        {checks.map((check) => (
          <div className="row" key={check.id}>
            <div className="row-main">
              <div className="row-title">{check.title}</div>
              <div className="row-meta">{check.detail}</div>
            </div>
            <div style={{ alignItems: "center", display: "flex", gap: 8 }}>
              <Badge tone={severityTone(check.severity)} dot={check.severity !== "ok"}>
                {check.severity === "ok" ? "OK" : check.severity === "warn" ? "!" : "!!"}
              </Badge>
              {check.fix && (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={fix.isPending}
                  onClick={() => fix.mutate(check.fix?.id ?? "")}
                >
                  {fix.isPending ? t("int.doctor.fixing") : check.fix.label}
                </Button>
              )}
            </div>
          </div>
        ))}
      </AsyncBlock>
      {doctor.data && (
        <p className="subtle mono" style={{ fontSize: 11, marginBottom: 0, marginTop: 10 }}>
          server {doctor.data.version} · pid {doctor.data.pid.toString()}
        </p>
      )}
    </Card>
  );
}

/**
 * Gmail connection status — read-only. The OAuth flow itself only runs from
 * the CLI (`muse setup email` needs the Mac's own browser for the Google
 * consent screen); this card exists so "is my email connected?" has an
 * answer without a terminal round-trip.
 */
export function EmailStatusCard({ status, t }: { status: EmailStatusResponse | undefined; t: Translate }) {
  const view = emailStatusView(status);
  return (
    <Card
      title={t("int.email.title")}
      action={<Badge tone={view.tone}>{t(view.tone === "neutral" ? "int.status.notConnected" : "int.status.connected")}</Badge>}
    >
      <p className="subtle" style={{ fontSize: 13, margin: 0 }}>
        {t(view.messageKey)}
      </p>
    </Card>
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
  const [homeserver, setHomeserver] = useState("");
  const [account, setAccount] = useState<string | null>(null);
  const status = providerStatus(provider);
  const needsHomeserver = requiresHomeserver(provider.id);

  const connect = useMutation({
    mutationFn: () => client.post<MessagingConnectResponse>(`/api/messaging/setup/${provider.id}`, {
      token: token.trim(),
      ...(needsHomeserver ? { homeserverUrl: homeserver.trim() } : {})
    }),
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
  const testSend = useMutation({
    mutationFn: () => client.post<{ ok: boolean; destination: string }>(`/api/messaging/setup/${provider.id}/test-send`)
  });
  const [pairingReset, setPairingReset] = useState(false);
  const resetPairing = useMutation({
    mutationFn: () => client.del(`/api/messaging/setup/${provider.id}/pairing`),
    onSuccess: () => {
      setPairingReset(true);
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
        {needsHomeserver && (
          <input
            id={`int-homeserver-${provider.id}`}
            aria-label={t("int.homeserver")}
            className="input"
            type="url"
            autoComplete="off"
            value={homeserver}
            onChange={(event) => setHomeserver(event.target.value)}
            placeholder={t("int.homeserverPlaceholder")}
          />
        )}
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
              disabled={token.trim().length === 0 || (needsHomeserver && homeserver.trim().length === 0) || connect.isPending}
              onClick={() => connect.mutate()}
            >
              {connect.isPending ? t("int.connecting") : t("int.connect")}
            </Button>
          </Tooltip>
        </div>

        {connect.error && <div className="banner err">{errorMessage(connect.error)}</div>}
        {disconnect.error && <div className="banner err">{errorMessage(disconnect.error)}</div>}

        {provider.configured && provider.registered && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <Tooltip tip={t("int.tip.testSend")}>
              <Button variant="ghost" size="sm" disabled={testSend.isPending} onClick={() => testSend.mutate()}>
                <Icon.send className="nav-icon" /> {testSend.isPending ? t("int.testSending") : t("int.testSend")}
              </Button>
            </Tooltip>
            {testSend.data && <Badge tone="ok">{t("int.testSent", { destination: testSend.data.destination })}</Badge>}
          </div>
        )}
        {testSend.error && <div className="banner err">{errorMessage(testSend.error)}</div>}

        {provider.configured && (
          <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 8 }}>
            <Tooltip tip={t("int.tip.pairing")}>
              <span className="subtle" style={{ fontSize: 12 }}>
                {provider.pairedOwner
                  ? t("int.pairing.owner", { owner: provider.pairedOwner })
                  : t("int.pairing.none")}
              </span>
            </Tooltip>
            {provider.pairedOwner && (
              <Tooltip tip={t("int.tip.pairingReset")}>
                <Button variant="ghost" size="sm" disabled={resetPairing.isPending} onClick={() => resetPairing.mutate()}>
                  {t("int.pairing.reset")}
                </Button>
              </Tooltip>
            )}
          </div>
        )}
        {provider.pairedOwner && (
          <p className="subtle mono" style={{ fontSize: 12, margin: 0, userSelect: "all" }}>
            {t("int.delivery.hint", { value: schedulerDeliveryValue(provider.id, provider.pairedOwner) })}
          </p>
        )}
        {provider.configured && !provider.pairedOwner && provider.pairingCode && (
          <div className="banner" style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 8 }}>
            <span>{t("int.pairing.code", { code: provider.pairingCode })}</span>
          </div>
        )}
        {pairingReset && !provider.pairedOwner && <div className="banner">{t("int.pairing.resetDone")}</div>}
        {resetPairing.error && <div className="banner err">{errorMessage(resetPairing.error)}</div>}
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
