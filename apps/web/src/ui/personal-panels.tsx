/**
 * Personal-domain side panels for the Muse web console.
 *
 * Lifted out of `App.tsx` (1,097 LOC after rounds 147-150 added 4
 * new panels) so each panel + its typed response interface lives
 * close together rather than scattered through the monolith.
 *
 * The 6 panels here all follow the same shape — `({ client }: { client: ApiClient })`
 * — and consume `/api/{tasks,notes,user-memory,scheduler,token-cost,calendar}/*`.
 * The shared `ApiClient` interface is back-imported from `./App.js`.
 *
 * Kept in `App.tsx`:
 *   - the chrome (ConnectionSettings, ChatPanel, RunsPanel,
 *     ToolCatalogPanel, OrchestrationsPanel, VoicePanel)
 *   - the CalendarSettingsPanel (provider-credentials mgmt, distinct
 *     concern from event display)
 *   - the small render helpers (RiskPill, StatusMetric)
 *   - the `MuseConsole` shell + the apiClient factory
 */

import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { buildTodayBriefUserMessage } from "@muse/prompts";

import type { ApiClient } from "./App.js";

interface TaskRow {
  readonly id: string;
  readonly title: string;
  readonly status: "open" | "done";
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly notes?: string;
  readonly tags?: readonly string[];
}

interface TasksResponse {
  readonly tasks: readonly TaskRow[];
  readonly status: "open" | "done" | "all";
  readonly total: number;
}

interface TasksProviderInfo {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly local: boolean;
}

interface TasksProvidersResponse {
  readonly providers: readonly TasksProviderInfo[];
}

interface CalendarEventRow {
  readonly id: string;
  readonly providerId: string;
  readonly title: string;
  readonly startsAtIso: string;
  readonly endsAtIso: string;
  readonly allDay: boolean;
  readonly location: string | null;
  readonly notes: string | null;
  readonly tags: readonly string[];
  readonly url: string | null;
}

interface CalendarEventsResponse {
  readonly events: readonly CalendarEventRow[];
  readonly total: number;
}

interface NotesEntryRow {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly sizeBytes?: number;
}

interface NotesListResponse {
  readonly dir: string;
  readonly entries: readonly NotesEntryRow[];
  readonly truncated: boolean;
}

interface NotesProviderInfo {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly local: boolean;
}

interface NotesProvidersResponse {
  readonly providers: readonly NotesProviderInfo[];
}

interface UserMemoryResponse {
  readonly facts: Readonly<Record<string, string>>;
  readonly preferences: Readonly<Record<string, string>>;
  readonly recentTopics: readonly string[];
  readonly updatedAt: string;
}

interface ScheduledJobRow {
  readonly id: string;
  readonly name: string;
  readonly cronExpression: string;
  readonly enabled: boolean;
  readonly jobType: string;
  readonly lastRunAt: number | null;
  readonly lastStatus: string | null;
}

