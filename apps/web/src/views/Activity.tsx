import { useState } from "react";

import { useQuery } from "@tanstack/react-query";

import { AsyncBlock, Badge, Card, Icon } from "../components/ui.js";
import { useI18n, type StringKey, type Translate } from "../i18n/index.js";

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

export const ACTIVITY_FILTER_KINDS = ["reminder", "proactive", "followup", "pattern", "episode"] as const;
export type ActivityFilterKind = (typeof ACTIVITY_FILTER_KINDS)[number];

const KIND_LABEL_KEYS: Record<ActivityFilterKind, StringKey> = {
  episode: "activity.kind.episode",
  followup: "activity.kind.followup",
  pattern: "activity.kind.pattern",
  proactive: "activity.kind.proactive",
  reminder: "activity.kind.reminder"
};

function kindLabel(kind: string, t: Translate): string {
  return kind in KIND_LABEL_KEYS ? t(KIND_LABEL_KEYS[kind as ActivityFilterKind]) : kind;
}

/** `GET /api/history` URL for a filter selection — "all" omits the `kind`
 * param entirely (server default: every source); any other value is the
 * validated `ActivityKind` literal, URL-encoded. Pure so it's unit-testable
 * without a query-client render. */
export function historyQueryPath(kind: string): string {
  return kind === "all" ? "/api/history?limit=25" : `/api/history?limit=25&kind=${encodeURIComponent(kind)}`;
}

export function ActivityView({ client }: { client: ApiClient }) {
  const { locale, t } = useI18n();
  const [kind, setKind] = useState<string>("all");
  const history = useQuery({
    queryFn: () => client.get<HistoryResponse>(historyQueryPath(kind)),
    queryKey: ["history", client.baseUrl, kind]
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
          <div className="segmented" role="group" aria-label={t("activity.filter.label")} style={{ marginBottom: 12, display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              type="button"
              className={`chip${kind === "all" ? " chip-active" : ""}`}
              aria-pressed={kind === "all"}
              onClick={() => setKind("all")}
            >
              {t("activity.filter.all")}
            </button>
            {ACTIVITY_FILTER_KINDS.map((k) => (
              <button
                type="button"
                key={k}
                className={`chip${kind === k ? " chip-active" : ""}`}
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
              >
                {kindLabel(k, t)}
              </button>
            ))}
          </div>
          <AsyncBlock loading={history.isLoading} error={history.error} empty={runs.length === 0} emptyLabel={t("act.runsEmpty")} emptyHint={t("act.runsEmptyHint")} emptyIcon={<Icon.activity />}>
            {runs.map((r, i) => (
              <div className="row" key={r.id ?? r.runId ?? i}>
                <div className="row-main">
                  <div className="row-title">{r.summary ?? r.inputPreview ?? r.outputPreview ?? r.runId ?? "run"}</div>
                  <div className="row-meta">
                    {r.kind ? kindLabel(r.kind, t) : (r.model ?? "—")}
                    {r.whenIso || r.startedAt ? ` · ${new Date(r.whenIso ?? r.startedAt ?? "").toLocaleString(locale)}` : ""}
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
          <AsyncBlock loading={proactive.isLoading} error={proactive.error} empty={notices.length === 0} emptyLabel={t("act.noticesEmpty")} emptyHint={t("act.noticesEmptyHint")} emptyIcon={<Icon.bell />}>
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
