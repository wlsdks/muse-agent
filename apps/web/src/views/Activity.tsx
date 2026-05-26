import { useQuery } from "@tanstack/react-query";

import { AsyncBlock, Badge, Card } from "../components/ui.js";

import type { ApiClient } from "../api/client.js";
import type { HistoryResponse, ProactiveHistoryResponse } from "../api/types.js";

function statusTone(status?: string): "ok" | "err" | "neutral" {
  if (status === "completed" || status === "success") return "ok";
  if (status === "failed" || status === "error") return "err";
  return "neutral";
}

export function ActivityView({ client }: { client: ApiClient }) {
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
      <p className="eyebrow">Knowledge</p>
      <h1 className="page-title">Activity</h1>

      <div style={{ marginTop: 16 }}>
        <Card title="Recent runs" count={runs.length}>
          <AsyncBlock loading={history.isLoading} error={history.error} empty={runs.length === 0}>
            {runs.map((r, i) => (
              <div className="row" key={r.runId ?? i}>
                <div className="row-main">
                  <div className="row-title">{r.inputPreview ?? r.outputPreview ?? r.runId ?? "run"}</div>
                  <div className="row-meta">
                    {r.model ?? "—"}
                    {r.startedAt ? ` · ${new Date(r.startedAt).toLocaleString()}` : ""}
                  </div>
                </div>
                {r.status && <Badge tone={statusTone(r.status)}>{r.status}</Badge>}
              </div>
            ))}
          </AsyncBlock>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title="Proactive notices" count={notices.length}>
          <AsyncBlock loading={proactive.isLoading} error={proactive.error} empty={notices.length === 0}>
            <div className="notice-feed">
              {notices.map((n, i) => (
                <div className="notice" key={n.id ?? i}>
                  <div className="notice-text">{n.message ?? n.text ?? "(notice)"}</div>
                  {n.createdAt && <div className="notice-time">{new Date(n.createdAt).toLocaleString()}</div>}
                </div>
              ))}
            </div>
          </AsyncBlock>
        </Card>
      </div>
    </div>
  );
}