interface ScheduledJobsResponse {
  readonly items: readonly ScheduledJobRow[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

interface TokenCostDailyRow {
  readonly day: string;
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly totalCostUsd: number;
}

export function TasksPanel({ client }: { readonly client: ApiClient }) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const tasks = useQuery({
    queryFn: () => client.get<TasksResponse>("/api/tasks?status=open"),
    queryKey: ["tasks", "open"]
  });
  const providers = useQuery({
    queryFn: () => client.get<TasksProvidersResponse>("/api/tasks/providers"),
    queryKey: ["tasks-providers"],
    // 404s when tasksFile isn't configured — surface the empty state
    // rather than retrying.
    retry: false
  });

  const addTask = useMutation({
    mutationFn: async (title: string) => client.post<TaskRow>("/api/tasks", { title }),
    onError: (err) => setError(err instanceof Error ? err.message : "Failed to add task"),
    onSuccess: async () => {
      setDraft("");
      setError(null);
      await tasks.refetch();
    }
  });

  const completeTask = useMutation({
    mutationFn: async (id: string) => client.post<TaskRow>(`/api/tasks/${encodeURIComponent(id)}/complete`, {}),
    onError: (err) => setError(err instanceof Error ? err.message : "Failed to complete task"),
    onSuccess: async () => { await tasks.refetch(); }
  });

  const providerCount = providers.data?.providers.length ?? 0;

  return (
    <section className="tool-surface compact" aria-label="Tasks">
      <div className="surface-heading">
        <h2>Tasks</h2>
        <span>{tasks.isLoading ? "Loading" : (tasks.data?.total ?? 0)}</span>
      </div>
      {providerCount > 1 ? (
        <p className="status-info" style={{ fontSize: "0.85em", margin: "0 0 0.5rem 0" }}>
          {providerCount} providers configured: {(providers.data?.providers ?? []).map((p) => p.id).join(", ")}
        </p>
      ) : null}
      {error ? <p className="status-error">{error}</p> : null}
      <form
        className="connection-form"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = draft.trim();
          if (trimmed.length > 0) {
            addTask.mutate(trimmed);
          }
        }}
        style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem" }}
      >
        <input
          aria-label="New task title"
          placeholder="Add a task…"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          style={{ flex: 1 }}
        />
        <button type="submit" disabled={addTask.isPending || draft.trim().length === 0}>Add</button>
      </form>
      <ul className="record-list">
        {(tasks.data?.tasks ?? []).map((task) => (
          <li key={task.id}>
            <strong>{task.title}</strong>
            <button
              type="button"
              onClick={() => completeTask.mutate(task.id)}
              disabled={completeTask.isPending}
              style={{ marginLeft: "0.5rem" }}
            >
              ✓ Done
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function NotesPanel({ client }: { readonly client: ApiClient }) {
  const [draftPath, setDraftPath] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const notes = useQuery({
    queryFn: () => client.get<NotesListResponse>("/api/notes/list"),
    queryKey: ["notes-list"],
    // 404s when notesDir is not configured on the server — surface that
    // gracefully rather than treating it as a fatal panel error.
    retry: false
  });
  const providers = useQuery({
    queryFn: () => client.get<NotesProvidersResponse>("/api/notes/providers"),
    queryKey: ["notes-providers"],
    retry: false
  });

  const saveNote = useMutation({
    mutationFn: async (input: { readonly path: string; readonly content: string }) =>
      client.post<{ readonly path: string }>("/api/notes/save", input),
    onError: (err) => setError(err instanceof Error ? err.message : "Failed to save note"),
    onSuccess: async () => {
      setDraftPath("");
      setDraftBody("");
      setError(null);
      await notes.refetch();
    }
  });

  const fileEntries = (notes.data?.entries ?? []).filter((entry) => !entry.isDirectory);
  const providerCount = providers.data?.providers.length ?? 0;

  return (
    <section className="tool-surface compact" aria-label="Notes">
      <div className="surface-heading">
        <h2>Notes</h2>
        <span>{notes.isLoading ? "Loading" : fileEntries.length}</span>
      </div>
      {providerCount > 1 ? (
        <p className="status-info" style={{ fontSize: "0.85em", margin: "0 0 0.5rem 0" }}>
          {providerCount} providers configured: {(providers.data?.providers ?? []).map((p) => p.id).join(", ")}
        </p>
      ) : null}
      {notes.isError ? (
        <p className="status-error">Notes are not configured (set MUSE_NOTES_DIR).</p>
      ) : null}
      {error ? <p className="status-error">{error}</p> : null}
      <form
        className="connection-form"
        onSubmit={(event) => {
          event.preventDefault();
          const path = draftPath.trim();
          const content = draftBody.trim();
          if (path.length > 0 && content.length > 0) {
            saveNote.mutate({ content, path });
          }
        }}
        style={{ display: "flex", flexDirection: "column", gap: "0.25rem", marginBottom: "0.5rem" }}
      >
        <input
          aria-label="New note filename (e.g. journal.md)"
          placeholder="filename.md"
          value={draftPath}
          onChange={(event) => setDraftPath(event.target.value)}
        />
        <textarea
          aria-label="New note content"
          placeholder="Note body…"
          value={draftBody}
          onChange={(event) => setDraftBody(event.target.value)}
          rows={3}
        />
        <button
          type="submit"
          disabled={saveNote.isPending || draftPath.trim().length === 0 || draftBody.trim().length === 0}
        >
          Save
        </button>
      </form>
      <ul className="record-list">
        {fileEntries.slice(0, 10).map((entry) => (
          <li key={entry.name}>
            <strong>{entry.name}</strong>
            {entry.sizeBytes !== undefined ? (
              <span style={{ color: "var(--muted, #888)", marginLeft: "0.5rem", fontSize: "0.85em" }}>
                {entry.sizeBytes}b
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function MemoryPanel({ client }: { readonly client: ApiClient }) {
  const memory = useQuery({
    queryFn: () => client.get<UserMemoryResponse>("/api/user-memory/me"),
    queryKey: ["user-memory", "me"],
    // 403 (auth on, JWT subject != "me") and 404 (no memory yet) both
    // surface as friendly status — the panel is read-only so retrying
    // doesn't help.
    retry: false
  });

  if (memory.isError) {
    return (
      <section className="tool-surface compact" aria-label="Memory">
        <div className="surface-heading">
          <h2>Memory</h2>
          <span>—</span>
        </div>
        <p className="status-info" style={{ fontSize: "0.85em", margin: 0 }}>
          No memory recorded yet. The agent will start populating this as you chat.
        </p>
      </section>
    );
  }

  const factEntries = Object.entries(memory.data?.facts ?? {});
  const prefEntries = Object.entries(memory.data?.preferences ?? {});
  const topics = memory.data?.recentTopics ?? [];
  const totalSlots = factEntries.length + prefEntries.length + topics.length;

  return (
    <section className="tool-surface compact" aria-label="Memory">
      <div className="surface-heading">
        <h2>Memory</h2>
        <span>{memory.isLoading ? "Loading" : totalSlots}</span>
      </div>
      {topics.length > 0 ? (
        <p style={{ fontSize: "0.85em", margin: "0 0 0.5rem 0" }}>
          <strong>Recent:</strong> {topics.slice(0, 5).join(", ")}
        </p>
      ) : null}
      <ul className="record-list">
        {factEntries.slice(0, 6).map(([key, value]) => (
          <li key={`fact-${key}`}>
            <strong>{key}</strong>
            <span style={{ color: "var(--muted, #888)", marginLeft: "0.5rem", fontSize: "0.85em" }}>
              {value}
            </span>
          </li>
        ))}
        {prefEntries.slice(0, 4).map(([key, value]) => (
          <li key={`pref-${key}`}>
            <strong>{key}</strong>
            <span style={{ color: "var(--muted, #888)", marginLeft: "0.5rem", fontSize: "0.85em" }}>
              {value}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SchedulerPanel({ client }: { readonly client: ApiClient }) {
  const jobs = useQuery({
    queryFn: () => client.get<ScheduledJobsResponse>("/api/scheduler/jobs?limit=10"),
    queryKey: ["scheduler-jobs"],
    // The endpoint always returns at least an empty list when scheduler
    // is unavailable, so retry: false isn't strictly needed — but it
    // keeps the panel quiet on auth failures too.
    retry: false
  });

  const items = jobs.data?.items ?? [];
  const enabledCount = items.filter((job) => job.enabled).length;
  const totalCount = jobs.data?.total ?? 0;

  return (
    <section className="tool-surface compact" aria-label="Scheduler">
      <div className="surface-heading">
        <h2>Scheduler</h2>
        <span>{jobs.isLoading ? "Loading" : `${enabledCount}/${totalCount}`}</span>
      </div>
      {jobs.isError ? (
        <p className="status-error">Scheduler is not available.</p>
      ) : null}
      {!jobs.isLoading && !jobs.isError && items.length === 0 ? (
        <p className="status-info" style={{ fontSize: "0.85em", margin: 0 }}>
          No jobs scheduled. Use `muse scheduler create-job` or the agent's
          scheduler tools to add one.
        </p>
      ) : null}
      <ul className="record-list">
        {items.map((job) => (
          <li key={job.id}>
            <strong>{job.name}</strong>
            <span style={{ color: "var(--muted, #888)", marginLeft: "0.5rem", fontSize: "0.85em" }}>
              {job.cronExpression}
            </span>
            {!job.enabled ? (
              <span style={{ color: "var(--muted, #888)", marginLeft: "0.5rem", fontSize: "0.85em" }}>
                (disabled)
              </span>
            ) : null}
            {job.lastStatus ? (
              <span style={{
                color: job.lastStatus === "FAILED" || job.lastStatus === "failed"
                  ? "var(--error, #c0392b)"
                  : "var(--muted, #888)",
                marginLeft: "0.5rem",
                fontSize: "0.85em"
              }}>
                {job.lastStatus.toLowerCase()}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function TokenCostPanel({ client }: { readonly client: ApiClient }) {
  const cost = useQuery({
    queryFn: () => client.get<readonly TokenCostDailyRow[]>("/api/admin/token-cost/daily?days=7"),
    queryKey: ["token-cost-daily"],
    // The route returns an array even when no data — retry: false keeps
    // auth-failure 401/403 quiet.
    retry: false
  });

  const rows = cost.data ?? [];
  const totalCost = rows.reduce((sum, row) => sum + (Number(row.totalCostUsd) || 0), 0);
  const totalTokens = rows.reduce((sum, row) => sum + (row.totalTokens || 0), 0);

  // Group by model for the breakdown line — useful when the user is
  // running multiple providers (e.g. gemini-2.0-flash + gpt-4o-mini).
  const byModel = new Map<string, number>();
  for (const row of rows) {
    byModel.set(row.model, (byModel.get(row.model) ?? 0) + (Number(row.totalCostUsd) || 0));
  }
  const modelBreakdown = [...byModel.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3);

  return (
    <section className="tool-surface compact" aria-label="LLM cost">
      <div className="surface-heading">
        <h2>LLM cost (7d)</h2>
        <span>{cost.isLoading ? "Loading" : `$${totalCost.toFixed(4)}`}</span>
      </div>
      {cost.isError ? (
        <p className="status-info" style={{ fontSize: "0.85em", margin: 0 }}>
          Cost data is unavailable (admin auth required, or no recent runs).
        </p>
      ) : null}
      {!cost.isLoading && !cost.isError && rows.length === 0 ? (
        <p className="status-info" style={{ fontSize: "0.85em", margin: 0 }}>
          No LLM usage in the last 7 days.
        </p>
      ) : null}
      {rows.length > 0 ? (
        <p style={{ fontSize: "0.85em", margin: "0 0 0.25rem 0" }}>
          {totalTokens.toLocaleString()} tokens across {byModel.size} model{byModel.size === 1 ? "" : "s"}.
        </p>
      ) : null}
      <ul className="record-list">
        {modelBreakdown.map(([model, modelCost]) => (
          <li key={`model-${model}`}>
            <strong>{model}</strong>
            <span style={{ color: "var(--muted, #888)", marginLeft: "0.5rem", fontSize: "0.85em" }}>
              ${modelCost.toFixed(4)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function CalendarEventsPanel({ client }: { readonly client: ApiClient }) {
  const events = useQuery({
    queryFn: () => {
      const from = new Date();
      const to = new Date(from.getTime() + 14 * 86_400_000);
      return client.get<CalendarEventsResponse>(
        `/api/calendar/events?fromIso=${encodeURIComponent(from.toISOString())}&toIso=${encodeURIComponent(to.toISOString())}`
      );
    },
    queryKey: ["calendar-events"]
  });

  return (
    <section className="tool-surface compact" aria-label="Upcoming events">
      <div className="surface-heading">
        <h2>Upcoming (14d)</h2>
        <span>{events.isLoading ? "Loading" : (events.data?.total ?? 0)}</span>
      </div>
      <ul className="record-list">
        {(events.data?.events ?? []).slice(0, 8).map((event) => (
          <li key={`${event.providerId}:${event.id}`}>
            <strong>{event.title}</strong>
            <span className="risk-read">
              {new Date(event.startsAtIso).toLocaleDateString()} · {event.providerId}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface ReminderRow {
  readonly id: string;
  readonly text: string;
  readonly dueAt: string;
  readonly status: "pending" | "fired";
  readonly firedAt?: string;
  readonly createdAt: string;
}

interface RemindersResponse {
  readonly reminders: readonly ReminderRow[];
  readonly status: "pending" | "fired" | "all" | "due";
  readonly total: number;
}

interface ReminderHistoryEntry {
  readonly reminderId: string;
  readonly text: string;
  readonly providerId: string;
  readonly destination: string;
  readonly firedAtIso: string;
  readonly status: "delivered" | "failed";
  readonly error?: string;
}
interface ReminderHistoryResponse {
  readonly entries: readonly ReminderHistoryEntry[];
  readonly total: number;
}

export function RemindersPanel({ client }: { readonly client: ApiClient }) {
  const [text, setText] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reminders = useQuery({
    queryFn: () => client.get<RemindersResponse>("/api/reminders?status=pending"),
    queryKey: ["reminders", "pending"],
    retry: false
  });

  // Audit log (Loop #52): 404 means the daemon-fed history file
  // isn't wired in this runtime; treat as empty rather than error.
  const history = useQuery({
    queryFn: () =>
      client.get<ReminderHistoryResponse>("/api/reminders/history?limit=5")
        .catch(() => ({ entries: [], total: 0 } satisfies ReminderHistoryResponse)),
    queryKey: ["reminders", "history"],
    retry: false
  });

  const addReminder = useMutation({
    mutationFn: async (payload: { text: string; dueAt: string }) =>
      client.post<ReminderRow>("/api/reminders", payload),
    onError: (err) => setError(err instanceof Error ? err.message : "Failed to add reminder"),
    onSuccess: async () => {
      setText("");
      setDueAt("");
      setError(null);
      await reminders.refetch();
    }
  });

  const clearReminder = useMutation({
    mutationFn: async (id: string) =>
      client.delete<unknown>(`/api/reminders/${encodeURIComponent(id)}`),
    onSuccess: async () => { await reminders.refetch(); }
  });

  const snoozeReminder = useMutation({
    mutationFn: async (id: string) =>
      client.post<ReminderRow>(`/api/reminders/${encodeURIComponent(id)}/snooze`, {}),
    onSuccess: async () => { await reminders.refetch(); }
  });

  const fireReminder = useMutation({
    mutationFn: async (id: string) =>
      client.post<ReminderRow>(`/api/reminders/${encodeURIComponent(id)}/fire`, {}),
    onSuccess: async () => { await reminders.refetch(); }
  });

  return (
    <section className="tool-surface compact" aria-label="Reminders">
      <div className="surface-heading">
        <h2>Reminders</h2>
        <span>{reminders.isLoading ? "Loading" : (reminders.data?.total ?? 0)}</span>
      </div>
      {error ? <p className="status-error">{error}</p> : null}
      <form
        className="connection-form"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmedText = text.trim();
          const trimmedDue = dueAt.trim();
          if (trimmedText.length > 0 && trimmedDue.length > 0) {
            addReminder.mutate({ dueAt: trimmedDue, text: trimmedText });
          }
        }}
        style={{ display: "flex", flexDirection: "column", gap: "0.35rem", marginBottom: "0.5rem" }}
      >
        <input
          aria-label="Reminder text"
          placeholder="Reminder text…"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <input
          aria-label="Due when"
          placeholder="When (e.g. 'tomorrow at 9am' or ISO-8601)"
          value={dueAt}
          onChange={(event) => setDueAt(event.target.value)}
        />
        <button
          type="submit"
          disabled={addReminder.isPending || text.trim().length === 0 || dueAt.trim().length === 0}
        >
          Add reminder
        </button>
      </form>
      <ul className="record-list">
        {(reminders.data?.reminders ?? []).map((reminder) => (
          <li key={reminder.id}>
            <strong>{reminder.text}</strong>
            <span className="risk-read" style={{ marginLeft: "0.5rem" }}>
              due {new Date(reminder.dueAt).toLocaleString()}
            </span>
            <button
              type="button"
              onClick={() => fireReminder.mutate(reminder.id)}
              disabled={fireReminder.isPending}
              style={{ marginLeft: "0.5rem" }}
              title="Mark this reminder delivered (status → fired)"
            >
              ✓ Fire
            </button>
            <button
              type="button"
              onClick={() => snoozeReminder.mutate(reminder.id)}
              disabled={snoozeReminder.isPending}
              style={{ marginLeft: "0.25rem" }}
              title="Snooze 10 minutes"
            >
              ⟳ Snooze
            </button>
            <button
              type="button"
              onClick={() => clearReminder.mutate(reminder.id)}
              disabled={clearReminder.isPending}
              style={{ marginLeft: "0.25rem" }}
              title="Delete reminder"
            >
              ✕ Clear
            </button>
          </li>
        ))}
      </ul>
      {(history.data?.entries ?? []).length > 0 ? (
        <details style={{ marginTop: "0.5rem" }}>
          <summary style={{ cursor: "pointer", fontSize: "0.85em" }}>
            Recent firings ({history.data?.total ?? 0})
          </summary>
          <ul className="record-list" style={{ marginTop: "0.25rem" }}>
            {(history.data?.entries ?? []).map((entry) => (
              <li key={`${entry.reminderId}:${entry.firedAtIso}`}>
                <strong>{entry.text}</strong>
                <span className="risk-read" style={{ marginLeft: "0.5rem" }}>
                  {entry.status === "delivered" ? "✓" : "✗"} {entry.providerId} → {entry.destination}
                </span>
                <span style={{ marginLeft: "0.5rem", fontSize: "0.8em", opacity: 0.7 }}>
                  {new Date(entry.firedAtIso).toLocaleString()}
                </span>
                {entry.error ? (
                  <p className="status-error" style={{ fontSize: "0.75em", margin: "0.15rem 0 0 0" }}>
                    {entry.error}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

interface TodayBriefingResponse {
  readonly generatedAt: string;
  readonly lookaheadHours: number;
  readonly tasks?: readonly { readonly id: string; readonly title: string }[];
  readonly events?: readonly { readonly id: string; readonly title: string; readonly startsAtIso: string }[];
  readonly notes?: readonly string[];
  readonly reminders?: readonly { readonly id: string; readonly text: string; readonly dueAt: string }[];
}

interface ChatResponse {
  readonly content?: string;
  readonly errorMessage?: string;
  readonly success?: boolean;
}

export function TodayBriefPanel({ client }: { readonly client: ApiClient }) {
  const briefing = useQuery({
    queryFn: () => client.get<TodayBriefingResponse>("/api/today"),
    queryKey: ["today-brief"],
    retry: false
  });
  const [prose, setProse] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const renderBrief = useMutation({
    mutationFn: async (payload: TodayBriefingResponse) => {
      const message = buildTodayBriefUserMessage(payload);
      return client.post<ChatResponse>("/api/chat", { message, metadata: { source: "today.brief" } });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Failed to render brief"),
    onSuccess: (response) => {
      setError(null);
      setProse(response.content?.trim() ?? "(empty response)");
    }
  });

  const tasks = briefing.data?.tasks?.length ?? 0;
  const events = briefing.data?.events?.length ?? 0;
  const reminders = briefing.data?.reminders?.length ?? 0;

  return (
    <section className="tool-surface compact" aria-label="Today brief">
      <div className="surface-heading">
        <h2>Today</h2>
        <span>{briefing.isLoading ? "Loading" : `${tasks.toString()} · ${events.toString()} · ${reminders.toString()}`}</span>
      </div>
      {briefing.error ? (
        <p className="status-error">
          {briefing.error instanceof Error ? briefing.error.message : "Failed to load briefing"}
        </p>
      ) : null}
      {error ? <p className="status-error">{error}</p> : null}
      <button
        type="button"
        onClick={() => {
          if (briefing.data) {
            renderBrief.mutate(briefing.data);
          }
        }}
        disabled={renderBrief.isPending || !briefing.data}
        style={{ marginBottom: "0.5rem" }}
      >
        {renderBrief.isPending ? "Composing…" : "Render brief"}
      </button>
      {prose ? (
        <p style={{ margin: "0.5rem 0", lineHeight: 1.4 }}>{prose}</p>
      ) : (
        <p className="status-info" style={{ fontSize: "0.85em", margin: 0 }}>
          {briefing.data
            ? `${tasks.toString()} task(s), ${events.toString()} event(s), ${reminders.toString()} reminder(s) due. Press "Render brief" for the JARVIS-style summary.`
            : ""}
        </p>
      )}
    </section>
  );
}

interface MessagingProviderInfo {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly local?: boolean;
}

interface MessagingProvidersResponse {
  readonly providers: readonly MessagingProviderInfo[];
}

interface MessagingInboundRow {
  readonly providerId: string;
  readonly messageId: string;
  readonly source: string;
  readonly sender?: string;
  readonly receivedAtIso: string;
  readonly text: string;
}

interface MessagingInboxResponse {
  readonly providerId: string;
  readonly inbound: readonly MessagingInboundRow[];
  readonly total: number;
}

export function MessagingInboxPanel({ client }: { readonly client: ApiClient }) {
  const providers = useQuery({
    queryFn: () => client.get<MessagingProvidersResponse>("/api/messaging/providers"),
    queryKey: ["messaging-providers"],
    retry: false
  });
  const list = providers.data?.providers ?? [];
  const [providerId, setProviderId] = useState<string>("");
  const [source, setSource] = useState<string>("");
  const effective = providerId.length > 0 ? providerId : list[0]?.id ?? "";

  // Slack still requires `source` (snapshot via conversations.history).
  // Discord's read path now goes through the daemon-fed inbox file
  // (Phase 2.c.4), so `source` is optional — blank = all channels.
  const requiresSource = effective === "slack";
  const supportsSource = effective === "discord" || effective === "slack";

  const inbox = useQuery({
    enabled: effective.length > 0 && (!requiresSource || source.length > 0),
    queryFn: () => {
      const params = new URLSearchParams({ providerId: effective, limit: "20" });
      if (supportsSource && source.length > 0) {
        params.set("source", source);
      }
      return client.get<MessagingInboxResponse>(`/api/messaging/inbox?${params.toString()}`);
    },
    queryKey: ["messaging-inbox", effective, source],
    retry: false
  });

  // Outbound send form. Keep destination + text local so a misdirected
  // message doesn't survive a provider switch.
  const [destination, setDestination] = useState<string>("");
  const [draft, setDraft] = useState<string>("");
  const [sendError, setSendError] = useState<string | null>(null);
  const sendMessage = useMutation({
    mutationFn: async (payload: { destination: string; text: string }) =>
      client.post<{ readonly messageId?: string }>("/api/messaging/send", {
        destination: payload.destination,
        providerId: effective,
        text: payload.text
      }),
    onError: (err) => setSendError(err instanceof Error ? err.message : "Failed to send"),
    onSuccess: async () => {
      setDraft("");
      setSendError(null);
      await inbox.refetch();
    }
  });

  // Agent-triggered off-cadence poll (Loop #46) — same dispatcher
  // backs muse.messaging.poll_now. LINE is webhook-fed so the button
  // is hidden for it; everyone else can pull on demand.
  const [pollStatus, setPollStatus] = useState<string | null>(null);
  const pollNow = useMutation({
    mutationFn: async () =>
      client.post<{ readonly ingested?: number }>("/api/messaging/poll", {
        providerId: effective,
        ...(supportsSource && source.length > 0 ? { source } : {})
      }),
    onError: (err) => setPollStatus(err instanceof Error ? err.message : "Pull failed"),
    onSuccess: async (result) => {
      setPollStatus(`Pulled ${result.ingested ?? 0} message(s)`);
      await inbox.refetch();
    }
  });
  const supportsPullNow = effective === "telegram" || effective === "discord" || effective === "slack";

  // Pull-all spans every wired provider in one call. Visible on
  // any panel state where the panel has providers — it isn't
  // provider-specific, so source/effective don't gate it.
  const [pollAllStatus, setPollAllStatus] = useState<string | null>(null);
  const pollAll = useMutation({
    mutationFn: async () =>
      client.post<{
        readonly ingestedByProvider?: Readonly<Record<string, number>>;
        readonly errors?: readonly { readonly providerId: string; readonly message: string }[];
      }>("/api/messaging/poll-all", {}),
    onError: (err) => setPollAllStatus(err instanceof Error ? err.message : "Pull-all failed"),
    onSuccess: async (result) => {
      const counts = result.ingestedByProvider ?? {};
      const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
      const breakdown = Object.entries(counts).map(([id, n]) => `${id}:${n.toString()}`).join(" ");
      const errs = result.errors ?? [];
      setPollAllStatus(
        `Pulled ${total.toString()} total${breakdown ? ` (${breakdown})` : ""}` +
        (errs.length > 0 ? ` · ${errs.length.toString()} error(s)` : "")
      );
      await inbox.refetch();
    }
  });

  return (
    <section className="tool-surface compact" aria-label="Messaging">
      <div className="surface-heading">
        <h2>Messaging</h2>
        <span>{inbox.isLoading ? "Loading" : (inbox.data?.total ?? 0)}</span>
      </div>
      {list.length === 0 ? (
        <p className="status-info" style={{ fontSize: "0.85em", margin: 0 }}>
          No providers configured. Set MUSE_TELEGRAM_BOT_TOKEN / MUSE_DISCORD_BOT_TOKEN /
          MUSE_SLACK_BOT_TOKEN / MUSE_LINE_CHANNEL_ACCESS_TOKEN to enable.
        </p>
      ) : (
        <>
          <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem" }}>
            <select
              aria-label="Messaging provider"
              value={effective}
              onChange={(event) => setProviderId(event.target.value)}
              style={{ flex: 1 }}
            >
              {list.map((p) => (
                <option key={p.id} value={p.id}>{p.displayName}</option>
              ))}
            </select>
            {supportsSource ? (
              <input
                aria-label="Channel id"
                placeholder={requiresSource ? "Channel id" : "Channel id (blank = all)"}
                value={source}
                onChange={(event) => setSource(event.target.value)}
                style={{ flex: 1 }}
              />
            ) : null}
            {supportsPullNow ? (
              <button
                aria-label="Pull now"
                type="button"
                disabled={pollNow.isPending || (requiresSource && source.length === 0)}
                onClick={() => { setPollStatus(null); pollNow.mutate(); }}
              >
                {pollNow.isPending ? "Pulling…" : "Pull now"}
              </button>
            ) : null}
            <button
              aria-label="Pull all"
              type="button"
              disabled={pollAll.isPending}
              onClick={() => { setPollAllStatus(null); pollAll.mutate(); }}
            >
              {pollAll.isPending ? "Pulling…" : "Pull all"}
            </button>
          </div>
          {pollStatus ? (
            <p className="status-info" style={{ fontSize: "0.8em", margin: "0 0 0.5rem 0" }}>{pollStatus}</p>
          ) : null}
          {pollAllStatus ? (
            <p className="status-info" style={{ fontSize: "0.8em", margin: "0 0 0.5rem 0" }}>{pollAllStatus}</p>
          ) : null}
          {inbox.error ? (
            <p className="status-error">{inbox.error instanceof Error ? inbox.error.message : "Failed to load inbox"}</p>
          ) : null}
          <ul className="record-list">
            {(inbox.data?.inbound ?? []).map((message) => (
              <li key={`${message.providerId}:${message.messageId}`}>
                <strong>{message.sender ?? message.source}</strong>
                <span style={{ marginLeft: "0.5rem" }}>{message.text}</span>
                <span className="risk-read" style={{ marginLeft: "0.5rem" }}>
                  {new Date(message.receivedAtIso).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
          {sendError ? <p className="status-error">{sendError}</p> : null}
          <form
            className="connection-form"
            onSubmit={(event) => {
              event.preventDefault();
              const trimmedDest = destination.trim();
              const trimmedText = draft.trim();
              if (effective.length > 0 && trimmedDest.length > 0 && trimmedText.length > 0) {
                sendMessage.mutate({ destination: trimmedDest, text: trimmedText });
              }
            }}
            style={{ display: "flex", flexDirection: "column", gap: "0.35rem", marginTop: "0.5rem" }}
          >
            <input
              aria-label="Send destination"
              placeholder={
                effective === "telegram"
                  ? "chat_id (e.g. @me)"
                  : effective === "line"
                  ? "userId / groupId / roomId"
                  : effective === "slack"
                  ? "channel id (Cxxx) or user id (Uxxx)"
                  : "channel id"
              }
              value={destination}
              onChange={(event) => setDestination(event.target.value)}
            />
            <textarea
              aria-label="Send message text"
              placeholder="Message text…"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={2}
            />
            <button
              type="submit"
              disabled={
                sendMessage.isPending
                || effective.length === 0
                || destination.trim().length === 0
                || draft.trim().length === 0
              }
            >
              Send
            </button>
          </form>
        </>
      )}
    </section>
  );
}

interface SetupStatusSection {
  readonly status: "ok" | "todo" | "info";
}
interface SetupStatusResponse {
  readonly model: SetupStatusSection & { readonly muse_model?: string; readonly providerKeys: readonly string[] };
  readonly mcp: SetupStatusSection & { readonly externalServerCount: number };
  readonly calendar: {
    readonly local: SetupStatusSection & { readonly file: string };
    readonly credentials: SetupStatusSection;
  };
  readonly notes: SetupStatusSection & { readonly fileCount?: number };
  readonly tasks: SetupStatusSection & { readonly entryCount?: number };
  readonly voice: SetupStatusSection & { readonly source: string };
  readonly messaging: SetupStatusSection & { readonly providers: readonly string[] };
}

function statusGlyph(status: "ok" | "todo" | "info"): string {
  return status === "ok" ? "✓" : status === "todo" ? "✗" : "·";
}

export function SetupPanel({ client }: { readonly client: ApiClient }) {
  const status = useQuery({
    queryFn: () => client.get<SetupStatusResponse>("/api/setup/status"),
    queryKey: ["setup-status"],
    retry: false
  });
  const data = status.data;
  // Flatten to a uniform { id, status, detail } shape so the render
  // is a single loop. Order matches the CLI's text renderer.
  const sections = data
    ? [
      { detail: data.model.muse_model ?? `${data.model.providerKeys.length.toString()} provider key(s)`, id: "model", status: data.model.status },
      { detail: `${data.mcp.externalServerCount.toString()} external server(s)`, id: "mcp", status: data.mcp.status },
      { detail: data.calendar.local.file, id: "calendar (local)", status: data.calendar.local.status },
      { detail: data.calendar.credentials.status === "ok" ? "credentials present" : "no credentials yet", id: "calendar (oauth/caldav)", status: data.calendar.credentials.status },
      { detail: data.notes.fileCount !== undefined ? `${data.notes.fileCount.toString()} file(s)` : "not yet created", id: "notes", status: data.notes.status },
      { detail: data.tasks.entryCount !== undefined ? `${data.tasks.entryCount.toString()} entry/entries` : "not yet created", id: "tasks", status: data.tasks.status },
      { detail: data.voice.source === "none" ? "no key" : data.voice.source, id: "voice", status: data.voice.status },
      { detail: data.messaging.providers.length > 0 ? data.messaging.providers.join(", ") : "no providers yet", id: "messaging", status: data.messaging.status }
    ]
    : [];
  const todoCount = sections.filter((entry) => entry.status === "todo").length;

  return (
    <section className="tool-surface compact" aria-label="Setup">
      <div className="surface-heading">
        <h2>Setup</h2>
        <span>
          {status.isLoading ? "Loading" : todoCount > 0 ? `${todoCount.toString()} to do` : "ready"}
        </span>
      </div>
      {status.error ? (
        <p className="status-error" style={{ fontSize: "0.85em" }}>
          {status.error instanceof Error ? status.error.message : "Failed to load setup status"}
        </p>
      ) : null}
      <ul className="record-list">
        {sections.map((entry) => (
          <li key={entry.id}>
            <strong>{statusGlyph(entry.status)} {entry.id}</strong>
            <span style={{ color: "var(--muted, #888)", marginLeft: "0.5rem", fontSize: "0.85em" }}>
              {entry.detail}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
