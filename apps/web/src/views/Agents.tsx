import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { AsyncBlock, Badge, Button, Card, Icon } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";

import type { ApiClient } from "../api/client.js";
import type {
  OrchestrateResponse,
  OrchestrationStats,
  OrchestrationsResponse,
  SubAgentRunsResponse,
  SwarmPendingResponse
} from "../api/types.js";

/**
 * Agents — the management surface for Muse's multi-agent machinery.
 * Everything here talks to endpoints the CLI (`muse orchestrate`,
 * `muse swarm`) already uses, so the terminal and this view stay one
 * system: run an orchestration, watch/stop live runs, audit finished
 * ones, and resolve swarm-shared know-how.
 */
export function AgentsView({ client }: { client: ApiClient }) {
  const { t } = useI18n();

  return (
    <div className="content-narrow">
      <p className="eyebrow">{t("group.workspace")}</p>
      <h1 className="page-title">{t("nav.agents")}</h1>
      <p className="muted" style={{ marginTop: 4 }}>
        {t("ag.subtitle")}
      </p>

      <RunCard client={client} />
      <LiveRunsCard client={client} />
      <HistoryCard client={client} />
      <SwarmCard client={client} />
    </div>
  );
}

function RunCard({ client }: { client: ApiClient }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const [mode, setMode] = useState<"sequential" | "parallel">("sequential");
  const [background, setBackground] = useState(true);
  const [outcome, setOutcome] = useState<OrchestrateResponse | null>(null);

  const run = useMutation({
    mutationFn: () =>
      client.post<OrchestrateResponse>("/api/multi-agent/orchestrate", {
        background,
        message: message.trim(),
        mode
      }),
    onSuccess: (result) => {
      setOutcome(result);
      setMessage("");
      for (const key of ["agent-runs", "orchestrations", "orchestration-stats"]) {
        void queryClient.invalidateQueries({ queryKey: [key, client.baseUrl] });
      }
    }
  });

  return (
    <Card title={t("ag.run")} className="lifted">
      <p className="subtle" style={{ fontSize: 12, marginBottom: 10, marginTop: 0 }}>
        {t("ag.run.sub")}
      </p>
      <div style={{ display: "grid", gap: 10 }}>
        <textarea
          className="textarea"
          rows={2}
          value={message}
          placeholder={t("ag.run.placeholder")}
          onChange={(e) => setMessage(e.target.value)}
        />
        <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 10 }}>
          <div className="lang-toggle" role="group" aria-label="mode">
            <button className={mode === "sequential" ? "active" : ""} onClick={() => setMode("sequential")}>
              {t("ag.run.mode.seq")}
            </button>
            <button className={mode === "parallel" ? "active" : ""} onClick={() => setMode("parallel")}>
              {t("ag.run.mode.par")}
            </button>
          </div>
          <label className="subtle" style={{ alignItems: "center", display: "flex", fontSize: 13, gap: 6 }}>
            <input type="checkbox" checked={background} onChange={(e) => setBackground(e.target.checked)} />
            {t("ag.run.background")}
          </label>
          <span style={{ flex: 1 }} />
          <Button variant="primary" disabled={message.trim().length === 0 || run.isPending} onClick={() => run.mutate()}>
            <Icon.send className="nav-icon" /> {run.isPending ? t("ag.run.running") : t("ag.run.go")}
          </Button>
        </div>
        {outcome?.background && <p className="subtle" style={{ fontSize: 13, margin: 0 }}>{t("ag.run.started")}</p>}
        {outcome?.response?.output && (
          <div className="row" style={{ borderBottom: "none" }}>
            <div className="row-main">
              <div className="row-title">{t("ag.result")}</div>
              <div className="row-meta" style={{ whiteSpace: "pre-wrap" }}>{outcome.response.output}</div>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

const runTone = (status: string): "ok" | "warn" | "err" | "neutral" | "accent" =>
  status === "running" ? "accent" : status === "completed" ? "ok" : status === "cancelled" ? "neutral" : "err";

function LiveRunsCard({ client }: { client: ApiClient }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const runs = useQuery({
    queryFn: () => client.get<SubAgentRunsResponse>("/api/multi-agent/runs"),
    queryKey: ["agent-runs", client.baseUrl],
    refetchInterval: 4000
  });
  const cancel = useMutation({
    mutationFn: (runId: string) => client.post<{ cancelled: boolean }>(`/api/multi-agent/runs/${runId}/cancel`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["agent-runs", client.baseUrl] })
  });

  const rows = [...(runs.data?.runs ?? [])].reverse().slice(0, 12);

  return (
    <div style={{ marginTop: 16 }}>
      <Card title={t("ag.live")} count={runs.data?.activeCount ?? 0}>
        <p className="subtle" style={{ fontSize: 12, marginBottom: 8, marginTop: 0 }}>
          {t("ag.live.sub")}
        </p>
        <AsyncBlock
          loading={runs.isLoading}
          error={runs.error}
          empty={rows.length === 0}
          emptyLabel={t("ag.live.empty")}
          emptyHint={t("ag.live.emptyHint")}
          emptyIcon={<Icon.activity />}
        >
          {rows.map((run) => (
            <div className="row" key={run.runId}>
              <div className="row-main">
                <div className="row-title mono" style={{ fontSize: 12 }}>
                  {run.parentRunId ? "└ " : ""}
                  {run.runId}
                </div>
                <div className="row-meta">
                  {new Date(run.startedAt).toLocaleTimeString()}
                  {run.error ? ` · ${run.error}` : ""}
                </div>
              </div>
              <Badge tone={runTone(run.status)}>{run.status}</Badge>
              {run.status === "running" && !run.parentRunId && (
                <Button variant="danger" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate(run.runId)}>
                  {t("ag.live.stop")}
                </Button>
              )}
            </div>
          ))}
        </AsyncBlock>
      </Card>
    </div>
  );
}

