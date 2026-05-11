/**
 * RemindersPanel — pending reminders list with add/fire/snooze/clear
 * controls + recent-firings audit log (Loop #52).
 *
 * Extracted from personal-panels.tsx (Loop #71) so that file can
 * keep shrinking past the 1000-LOC mark. Same pattern as the
 * SetupPanel lift (Loop #70): full panel + its supporting types
 * move; the barrel module re-exports for App.tsx's
 * import-from-personal-panels callers.
 */

import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { ApiClient } from "./App.js";

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
