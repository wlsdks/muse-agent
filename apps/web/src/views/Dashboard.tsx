import { useQuery } from "@tanstack/react-query";

import { AsyncBlock, Badge, Card, Stat } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";
import { formatProbabilityPct } from "../lib/percent.js";

import type { ApiClient } from "../api/client.js";
import type { LatencySummary, TokenCostDailyRow, ToolStatsResponse } from "../api/types.js";

function sum(rows: readonly TokenCostDailyRow[], pick: (r: TokenCostDailyRow) => number): number {
  return rows.reduce((acc, r) => acc + pick(r), 0);
}

export { formatProbabilityPct as formatAccuracyPct } from "../lib/percent.js";

export function DashboardView({ client }: { client: ApiClient }) {
  const { locale, t } = useI18n();

  const cost = useQuery({
    queryFn: () => client.get<readonly TokenCostDailyRow[]>("/api/admin/token-cost/daily?days=7"),
    queryKey: ["dash-cost", client.baseUrl]
  });
  const tools = useQuery({
    queryFn: () => client.get<ToolStatsResponse>("/api/admin/tools/stats"),
    queryKey: ["dash-tools", client.baseUrl]
  });
  const latency = useQuery({
    queryFn: () => client.get<LatencySummary>("/api/admin/metrics/latency/summary?days=7"),
    queryKey: ["dash-latency", client.baseUrl]
  });

  const rows = cost.data ?? [];
  const totalTokens = sum(rows, (r) => r.totalTokens ?? 0);
  const totalCost = sum(rows, (r) => r.totalCostUsd ?? 0);

  // Aggregate tokens per day for the bar chart.
  const byDay = new Map<string, number>();
  for (const r of rows) {
    byDay.set(r.day, (byDay.get(r.day) ?? 0) + (r.totalTokens ?? 0));
  }
  const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));
  const maxDay = Math.max(1, ...days.map(([, v]) => v));

  const accuracyPct = formatProbabilityPct(tools.data?.accuracy);
  const topTools = (tools.data?.byTool ?? []).slice(0, 8);

  const anyLoading = cost.isLoading || tools.isLoading || latency.isLoading;
  const anyError = cost.error ?? tools.error ?? latency.error;

  return (
    <div className="content-narrow">
      <p className="eyebrow">{t("group.system")}</p>
      <h1 className="page-title">{t("dash.title")}</h1>
      <p className="muted" style={{ marginTop: 4 }}>
        {t("dash.subtitle")}
      </p>

      <div className="grid grid-3" style={{ margin: "24px 0" }}>
        <Card>
          <Stat value={totalTokens.toLocaleString(locale)} label={t("dash.totalTokens")} />
        </Card>
        <Card>
          <Stat value={`$${totalCost.toFixed(4)}`} label={t("dash.totalCost")} />
        </Card>
        <Card>
          <Stat value={accuracyPct} label={t("dash.toolAccuracy")} />
        </Card>
      </div>

      <AsyncBlock loading={anyLoading} error={anyError}>
        <div className="grid grid-2">
          <Card title={t("dash.tokensPerDay")} count={`${days.length}d`}>
            {days.length === 0 ? (
              <div className="empty">{t("common.empty")}</div>
            ) : (
              <div className="bars">
                {days.map(([day, val]) => (
                  <div className="bar-col" key={day} title={`${day}: ${val.toLocaleString(locale)}`}>
                    <div className="bar" style={{ height: `${Math.max(4, (val / maxDay) * 100)}%` }} />
                    <span className="bar-label">{day.slice(5)}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title={t("dash.latency")}>
            <div className="row">
              <div className="row-main">
                <div className="row-title">p50</div>
              </div>
              <span className="mono">{latency.data?.p50Ms != null ? `${Math.round(latency.data.p50Ms)} ms` : "—"}</span>
            </div>
            <div className="row">
              <div className="row-main">
                <div className="row-title">p95</div>
              </div>
              <span className="mono">{latency.data?.p95Ms != null ? `${Math.round(latency.data.p95Ms)} ms` : "—"}</span>
            </div>
            <div className="row">
              <div className="row-main">
                <div className="row-title">p99</div>
              </div>
              <span className="mono">{latency.data?.p99Ms != null ? `${Math.round(latency.data.p99Ms)} ms` : "—"}</span>
            </div>
            <div className="row">
              <div className="row-main">
                <div className="row-title">{t("dash.samples")}</div>
              </div>
              <span className="mono">{latency.data?.count ?? 0}</span>
            </div>
          </Card>
        </div>

        <div style={{ marginTop: 16 }}>
          <Card title={t("dash.topTools")} count={topTools.length}>
            {topTools.length === 0 ? (
              <div className="empty">{t("common.empty")}</div>
            ) : (
              topTools.map((tool) => (
                <div className="row" key={`${tool.server ?? ""}:${tool.tool}`}>
                  <div className="row-main">
                    <div className="row-title mono">{tool.tool}</div>
                    {tool.server && <div className="row-meta">{tool.server}</div>}
                  </div>
                  {tool.outcome && <Badge tone={tool.outcome === "ok" ? "ok" : "warn"}>{tool.outcome}</Badge>}
                  <span className="mono subtle">{tool.count}</span>
                </div>
              ))
            )}
          </Card>
        </div>
      </AsyncBlock>
    </div>
  );
}
