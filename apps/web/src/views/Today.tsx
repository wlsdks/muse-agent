import { useQuery } from "@tanstack/react-query";

import { AsyncBlock, Card, Stat } from "../components/ui.js";

import type { ApiClient } from "../api/client.js";
import type { ProactiveHistoryResponse, TodayBriefingResponse } from "../api/types.js";

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Still up";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function timeUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return "";
  if (ms < 0) return "now";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `in ${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `in ${hr}h`;
  return `in ${Math.round(hr / 24)}d`;
}

export function TodayView({ client }: { client: ApiClient }) {
  const brief = useQuery({
    queryFn: () => client.get<TodayBriefingResponse>("/api/today"),
    queryKey: ["today", client.baseUrl]
  });
  const notices = useQuery({
    queryFn: () => client.get<ProactiveHistoryResponse>("/api/proactive/history?limit=5"),
    queryKey: ["proactive", client.baseUrl]
  });

  const data = brief.data;
  const tasks = data?.tasks ?? [];
  const events = data?.events ?? [];
  const reminders = data?.reminders ?? [];
  const noticeList = notices.data?.entries ?? notices.data?.items ?? [];

  return (
    <div className="content-narrow">
      <p className="eyebrow">Today</p>
      <h1 className="page-title">{greeting()}, Stark</h1>
      <p className="muted" style={{ marginTop: 4 }}>
        {tasks.length} open {tasks.length === 1 ? "task" : "tasks"} · {events.length}{" "}
        {events.length === 1 ? "event" : "events"} ahead · {reminders.length} reminders
      </p>

      <div className="grid grid-3" style={{ margin: "24px 0" }}>
        <Card>
          <Stat value={tasks.length} label="Open tasks" />
        </Card>
        <Card>
          <Stat value={events.length} label="Upcoming events" />
        </Card>
        <Card>
          <Stat value={reminders.length} label="Pending reminders" />
        </Card>
      </div>

      <div className="grid grid-2">
        <Card title="Tasks" count={tasks.length}>
          <AsyncBlock loading={brief.isLoading} error={brief.error} empty={tasks.length === 0}>
            {tasks.slice(0, 6).map((t) => (
              <div className="row" key={t.id}>
                <div className="row-main">
                  <div className="row-title">{t.title}</div>
                </div>
              </div>
            ))}
          </AsyncBlock>
        </Card>

        <Card title="Calendar" count={events.length}>
          <AsyncBlock loading={brief.isLoading} error={brief.error} empty={events.length === 0}>
            {events.slice(0, 6).map((e) => (
              <div className="row" key={e.id}>
                <div className="row-main">
                  <div className="row-title">{e.title}</div>
                  <div className="row-meta">{new Date(e.startsAtIso).toLocaleString()}</div>
                </div>
                <span className="subtle mono">{timeUntil(e.startsAtIso)}</span>
              </div>
            ))}
          </AsyncBlock>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title="Reminders" count={reminders.length}>
          <AsyncBlock loading={brief.isLoading} error={brief.error} empty={reminders.length === 0}>
            {reminders.slice(0, 6).map((r) => (
              <div className="row" key={r.id}>
                <div className="row-main">
                  <div className="row-title">{r.text}</div>
                </div>
                <span className="subtle mono">{timeUntil(r.dueAt)}</span>
              </div>
            ))}
          </AsyncBlock>
        </Card>
      </div>

      {noticeList.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <Card title="Proactive notices" count={noticeList.length}>
            <div className="notice-feed">
              {noticeList.slice(0, 5).map((n, i) => (
                <div className="notice" key={n.id ?? i}>
                  <div className="notice-text">{n.message ?? n.text ?? "(notice)"}</div>
                  {n.createdAt && <div className="notice-time">{new Date(n.createdAt).toLocaleString()}</div>}
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
