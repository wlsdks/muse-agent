import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { AsyncBlock, Badge, Button, Card } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";

import type { ApiClient } from "../api/client.js";
import type { DaemonFlagsResponse, ModelsResponse } from "../api/types.js";
import { summarizeFlags } from "./settings-flags.js";

interface SetupSection {
  readonly ok?: boolean;
  readonly ready?: boolean;
  readonly configured?: boolean;
}
type SetupStatus = Record<string, SetupSection & Record<string, unknown>> & {
  readonly model?: { readonly muse_model?: string; readonly providerKeys?: readonly string[] } & SetupSection;
};

export function SettingsView({
  client,
  apiUrl = "",
  token = "",
  onSave
}: {
  client: ApiClient;
  apiUrl?: string;
  token?: string;
  onSave?: (url: string, token: string) => void;
}) {
  const { lang, setLang, t } = useI18n();
  const [url, setUrl] = useState(apiUrl);
  const [tok, setTok] = useState(token);

  const setup = useQuery({
    queryFn: () => client.get<SetupStatus>("/api/setup/status"),
    queryKey: ["setup", client.baseUrl]
  });
  const models = useQuery({
    queryFn: () => client.get<ModelsResponse>("/api/models"),
    queryKey: ["models", client.baseUrl]
  });
  const daemonFlags = useQuery({
    queryFn: () => client.get<DaemonFlagsResponse>("/api/settings/daemon-flags"),
    queryKey: ["daemon-flags", client.baseUrl]
  });

  const sectionOk = (s?: SetupSection) => Boolean(s?.ok ?? s?.ready ?? s?.configured);
  const setupRows: readonly [string, SetupSection | undefined][] = setup.data
    ? (["model", "mcp", "notes", "tasks", "voice", "messaging", "proactive"] as const).map((k) => [
        k,
        setup.data?.[k] as SetupSection | undefined
      ])
    : [];

  return (
    <div className="content-narrow">
      <p className="eyebrow">{t("group.system")}</p>
      <h1 className="page-title">{t("settings.title")}</h1>

      <Card title={t("settings.connection")} className="lifted">
        <div style={{ display: "grid", gap: 12 }}>
          <div>
            <label className="field-label">{t("settings.apiUrl")}</label>
            <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://127.0.0.1:3030" />
          </div>
          <div>
            <label className="field-label">{t("settings.token")}</label>
            <input className="input" value={tok} onChange={(e) => setTok(e.target.value)} placeholder={t("settings.tokenPlaceholder")} />
          </div>
          <div>
            <Button variant="primary" onClick={() => onSave?.(url.trim(), tok.trim())}>
              {t("common.save")}
            </Button>
          </div>
        </div>
      </Card>

      <div style={{ marginTop: 16 }}>
        <Card title={t("settings.language")}>
          <div className="row" style={{ borderBottom: "none" }}>
            <div className="row-main">
              <div className="row-title">{lang === "ko" ? "한국어" : "English"}</div>
            </div>
            <div className="lang-toggle">
              <button className={lang === "en" ? "active" : ""} onClick={() => setLang("en")}>
                English
              </button>
              <button className={lang === "ko" ? "active" : ""} onClick={() => setLang("ko")}>
                한국어
              </button>
            </div>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t("settings.activeModel")}>
          <AsyncBlock loading={models.isLoading} error={models.error}>
            <div className="row">
              <div className="row-main">
                <div className="row-title mono">
                  {(setup.data?.model?.muse_model as string) ?? models.data?.active ?? "—"}
                </div>
                <div className="row-meta">{t("settings.modelsAvailable", { n: models.data?.models?.length ?? 0 })}</div>
              </div>
              <Badge tone="accent" dot={false}>
                local
              </Badge>
            </div>
          </AsyncBlock>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t("settings.setupStatus")}>
          <AsyncBlock loading={setup.isLoading} error={setup.error} empty={setupRows.length === 0}>
            {setupRows.map(([name, section]) => (
              <div className="row" key={name}>
                <div className="row-main">
                  <div className="row-title" style={{ textTransform: "capitalize" }}>
                    {name}
                  </div>
                </div>
                <Badge tone={sectionOk(section) ? "ok" : "neutral"}>
                  {sectionOk(section) ? t("settings.ready") : t("settings.notSet")}
                </Badge>
              </div>
            ))}
          </AsyncBlock>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t("settings.daemons")}>
          {(() => {
            const flags = daemonFlags.data?.flags ?? [];
            const sum = summarizeFlags(flags);
            return (
              <>
                <p className="subtle" style={{ marginBottom: 8, fontSize: 12 }}>
                  {t("settings.daemonsSummary", { enabled: sum.enabled, total: sum.total })}
                </p>
                <AsyncBlock loading={daemonFlags.isLoading} error={daemonFlags.error} empty={flags.length === 0}>
                  {flags.map((flag) => (
                    <div className="row" key={flag.key}>
                      <div className="row-main">
                        <div className="row-title">{flag.label}</div>
                      </div>
                      <Badge tone={flag.enabled ? "ok" : "neutral"}>
                        {flag.enabled ? t("settings.on") : t("settings.off")}
                      </Badge>
                    </div>
                  ))}
                </AsyncBlock>
              </>
            );
          })()}
        </Card>
      </div>

      <p className="subtle" style={{ marginTop: 24, fontSize: 12 }}>
        {t("settings.credit")}
      </p>
    </div>
  );
}
