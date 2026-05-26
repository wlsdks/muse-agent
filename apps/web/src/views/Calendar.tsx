import { useQuery } from "@tanstack/react-query";

import { AsyncBlock, Badge, Card } from "../components/ui.js";

import type { ApiClient } from "../api/client.js";
import type { CalendarEventsResponse } from "../api/types.js";

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === tomorrow.toDateString()) return "Tomorrow";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", weekday: "short" });
}

export function CalendarView({ client }: { client: ApiClient }) {
  const events = useQuery({
    queryFn: () => client.get<CalendarEventsResponse>("/api/calendar/events"),
    queryKey: ["calendar", client.baseUrl]
  });

  const list = [...(events.data?.events ?? [])].sort(
    (a, b) => new Date(a.startsAtIso).getTime() - new Date(b.startsAtIso).getTime()
  );

  const byDay = new Map<string, typeof list>();
  for (const e of list) {
    const k = dayLabel(e.startsAtIso);
    byDay.set(k, [...(byDay.get(k) ?? []), e]);
  }

  return (
    <div className="content-narrow">
      <p className="eyebrow">Workspace</p>
      <h1 className="page-title">Calendar</h1>

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
                          ? "All day"
                          : `${new Date(e.startsAtIso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} – ${new Date(e.endsAtIso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
                        {e.location ? ` · ${e.location}` : ""}
                      </div>
                    </div>
                    {e.tags.length > 0 && <Badge dot={false}>{e.tags[0]}</Badge>}
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
