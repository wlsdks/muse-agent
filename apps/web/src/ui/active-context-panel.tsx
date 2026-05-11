/**
 * ActiveContextPanel — read-only view of GET /api/active-context.
 *
 * Mirrors what the agent loop injects as its `[Active Context]`
 * system section: current time + weekday + timezone, working-hours
 * state, current focus, active task, and today's calendar events.
 * 404 from the endpoint means `MUSE_ACTIVE_CONTEXT_ENABLED=false`;
 * surface that as a single hint line rather than an error.
 */

import { useQuery } from "@tanstack/react-query";

import type { ApiClient } from "./App.js";

interface ActiveTaskHint {
  readonly id?: string;
  readonly title: string;
  readonly dueIso?: string;
}

interface CalendarEventHint {
  readonly title: string;
  readonly startIso: string;
  readonly endIso?: string;
  readonly allDay?: boolean;
  readonly location?: string;
}

interface ActiveContextSnapshot {
  readonly nowIso: string;
  readonly weekday: string;
  readonly timezone: string;
  readonly localHour: number;
  readonly workingHours?: { readonly start: number; readonly end: number };
  readonly isWorkingHours?: boolean;
  readonly activeTask?: ActiveTaskHint;
  readonly currentFocus?: string;
  readonly todaysEvents?: readonly CalendarEventHint[];
}

interface DisabledResponse {
  readonly disabled: true;
}

type FetchResult = ActiveContextSnapshot | DisabledResponse;

export function ActiveContextPanel({ client }: { readonly client: ApiClient }) {
  const snapshot = useQuery({
    queryFn: async (): Promise<FetchResult> => {
      try {
        return await client.get<ActiveContextSnapshot>("/api/active-context");
      } catch {
        // 404 = provider disabled (MUSE_ACTIVE_CONTEXT_ENABLED=false).
        // No need to distinguish from other failures here — same hint.
        return { disabled: true };
      }
    },
    queryKey: ["active-context"],
    retry: false
  });
  const data = snapshot.data;
  const isDisabled = data !== undefined && "disabled" in data;
  const snap = data !== undefined && !("disabled" in data) ? data : undefined;

  return (
    <section className="tool-surface compact" aria-label="Active context">
      <div className="surface-heading">
        <h2>Active context</h2>
        <span>
          {snapshot.isLoading
            ? "Loading"
            : isDisabled
              ? "disabled"
              : snap
                ? snap.timezone
                : "—"}
        </span>
      </div>
      {isDisabled ? (
        <p className="status-info" style={{ fontSize: "0.85em" }}>
          Set <code>MUSE_ACTIVE_CONTEXT_ENABLED=true</code> (default) to inject this snapshot into the agent loop.
        </p>
      ) : null}
      {snap ? (
        <ul className="record-list">
          <li>
            <strong>{snap.weekday}</strong>
            <span style={{ marginLeft: "0.5rem", fontSize: "0.85em", opacity: 0.7 }}>
              {new Date(snap.nowIso).toLocaleString()} · {snap.timezone}
            </span>
          </li>
          {snap.workingHours ? (
            <li>
              <strong>Working hours</strong>
              <span style={{ marginLeft: "0.5rem", fontSize: "0.85em" }}>
                {snap.workingHours.start.toString()}–{snap.workingHours.end.toString()}
                {snap.isWorkingHours === undefined
                  ? ""
                  : snap.isWorkingHours
                    ? " (in window)"
                    : " (out of window)"}
              </span>
            </li>
          ) : null}
          {snap.currentFocus ? (
            <li>
              <strong>Focus</strong>
              <span style={{ marginLeft: "0.5rem", fontSize: "0.85em" }}>{snap.currentFocus}</span>
            </li>
          ) : null}
          {snap.activeTask ? (
            <li>
              <strong>Active task</strong>
              <span style={{ marginLeft: "0.5rem", fontSize: "0.85em" }}>
                {snap.activeTask.title}
                {snap.activeTask.dueIso ? ` · due ${new Date(snap.activeTask.dueIso).toLocaleString()}` : ""}
              </span>
            </li>
          ) : null}
          {snap.todaysEvents && snap.todaysEvents.length > 0 ? (
            <li>
              <strong>Today</strong>
              <ul className="record-list" style={{ marginTop: "0.15rem" }}>
                {snap.todaysEvents.slice(0, 8).map((event) => (
                  <li key={`${event.startIso}:${event.title}`}>
                    <span style={{ fontSize: "0.85em" }}>
                      {event.allDay ? "(all day)" : new Date(event.startIso).toLocaleTimeString()}
                      {" · "}
                      {event.title}
                      {event.location ? ` @ ${event.location}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ) : null}
        </ul>
      ) : null}
    </section>
  );
}
