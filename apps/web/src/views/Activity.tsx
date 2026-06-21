import { useQuery } from "@tanstack/react-query";

import { AsyncBlock, Badge, Card } from "../components/ui.js";
import { useI18n, type Translate } from "../i18n/index.js";

import type { ApiClient } from "../api/client.js";
import type { HistoryResponse, ProactiveHistoryResponse } from "../api/types.js";

function statusTone(status?: string): "ok" | "err" | "neutral" {
  if (status === "completed" || status === "success" || status === "performed") return "ok";
  if (status === "failed" || status === "error" || status === "refused") return "err";
  return "neutral";
}

/// Localized status label (literal keys keep it type-safe), raw status otherwise.
function statusLabel(status: string, t: Translate): string {
  switch (status) {
    case "completed": return t("actstatus.completed");
    case "success": return t("actstatus.success");
    case "failed": return t("actstatus.failed");
    case "error": return t("actstatus.error");
    case "refused": return t("actstatus.refused");
    case "performed": return t("actstatus.performed");
    case "pending": return t("actstatus.pending");
    default: return status;
  }
}

export function ActivityView({ client }: { client: ApiClient }) {
  const { locale, t } = useI18n();
  const history = useQuery({
    queryFn: () => client.get<HistoryResponse>("/api/history?limit=25"),
    queryKey: ["history", client.baseUrl]
  });
  const proactive = useQuery({
    queryFn: () => client.get<ProactiveHistoryResponse>("/api/proactive/history?limit=15"),
    queryKey: ["proactive-all", client.baseUrl]
  });

  const runs = history.data?.entries ?? history.data?.items ?? [];
  const notices = proactive.data?.entries ?? proactive.data?.items ?? [];

  return (
    <div className="content-narrow">
      <p className="eyebrow">{t("group.knowledge")}</p>
      <h1 className="page-title">{t("activity.title")}</h1>

      <div style={{ marginTop: 16 }}>
        <Card title={t("activity.recentRuns")} count={runs.length}>
          <AsyncBlock loading={history.isLoading} error={history.error} empty={runs.length === 0}>
            {runs.map((r, i) => (
              <div className="row" key={r.runId ?? i}>
                <div className="row-main">
                  <div className="row-title">{r.inputPreview ?? r.outputPreview ?? r.runId ?? "run"}</div>
                  <div className="row-meta">
                    {r.model ?? "—"}
                    {r.startedAt ? ` · ${new Date(r.startedAt).toLocaleString(locale)}` : ""}
                  </div>
                </div>
                {r.status && <Badge tone={statusTone(r.status)}>{statusLabel(r.status, t)}</Badge>}
              </div>
            ))}
          </AsyncBlock>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t("activity.proactive")} count={notices.length}>
          <AsyncBlock loading={proactive.isLoading} error={proactive.error} empty={notices.length === 0}>
            <div className="notice-feed">
              {notices.map((n, i) => (
                <div className="notice" key={n.id ?? i}>
                  <div className="notice-text">{n.message ?? n.text ?? "—"}</div>
                  {n.createdAt && <div className="notice-time">{new Date(n.createdAt).toLocaleString(locale)}</div>}
                </div>
              ))}
            </div>
          </AsyncBlock>
        </Card>
      </div>
    </div>
  );
}
