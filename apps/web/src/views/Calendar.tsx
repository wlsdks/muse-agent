import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { AsyncBlock, Badge, Button, Card, Icon } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";

import type { ApiClient } from "../api/client.js";
import type { Translate } from "../i18n/index.js";
import type { CalendarEventsResponse } from "../api/types.js";

export function dayLabel(iso: string, t: Translate, locale: string): string {
  const d = new Date(iso);
  // A malformed startsAtIso renders as an "Invalid Date" group header otherwise
  // — fall back to empty, consistent with timeUntil + formatTaskDate.
  if (Number.isNaN(d.getTime())) {
    return "";
  }
  const today = new Date();
  // Derive "tomorrow" from the calendar date, not now + 24h: a DST-transition
  // day is 23h/25h, so a fixed-ms offset overshoots/undershoots the real next day.
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return t("calendar.today");
  if (d.toDateString() === tomorrow.toDateString()) return t("calendar.tomorrow");
  return d.toLocaleDateString(locale, { day: "numeric", month: "short", weekday: "short" });
}

export function canAddEvent(title: string, start: string, end: string): boolean {
  if (title.trim().length === 0 || start.length === 0 || end.length === 0) {
    return false;
  }
  // End must be strictly after start — a backwards or zero-length event is
  // meaningless data the user would otherwise silently persist.
  return new Date(end).getTime() > new Date(start).getTime();
}

export function CalendarView({ client }: { client: ApiClient }) {
  const { locale, t } = useI18n();
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");

  const events = useQuery({
    queryFn: () => client.get<CalendarEventsResponse>("/api/calendar/events"),
    queryKey: ["calendar", client.baseUrl]
  });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ["calendar"] });

  const add = useMutation({
    mutationFn: (body: { title: string; start: string; end: string }) =>
      client.post("/api/calendar/events", {
        endsAtIso: new Date(body.end).toISOString(),
        startsAtIso: new Date(body.start).toISOString(),
        title: body.title
      }),
    onSuccess: () => {
      setTitle("");
      setStart("");
      setEnd("");
      invalidate();
    }
  });
  const remove = useMutation({
    mutationFn: (ev: { id: string; providerId: string }) =>
      client.del(`/api/calendar/events/${encodeURIComponent(ev.id)}?providerId=${encodeURIComponent(ev.providerId)}`),
    onSuccess: invalidate
  });

  const list = [...(events.data?.events ?? [])].sort(
    (a, b) => new Date(a.startsAtIso).getTime() - new Date(b.startsAtIso).getTime()
  );
  const byDay = new Map<string, typeof list>();
  for (const e of list) {
    const k = dayLabel(e.startsAtIso, t, locale);
    byDay.set(k, [...(byDay.get(k) ?? []), e]);
  }

  const canAdd = canAddEvent(title, start, end);

  return (
    <div className="content-narrow">
      <p className="eyebrow">{t("group.workspace")}</p>
      <h1 className="page-title">{t("calendar.title")}</h1>

      <Card title={t("calendar.new")} className="lifted">
        <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 200px 200px auto", alignItems: "end" }}>
          <div>
            <label className="field-label" htmlFor="cal-title">{t("calendar.eventTitle")}</label>
            <input id="cal-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Standup" />
          </div>
          <div>
            <label className="field-label" htmlFor="cal-start">{t("calendar.start")}</label>
            <input id="cal-start" className="input" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div>
            <label className="field-label" htmlFor="cal-end">{t("calendar.end")}</label>
            <input id="cal-end" className="input" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
          <Button variant="primary" disabled={!canAdd || add.isPending} onClick={() => add.mutate({ end, start, title: title.trim() })}>
            <Icon.plus className="nav-icon" /> {t("common.add")}
          </Button>
        </div>
      </Card>

      <div style={{ marginTop: 16 }}>
        <AsyncBlock loading={events.isLoading} error={events.error} empty={list.length === 0}>
          {[...byDay.entries()].map(([day, evts]) => (
            <div key={day} style={{ marginBottom: 16 }}>
              <Card title={day} count={evts.length}>
                {evts.map((e) => (
                  <div className="row" key={e.id}>
                    <div className="row-main">
                      <div className="row-title">{e.title}</div>
                      <div className="row-meta">
                        {e.allDay
                          ? t("calendar.allDay")
                          : `${new Date(e.startsAtIso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })} – ${new Date(e.endsAtIso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}`}
                        {e.location ? ` · ${e.location}` : ""}
                      </div>
                    </div>
                    {e.tags.length > 0 && <Badge dot={false}>{e.tags[0]}</Badge>}
                    <Button variant="ghost" size="sm" title={t("common.delete")} ariaLabel={t("common.delete")} onClick={() => remove.mutate({ id: e.id, providerId: e.providerId })}>
                      <Icon.trash className="nav-icon" />
                    </Button>
                  </div>
                ))}
              </Card>
            </div>
          ))}
        </AsyncBlock>
      </div>
    </div>
  );
}
