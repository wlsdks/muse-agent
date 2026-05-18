import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { createApiClient } from "./api-client.js";
import { CalendarSettingsPanel } from "./calendar-settings-panel.js";
import { ChatPanel } from "./chat-panel.js";
import { HistoryPanel } from "./history-panel.js";
import {
  ActiveContextPanel,
  CalendarEventsPanel,
  MemoryPanel,
  MessagingInboxPanel,
  NotesPanel,
  RemindersPanel,
  SchedulerPanel,
  SetupPanel,
  TasksPanel,
  TodayBriefPanel,
  TokenCostPanel
} from "./personal-panels.js";
import { VoicePanel } from "./voice-panel.js";

import type { ApiClient } from "./api-client.js";
import type {
  AdminSummary,
  HealthResponse,
  OrchestrationEntry,
  OrchestrationListResponse,
  SessionSummary,
  ToolCatalogEntry,
  ToolCatalogResponse
} from "./app-types.js";

export type { ApiClient } from "./api-client.js";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 5_000
    }
  }
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <MuseConsole />
    </QueryClientProvider>
  );
}

export function MuseConsole() {
  const [apiUrl, setApiUrl] = useState(() => readLocalSetting("muse.apiUrl", "http://127.0.0.1:3030"));
  const [token, setToken] = useState(() => readLocalSetting("muse.token", ""));
  const client = useMemo(() => createApiClient(apiUrl, token), [apiUrl, token]);
  const health = useQuery({
    queryFn: () => client.get<HealthResponse>("/health"),
    queryKey: ["health", apiUrl]
  });
  const admin = useQuery({
    queryFn: () => client.get<AdminSummary>("/admin/summary"),
    queryKey: ["admin-summary", apiUrl, token]
  });
  const tools = useQuery({
    queryFn: () => client.get<ToolCatalogResponse>("/api/tools"),
    queryKey: ["tools", apiUrl, token]
  });
  const orchestrations = useQuery({
    queryFn: () => client.get<OrchestrationListResponse>("/api/multi-agent/orchestrations?limit=10"),
    queryKey: ["orchestrations", apiUrl, token]
  });

  return (
    <main className="app-shell">
      <header className="topbar">
        <section>
          <p className="eyebrow">Agent Platform</p>
          <h1>Muse</h1>
        </section>
        <ConnectionSettings apiUrl={apiUrl} token={token} onApiUrl={setApiUrl} onToken={setToken} />
      </header>

      <section className="status-strip" aria-label="Runtime status">
        <StatusMetric label="API" value={health.data?.status ?? statusLabel(health.status)} />
        <StatusMetric label="Service" value={health.data?.service ?? "muse-api"} />
        <StatusMetric label="Tools" value={String(tools.data?.total ?? 0)} />
        <StatusMetric label="Orchestrations" value={String(orchestrations.data?.total ?? 0)} />
      </section>

      <section className="workspace">
        <ChatPanel client={client} apiUrl={apiUrl} token={token} />
        <aside className="side-panel">
          <VoicePanel apiUrl={apiUrl} token={token} />
          <TodayBriefPanel client={client} />
          <ActiveContextPanel client={client} />
          <SetupPanel client={client} />
          <TasksPanel client={client} />
          <RemindersPanel client={client} />
          <MessagingInboxPanel client={client} />
          <NotesPanel client={client} />
          <MemoryPanel client={client} />
          <SchedulerPanel client={client} />
          <TokenCostPanel client={client} />
          <CalendarEventsPanel client={client} />
          <HistoryPanel client={client} />
          <RunsPanel runs={admin.data?.recentRuns ?? []} loading={admin.isLoading} />
          <ToolCatalogPanel tools={tools.data?.tools ?? []} loading={tools.isLoading} />
          <CalendarSettingsPanel client={client} />
          <OrchestrationsPanel
            entries={orchestrations.data?.entries ?? []}
            loading={orchestrations.isLoading}
          />
        </aside>
      </section>
    </main>
  );
}

function ConnectionSettings(props: {
  readonly apiUrl: string;
  readonly token: string;
  readonly onApiUrl: (value: string) => void;
  readonly onToken: (value: string) => void;
}) {
  return (
    <div className="connection-form">
      <label>
        <span>API URL</span>
        <input
          value={props.apiUrl}
          onChange={(event) => {
            const next = event.target.value;
            props.onApiUrl(next);
            writeLocalSetting("muse.apiUrl", next);
          }}
        />
      </label>
      <label>
        <span>Token</span>
        <input
          type="password"
          value={props.token}
          onChange={(event) => {
            const next = event.target.value;
            props.onToken(next);
            writeLocalSetting("muse.token", next);
          }}
          placeholder="(optional) bearer token"
        />
      </label>
    </div>
  );
}

function RunsPanel(props: { readonly runs: readonly SessionSummary[]; readonly loading: boolean }) {
  return (
    <section className="tool-surface compact" aria-label="Recent runs">
      <div className="surface-heading">
        <h2>Recent Runs</h2>
        <span>{props.loading ? "Loading" : props.runs.length}</span>
      </div>
      <ul className="record-list">
        {props.runs.map((run, index) => (
          <li key={run.id ?? `run-${index}`}>
            <strong>{run.status ?? "unknown"}</strong>
            <span>{run.model ?? run.provider ?? "—"}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ToolCatalogPanel(props: { readonly tools: readonly ToolCatalogEntry[]; readonly loading: boolean }) {
  const grouped = useMemo(() => {
    const buckets: Record<"read" | "write" | "execute", number> = { execute: 0, read: 0, write: 0 };
    for (const tool of props.tools) {
      buckets[tool.risk] += 1;
    }
    return buckets;
  }, [props.tools]);

  return (
    <section className="tool-surface compact" aria-label="Tool catalog">
      <div className="surface-heading">
        <h2>Tools</h2>
        <span>{props.loading ? "Loading" : props.tools.length}</span>
      </div>
      <div className="metric-row">
        <RiskPill label="read" value={grouped.read} />
        <RiskPill label="write" value={grouped.write} />
        <RiskPill label="execute" value={grouped.execute} />
      </div>
      <ul className="record-list">
        {props.tools.slice(0, 8).map((tool) => (
          <li key={tool.name}>
            <strong>{tool.name}</strong>
            <span className={`risk-${tool.risk}`}>{tool.risk}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function OrchestrationsPanel(props: { readonly entries: readonly OrchestrationEntry[]; readonly loading: boolean }) {
  return (
    <section className="tool-surface compact" aria-label="Orchestration history">
      <div className="surface-heading">
        <h2>Orchestrations</h2>
        <span>{props.loading ? "Loading" : props.entries.length}</span>
      </div>
      <ul className="record-list">
        {props.entries.map((entry) => (
          <li key={entry.runId}>
            <strong>
              {entry.mode} · {entry.completedCount}/{entry.workerCount}
            </strong>
            <span className={`status-${entry.status}`}>
              {entry.status} · {Math.round(entry.durationMs)}ms
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RiskPill({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <span className={`risk-pill risk-${label}`}>
      <em>{label}</em>
      <strong>{value}</strong>
    </span>
  );
}

function StatusMetric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <article className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function statusLabel(status: string): string {
  return status === "pending" ? "checking" : status;
}

function readLocalSetting(key: string, fallback: string): string {
  return typeof localStorage === "undefined" ? fallback : localStorage.getItem(key) ?? fallback;
}

function writeLocalSetting(key: string, value: string): void {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(key, value);
  }
}
