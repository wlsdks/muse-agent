/**
 * SetupPanel — health-check inline from GET /api/setup/status.
 *
 * Extracted from personal-panels.tsx (Loop #70) — that file had
 * grown to ~1090 LOC with 10 panel exports. SetupPanel was the
 * cleanest standalone slice: a single useQuery against the
 * autoconfigure-served snapshot, no shared types with other
 * panels beyond `ApiClient`. personal-panels.tsx re-exports
 * SetupPanel so App.tsx and the static-render test see no import
 * change.
 */

import { useQuery } from "@tanstack/react-query";

import type { ApiClient } from "./App.js";

interface SetupStatusSection {
  readonly status: "ok" | "todo" | "info";
  readonly nextStep?: string;
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
      { detail: data.model.muse_model ?? `${data.model.providerKeys.length.toString()} provider key(s)`, id: "model", nextStep: data.model.nextStep, status: data.model.status },
      { detail: `${data.mcp.externalServerCount.toString()} external server(s)`, id: "mcp", nextStep: data.mcp.nextStep, status: data.mcp.status },
      { detail: data.calendar.local.file, id: "calendar (local)", nextStep: data.calendar.local.nextStep, status: data.calendar.local.status },
      { detail: data.calendar.credentials.status === "ok" ? "credentials present" : "no credentials yet", id: "calendar (oauth/caldav)", nextStep: data.calendar.credentials.nextStep, status: data.calendar.credentials.status },
      { detail: data.notes.fileCount !== undefined ? `${data.notes.fileCount.toString()} file(s)` : "not yet created", id: "notes", nextStep: data.notes.nextStep, status: data.notes.status },
      { detail: data.tasks.entryCount !== undefined ? `${data.tasks.entryCount.toString()} entry/entries` : "not yet created", id: "tasks", nextStep: data.tasks.nextStep, status: data.tasks.status },
      { detail: data.voice.source === "none" ? "no key" : data.voice.source, id: "voice", nextStep: data.voice.nextStep, status: data.voice.status },
      { detail: data.messaging.providers.length > 0 ? data.messaging.providers.join(", ") : "no providers yet", id: "messaging", nextStep: data.messaging.nextStep, status: data.messaging.status }
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
            {entry.nextStep ? (
              <p className="status-info" style={{ fontSize: "0.75em", margin: "0.15rem 0 0 0" }}>
                → {entry.nextStep}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
