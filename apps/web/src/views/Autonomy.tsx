import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { AsyncBlock, Badge, Card } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";
import { safeDateTime } from "../lib/datetime.js";

import type { ApiClient } from "../api/client.js";
import type { ActionsResponse, ObjectivesResponse, VetoesResponse } from "../api/types.js";
import type { StringKey } from "../i18n/index.js";

type Tab = "actions" | "objectives" | "vetoes";
const TABS: readonly { id: Tab; labelKey: StringKey }[] = [
  { id: "actions", labelKey: "auto.tab.actions" },
  { id: "objectives", labelKey: "auto.tab.objectives" },
  { id: "vetoes", labelKey: "auto.tab.vetoes" }
];

function resultTone(result: string): "ok" | "warn" | "err" | "neutral" {
  if (result === "performed") return "ok";
  if (result === "refused") return "warn";
  if (result === "failed") return "err";
  return "neutral";
}
function statusTone(status: string): "ok" | "accent" | "neutral" {
  if (status === "done") return "ok";
  if (status === "active") return "accent";
  return "neutral";
}

export function AutonomyView({ client }: { client: ApiClient }) {
  const { locale, t } = useI18n();
  const [tab, setTab] = useState<Tab>("actions");

  return (
    <div className="content-narrow">
      <p className="eyebrow">{t("group.system")}</p>
      <h1 className="page-title">{t("nav.autonomy")}</h1>
      <p className="muted" style={{ marginTop: 4 }}>
        {t("auto.subtitle")}
      </p>

      <div className="tabs" style={{ margin: "16px 0" }}>
        {TABS.map((entry) => (
          <button
            key={entry.id}
            className={`tab${tab === entry.id ? " active" : ""}`}
            onClick={() => setTab(entry.id)}
          >
            {t(entry.labelKey)}
          </button>
        ))}
      </div>

      {tab === "actions" && <ActionsTab client={client} locale={locale} />}
      {tab === "objectives" && <ObjectivesTab client={client} locale={locale} />}
      {tab === "vetoes" && <VetoesTab client={client} locale={locale} />}
    </div>
  );
}

function ActionsTab({ client, locale }: { client: ApiClient; locale: string }) {
  const { t } = useI18n();
  const q = useQuery({
    queryFn: () => client.get<ActionsResponse>("/api/actions?limit=100"),
    queryKey: ["actions", client.baseUrl]
  });
  const list = q.data?.actions ?? [];
  return (
    <Card title={t("auto.tab.actions")} count={q.data?.total ?? 0}>
      <AsyncBlock loading={q.isLoading} error={q.error} empty={list.length === 0}>
        {list.map((a) => (
          <div className="row" key={a.id}>
            <div className="row-main">
              <div className="row-title">{a.what}</div>
              <div className="row-meta">
                {a.why}
                {a.detail ? ` · ${a.detail}` : ""} · {new Date(a.when).toLocaleString(locale)}
              </div>
            </div>
            <Badge tone={resultTone(a.result)}>{a.result}</Badge>
          </div>
        ))}
      </AsyncBlock>
    </Card>
  );
}

function ObjectivesTab({ client, locale }: { client: ApiClient; locale: string }) {
  const { t } = useI18n();
  const q = useQuery({
    queryFn: () => client.get<ObjectivesResponse>("/api/objectives"),
    queryKey: ["objectives", client.baseUrl]
  });
  const list = q.data?.objectives ?? [];
  return (
    <Card title={t("auto.tab.objectives")} count={q.data?.total ?? 0}>
      <p className="subtle" style={{ fontSize: 12, marginTop: -4, marginBottom: 12 }}>
        {t("auto.objNote")}
      </p>
      <AsyncBlock loading={q.isLoading} error={q.error} empty={list.length === 0}>
        {list.map((o) => (
          <div className="row" key={o.id}>
            <div className="row-main">
              <div className="row-title">{o.spec}</div>
              <div className="row-meta">
                {o.kind} · {new Date(o.createdAt).toLocaleDateString(locale)}
                {o.resolution ? ` · ${o.resolution}` : ""}
              </div>
            </div>
            <Badge tone={statusTone(o.status)}>{o.status}</Badge>
          </div>
        ))}
      </AsyncBlock>
    </Card>
  );
}

function VetoesTab({ client, locale }: { client: ApiClient; locale: string }) {
  const { t } = useI18n();
  const q = useQuery({
    queryFn: () => client.get<VetoesResponse>("/api/vetoes"),
    queryKey: ["vetoes", client.baseUrl]
  });
  const list = q.data?.vetoes ?? [];
  return (
    <Card title={t("auto.tab.vetoes")} count={q.data?.total ?? 0}>
      <p className="subtle" style={{ fontSize: 12, marginTop: -4, marginBottom: 12 }}>
        {t("auto.vetoNote")}
      </p>
      <AsyncBlock loading={q.isLoading} error={q.error} empty={list.length === 0}>
        {list.map((v) => (
          <div className="row" key={v.id}>
            <div className="row-main">
              <div className="row-title">{v.scope}</div>
              <div className="row-meta">
                {v.reason ? `${v.reason} · ` : ""}
                {safeDateTime(v.vetoedAt, locale)}
              </div>
            </div>
            <Badge tone="warn">veto</Badge>
          </div>
        ))}
      </AsyncBlock>
    </Card>
  );
}
