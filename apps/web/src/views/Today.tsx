import { useQuery } from "@tanstack/react-query";

import { AsyncBlock, Card, Stat } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";
import { safeDateTime } from "../lib/datetime.js";

import type { ApiClient } from "../api/client.js";
import type { StringKey, Translate } from "../i18n/index.js";
import type { ProactiveHistoryResponse, TodayBriefingResponse } from "../api/types.js";

function greetingKey(): StringKey {
  const h = new Date().getHours();
  if (h < 5) return "today.greeting.lateNight";
  if (h < 12) return "today.greeting.morning";
  if (h < 18) return "today.greeting.afternoon";
  return "today.greeting.evening";
}

export function timeUntil(iso: string, t: Translate): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return "";
  const min = Math.round(ms / 60_000);
  // Past OR rounds to <1 minute ⇒ "now": "in 0m" is a nonsense label for an
  // event that is here or seconds away.
  if (ms < 0 || min === 0) return t("rel.now");
  if (min < 60) return t("rel.inMinutes", { n: min });
  const hr = Math.round(min / 60);
  if (hr < 24) return t("rel.inHours", { n: hr });
  return t("rel.inDays", { n: Math.round(hr / 24) });
}

export function TodayView({ client }: { client: ApiClient }) {
  const { locale, t } = useI18n();
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
      <p className="eyebrow">{t("nav.today")}</p>
      <h1 className="page-title">{t("today.greetingLine", { greeting: t(greetingKey()) })}</h1>
      <p className="muted" style={{ marginTop: 4 }}>
        {t("today.summary", { events: events.length, reminders: reminders.length, tasks: tasks.length })}
      </p>

      <div className="grid grid-3" style={{ margin: "24px 0" }}>
        <Card>
          <Stat value={tasks.length} label={t("today.openTasks")} />
        </Card>
        <Card>
          <Stat value={events.length} label={t("today.upcomingEvents")} />
        </Card>
        <Card>
          <Stat value={reminders.length} label={t("today.pendingReminders")} />
        </Card>
      </div>

      <div className="grid grid-2">
        <Card title={t("today.tasks")} count={tasks.length}>
          <AsyncBlock loading={brief.isLoading} error={brief.error} empty={tasks.length === 0}>
            {tasks.slice(0, 6).map((task) => (
              <div className="row" key={task.id}>
                <div className="row-main">
                  <div className="row-title">{task.title}</div>
                </div>
              </div>
            ))}
          </AsyncBlock>
        </Card>

        <Card title={t("today.calendar")} count={events.length}>
          <AsyncBlock loading={brief.isLoading} error={brief.error} empty={events.length === 0}>
            {events.slice(0, 6).map((e) => (
              <div className="row" key={e.id}>
                <div className="row-main">
                  <div className="row-title">{e.title}</div>
                  <div className="row-meta">{safeDateTime(e.startsAtIso, locale)}</div>
                </div>
                <span className="subtle mono">{timeUntil(e.startsAtIso, t)}</span>
              </div>
            ))}
          </AsyncBlock>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t("today.reminders")} count={reminders.length}>
          <AsyncBlock loading={brief.isLoading} error={brief.error} empty={reminders.length === 0}>
            {reminders.slice(0, 6).map((r) => (
              <div className="row" key={r.id}>
                <div className="row-main">
                  <div className="row-title">{r.text}</div>
                </div>
                <span className="subtle mono">{timeUntil(r.dueAt, t)}</span>
              </div>
            ))}
          </AsyncBlock>
        </Card>
      </div>

      {noticeList.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <Card title={t("today.proactive")} count={noticeList.length}>
            <div className="notice-feed">
              {noticeList.slice(0, 5).map((n, i) => (
                <div className="notice" key={n.id ?? i}>
                  <div className="notice-text">{n.message ?? n.text ?? "—"}</div>
                  {n.createdAt && <div className="notice-time">{new Date(n.createdAt).toLocaleString(locale)}</div>}
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