function HistoryCard({ client }: { client: ApiClient }) {
  const { t } = useI18n();
  const history = useQuery({
    queryFn: () => client.get<OrchestrationsResponse>("/api/multi-agent/orchestrations?limit=10"),
    queryKey: ["orchestrations", client.baseUrl],
    refetchInterval: 15_000
  });
  const stats = useQuery({
    queryFn: () => client.get<OrchestrationStats>("/api/multi-agent/orchestrations/stats"),
    queryKey: ["orchestration-stats", client.baseUrl],
    refetchInterval: 30_000
  });

  const entries = history.data?.entries ?? [];
  const s = stats.data;

  return (
    <div style={{ marginTop: 16 }}>
      <Card
        title={t("ag.history")}
        action={
          s && s.totalRuns > 0 ? (
            <span className="subtle mono" style={{ fontSize: 11 }}>
              {t("ag.stats.total")} {s.totalRuns} · {t("ag.stats.ok")} {s.completedRuns} · {t("ag.stats.fail")} {s.failedRuns} ·{" "}
              {t("ag.stats.avg")} {(s.avgDurationMs / 1000).toFixed(1)}s
            </span>
          ) : undefined
        }
      >
        <p className="subtle" style={{ fontSize: 12, marginBottom: 8, marginTop: 0 }}>
          {t("ag.history.sub")}
        </p>
        <AsyncBlock
          loading={history.isLoading}
          error={history.error}
          empty={entries.length === 0}
          emptyLabel={t("ag.history.empty")}
          emptyHint={t("ag.history.emptyHint")}
          emptyIcon={<Icon.brain />}
        >
          {entries.map((entry) => (
            <div className="row" key={entry.runId}>
              <div className="row-main">
                <div className="row-title mono" style={{ fontSize: 12 }}>{entry.runId}</div>
                <div className="row-meta">
                  {entry.mode} · {entry.completedCount}/{entry.workerCount} · {(entry.durationMs / 1000).toFixed(1)}s ·{" "}
                  {new Date(entry.finishedAt).toLocaleString()}
                  {entry.error ? ` · ${entry.error}` : ""}
                </div>
              </div>
              <Badge tone={entry.status === "completed" ? "ok" : "err"}>{entry.status}</Badge>
            </div>
          ))}
        </AsyncBlock>
      </Card>
    </div>
  );
}

function SwarmCard({ client }: { client: ApiClient }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const pending = useQuery({
    queryFn: () => client.get<SwarmPendingResponse>("/api/swarm/pending"),
    queryKey: ["swarm-pending", client.baseUrl]
  });
  const resolve = useMutation({
    mutationFn: (input: { id: string; action: "promote" | "reject" }) =>
      client.post(`/api/swarm/${input.id}/${input.action}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["swarm-pending", client.baseUrl] })
  });

  const entries = pending.data?.entries ?? [];

  return (
    <div style={{ marginTop: 16 }}>
      <Card title={t("ag.swarm")} count={pending.data?.total ?? 0}>
        <p className="subtle" style={{ fontSize: 12, marginBottom: 8, marginTop: 0 }}>
          {t("ag.swarm.sub")}
        </p>
        <AsyncBlock
          loading={pending.isLoading}
          error={pending.error}
          empty={entries.length === 0}
          emptyLabel={t("ag.swarm.empty")}
          emptyHint={t("ag.swarm.emptyHint")}
          emptyIcon={<Icon.shield />}
        >
          {entries.map((entry) => (
            <div className="row" key={entry.id}>
              <div className="row-main">
                <div className="row-title">
                  {entry.label ?? entry.kind} <span className="subtle">· {entry.fromPeerId}</span>
                </div>
                <div className="row-meta" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                  {entry.content.slice(0, 140)}
                </div>
              </div>
              <Button
                variant="primary"
                size="sm"
                disabled={resolve.isPending || entry.kind !== "skill"}
                title={entry.kind !== "skill" ? `'${entry.kind}' promotion is CLI-review only` : undefined}
                onClick={() => resolve.mutate({ action: "promote", id: entry.id })}
              >
                {t("ag.swarm.promote")}
              </Button>
              <Button variant="ghost" size="sm" disabled={resolve.isPending} onClick={() => resolve.mutate({ action: "reject", id: entry.id })}>
                {t("ag.swarm.reject")}
              </Button>
            </div>
          ))}
        </AsyncBlock>
      </Card>
    </div>
  );
}
