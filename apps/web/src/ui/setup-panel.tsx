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

import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";

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
  readonly voice: SetupStatusSection & {
    readonly source: string;
    readonly sttBackend?: "openai-whisper" | "whisper-cpp" | "none";
    readonly ttsBackend?: "openai-tts" | "piper" | "none";
  };
  readonly messaging: SetupStatusSection & { readonly providers: readonly string[] };
  readonly userMemory?: SetupStatusSection & { readonly autoExtract: boolean; readonly model?: string };
  readonly proactive?: SetupStatusSection & {
    readonly enabled: boolean;
    readonly providerId?: string;
    readonly destination?: string;
    readonly leadMinutes: number;
    readonly tickMs: number;
    readonly agentTurn: boolean;
    readonly quietHours?: string;
    readonly sidecarFile: string;
  };
}

function statusGlyph(status: "ok" | "todo" | "info"): string {
  return status === "ok" ? "✓" : status === "todo" ? "✗" : "·";
}

interface RuntimeSettingResponse {
  readonly key: string;
  readonly value: string;
}

export function SetupPanel({ client }: { readonly client: ApiClient }) {
  const status = useQuery({
    queryFn: () => client.get<SetupStatusResponse>("/api/setup/status"),
    queryKey: ["setup-status"],
    retry: false
  });

  const webSearchSetting = useQuery({
    queryFn: () =>
      client.get<RuntimeSettingResponse>("/api/admin/settings/webSearch.enabled").catch(() => ({ key: "webSearch.enabled", value: "true" })),
    queryKey: ["setting-webSearch.enabled"],
    retry: false
  });

  const [webSearchFeedback, setWebSearchFeedback] = useState<string>("");

  const updateWebSearch = useMutation({
    mutationFn: (enabled: boolean) =>
      client.put<RuntimeSettingResponse>("/api/admin/settings/webSearch.enabled", {
        category: "webSearch",
        type: "boolean",
        value: enabled ? "true" : "false"
      }),
    onError: (error) => {
      setWebSearchFeedback(error instanceof Error ? error.message : "Failed to save");
    },
    onSuccess: async (_data, enabled) => {
      setWebSearchFeedback(enabled ? "Web search enabled" : "Web search disabled");
      await webSearchSetting.refetch();
    }
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
      {
        detail: data.voice.sttBackend && data.voice.ttsBackend
          ? `stt=${data.voice.sttBackend}, tts=${data.voice.ttsBackend}`
          : (data.voice.source === "none" ? "no provider wired" : data.voice.source),
        id: "voice",
        nextStep: data.voice.nextStep,
        status: data.voice.status
      },
      { detail: data.messaging.providers.length > 0 ? data.messaging.providers.join(", ") : "no providers yet", id: "messaging", nextStep: data.messaging.nextStep, status: data.messaging.status },
      ...(data.userMemory
        ? [{
          detail: data.userMemory.autoExtract
            ? (data.userMemory.model ? `auto-extract on (model=${data.userMemory.model})` : "auto-extract on")
            : "auto-extract disabled",
          id: "user memory",
          nextStep: data.userMemory.nextStep,
          status: data.userMemory.status
        }]
        : []),
      ...(data.proactive
        ? [{
          detail: data.proactive.enabled
            ? [
              `${data.proactive.providerId ?? "?"} → ${data.proactive.destination ?? "?"}`,
              `lead=${data.proactive.leadMinutes.toString()}min`,
              `tick=${data.proactive.tickMs.toString()}ms`,
              ...(data.proactive.agentTurn ? ["agent-turn=true"] : []),
              ...(data.proactive.quietHours ? [`quiet=${data.proactive.quietHours}`] : [])
            ].join(", ")
            : "disabled",
          id: "proactive",
          nextStep: data.proactive.nextStep,
          status: data.proactive.status
        }]
        : [])
    ]
    : [];
  const todoCount = sections.filter((entry) => entry.status === "todo").length;

  const webSearchEnabled = webSearchSetting.data?.value !== "false";

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
      <div className="setup-toggle-row">
        <label className="setup-toggle-label">
          <input
            type="checkbox"
            checked={webSearchEnabled}
            disabled={updateWebSearch.isPending}
            onChange={(event) => {
              setWebSearchFeedback("");
              updateWebSearch.mutate(event.target.checked);
            }}
          />
          <span>Web search</span>
        </label>
        {webSearchFeedback ? (
          <span style={{ fontSize: "0.78em", color: "var(--muted, #888)" }}>{webSearchFeedback}</span>
        ) : null}
      </div>
    </section>
  );
}
