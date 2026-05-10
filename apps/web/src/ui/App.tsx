import { QueryClient, QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 5_000
    }
  }
});

interface HealthResponse {
  readonly service?: string;
  readonly status?: string;
}

interface ChatResponse {
  readonly content?: string;
  readonly response?: string;
  readonly runId?: string;
  readonly metadata?: Record<string, unknown>;
}

interface SessionSummary {
  readonly id?: string;
  readonly status?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly inputPreview?: string;
}

interface AdminSummary {
  readonly recentRuns?: readonly SessionSummary[];
}

interface ToolCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly risk: "read" | "write" | "execute";
  readonly keywords?: readonly string[];
  readonly scopes?: readonly string[];
}

interface ToolCatalogResponse {
  readonly tools: readonly ToolCatalogEntry[];
  readonly total: number;
}

interface OrchestrationEntry {
  readonly runId: string;
  readonly mode: "sequential" | "parallel";
  readonly status: "completed" | "failed";
  readonly workerCount: number;
  readonly completedCount: number;
  readonly failedCount: number;
  readonly durationMs: number;
  readonly startedAt: string;
  readonly conversationLength?: number;
}

interface OrchestrationListResponse {
  readonly entries: readonly OrchestrationEntry[];
  readonly total: number;
}

interface CalendarCredentialRequirement {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly secret: boolean;
}

interface CalendarProviderInfo {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly local: boolean;
  readonly credentials: readonly CalendarCredentialRequirement[];
}

interface CalendarProvidersResponse {
  readonly providers: readonly CalendarProviderInfo[];
  readonly enabled: readonly string[];
}

interface CalendarCredentialsResponse {
  readonly providers: readonly string[];
}

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

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <MuseConsole />
    </QueryClientProvider>
  );
}

export function MuseConsole() {
  const [apiUrl, setApiUrl] = useState(() => readLocalSetting("muse.apiUrl", "http://127.0.0.1:3000"));
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
        <ChatPanel client={client} />
        <aside className="side-panel">
          <VoicePanel apiUrl={apiUrl} token={token} />
          <TasksPanel client={client} />
          <NotesPanel client={client} />
          <CalendarEventsPanel client={client} />
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
    <form className="connection-form">
      <label>
        <span>API URL</span>
        <input
          value={props.apiUrl}
          onChange={(event) => {
            writeLocalSetting("muse.apiUrl", event.target.value);
            props.onApiUrl(event.target.value);
          }}
        />
      </label>
      <label>
        <span>Token</span>
        <input
          type="password"
          value={props.token}
          onChange={(event) => {
            writeLocalSetting("muse.token", event.target.value);
            props.onToken(event.target.value);
          }}
        />
      </label>
    </form>
  );
}

function ChatPanel({ client }: { readonly client: ApiClient }) {
  const [message, setMessage] = useState("");
  const [latest, setLatest] = useState<ChatResponse | undefined>();
  const chat = useMutation({
    mutationFn: (nextMessage: string) => client.post<ChatResponse>("/api/chat", { message: nextMessage })
  });

  return (
    <section className="tool-surface" aria-label="Ask Muse">
      <div className="surface-heading">
        <h2>Ask Muse</h2>
        <span>{chat.isPending ? "Running" : "Ready"}</span>
      </div>
      <form
        className="chat-form"
        onSubmit={async (event) => {
          event.preventDefault();
          const trimmed = message.trim();

          if (!trimmed) {
            return;
          }

          const response = await chat.mutateAsync(trimmed);
          setLatest(response);
        }}
      >
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Compare two product directions, clarify tradeoffs, or choose a next step."
        />
        <button type="submit" disabled={chat.isPending || message.trim().length === 0}>
          Run
        </button>
      </form>
      <output className="chat-output">
        {chat.error
          ? `Error: ${chat.error instanceof Error ? chat.error.message : "request failed"}`
          : latest?.response ?? latest?.content ?? ""}
      </output>
    </section>
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
            <span>{run.model ?? run.provider ?? run.inputPreview ?? "run"}</span>
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

function TasksPanel({ client }: { readonly client: ApiClient }) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const tasks = useQuery({
    queryFn: () => client.get<TasksResponse>("/api/tasks?status=open"),
    queryKey: ["tasks", "open"]
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

  return (
    <section className="tool-surface compact" aria-label="Tasks">
      <div className="surface-heading">
        <h2>Tasks</h2>
        <span>{tasks.isLoading ? "Loading" : (tasks.data?.total ?? 0)}</span>
      </div>
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

function NotesPanel({ client }: { readonly client: ApiClient }) {
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

function CalendarEventsPanel({ client }: { readonly client: ApiClient }) {
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

function CalendarSettingsPanel({ client }: { readonly client: ApiClient }) {
  const providers = useQuery({
    queryFn: () => client.get<CalendarProvidersResponse>("/api/calendar/providers"),
    queryKey: ["calendar-providers"]
  });
  const credentials = useQuery({
    queryFn: () => client.get<CalendarCredentialsResponse>("/api/calendar/credentials").catch(() => ({ providers: [] as readonly string[] })),
    queryKey: ["calendar-credentials"]
  });
  const [activeProvider, setActiveProvider] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<{ readonly tone: "ok" | "error"; readonly message: string } | null>(null);

  const saveCredentials = useMutation({
    mutationFn: async ({ id, body }: { readonly id: string; readonly body: Record<string, string> }) =>
      client.put<unknown>(`/api/calendar/credentials/${encodeURIComponent(id)}`, body),
    onError: (error) => {
      setFeedback({ message: error instanceof Error ? error.message : "Failed to save credentials", tone: "error" });
    },
    onSuccess: async () => {
      setFeedback({ message: "Saved. Restart muse-api for changes to take effect.", tone: "ok" });
      setActiveProvider(null);
      setDraft({});
      await Promise.all([providers.refetch(), credentials.refetch()]);
    }
  });

  const removeCredentials = useMutation({
    mutationFn: async (id: string) => client.delete<unknown>(`/api/calendar/credentials/${encodeURIComponent(id)}`),
    onError: (error) => {
      setFeedback({ message: error instanceof Error ? error.message : "Failed to remove credentials", tone: "error" });
    },
    onSuccess: async () => {
      setFeedback({ message: "Removed. Restart muse-api to drop the provider.", tone: "ok" });
      await Promise.all([providers.refetch(), credentials.refetch()]);
    }
  });

  const stored = useMemo(() => new Set(credentials.data?.providers ?? []), [credentials.data]);

  return (
    <section className="tool-surface compact" aria-label="Calendar settings">
      <div className="surface-heading">
        <h2>Calendar</h2>
        <span>{providers.isLoading ? "Loading" : (providers.data?.providers.length ?? 0)}</span>
      </div>
      {feedback ? (
        <p className={`status-${feedback.tone === "ok" ? "ok" : "error"}`}>{feedback.message}</p>
      ) : null}
      <ul className="record-list">
        {(providers.data?.providers ?? []).map((provider) => (
          <li key={provider.id}>
            <strong>{provider.displayName}</strong>
            <span className={provider.local ? "risk-read" : "risk-write"}>
              {provider.local ? "local" : stored.has(provider.id) ? "configured" : "needs setup"}
            </span>
            {!provider.local ? (
              <div className="connection-form" style={{ display: "flex", flexDirection: "column", gap: "0.4rem", marginTop: "0.5rem" }}>
                {activeProvider === provider.id ? (
                  <>
                    {provider.credentials.map((field) => (
                      <label key={field.key}>
                        <span>{field.label}</span>
                        <input
                          type={field.secret ? "password" : "text"}
                          placeholder={field.description}
                          value={draft[field.key] ?? ""}
                          onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.value }))}
                        />
                      </label>
                    ))}
                    <div style={{ display: "flex", gap: "0.5rem" }}>
                      <button
                        type="button"
                        onClick={() => {
                          setFeedback(null);
                          saveCredentials.mutate({ body: draft, id: provider.id });
                        }}
                        disabled={saveCredentials.isPending}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setActiveProvider(null);
                          setDraft({});
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </>
                ) : (
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <button
                      type="button"
                      onClick={() => {
                        setActiveProvider(provider.id);
                        setDraft({});
                        setFeedback(null);
                      }}
                    >
                      {stored.has(provider.id) ? "Reconfigure" : "Connect"}
                    </button>
                    {stored.has(provider.id) ? (
                      <button
                        type="button"
                        onClick={() => {
                          setFeedback(null);
                          removeCredentials.mutate(provider.id);
                        }}
                        disabled={removeCredentials.isPending}
                      >
                        Disconnect
                      </button>
                    ) : null}
                  </div>
                )}
              </div>
            ) : null}
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

type VoiceStatus = "idle" | "recording" | "transcribing" | "error";

function VoicePanel(props: { readonly apiUrl: string; readonly token: string }) {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [transcript, setTranscript] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  async function start() {
    setError(null);
    setTranscript("");
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("Microphone API not available in this browser");
      setStatus("error");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        void finalize(recorder.mimeType || "audio/webm");
      };
      recorderRef.current = recorder;
      recorder.start();
      setStatus("recording");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "microphone permission denied");
      setStatus("error");
    }
  }

  function stop() {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      return;
    }
    setStatus("transcribing");
    recorder.stop();
  }

  async function finalize(mimeType: string) {
    try {
      const blob = new Blob(chunksRef.current, { type: mimeType });
      const buffer = await blob.arrayBuffer();
      const audioBase64 = bytesToBase64(new Uint8Array(buffer));
      const response = await fetch(new URL("/api/voice/stt", props.apiUrl).toString(), {
        body: JSON.stringify({ audioBase64, mimeType }),
        headers: {
          "content-type": "application/json",
          ...(props.token ? { authorization: `Bearer ${props.token}` } : {})
        },
        method: "POST"
      });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      const body = await response.json() as { text?: string };
      setTranscript(typeof body.text === "string" ? body.text : "");
      setStatus("idle");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "transcription failed");
      setStatus("error");
    }
  }

  return (
    <section className="tool-surface" aria-label="Voice input">
      <div className="surface-heading">
        <h2>Voice</h2>
        <span>{status}</span>
      </div>
      <div className="voice-controls">
        {status === "recording" ? (
          <button type="button" onClick={stop}>Stop</button>
        ) : (
          <button
            type="button"
            disabled={status === "transcribing"}
            onClick={() => { void start(); }}
          >
            {status === "transcribing" ? "Transcribing..." : "Record"}
          </button>
        )}
      </div>
      {transcript && (
        <output className="voice-output">
          Heard: {transcript}
        </output>
      )}
      {error && (
        <output className="voice-output voice-error">
          Error: {error}
        </output>
      )}
    </section>
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  // Browser-only: this is reached from the MediaRecorder onstop handler,
  // which is gated by `navigator.mediaDevices.getUserMedia`. SSR never
  // runs it. `btoa` is the standard browser global.
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function createApiClient(baseUrl: string, token: string): ApiClient {
  return {
    delete: (path) => request(baseUrl, token, path, undefined, "DELETE"),
    get: (path) => request(baseUrl, token, path),
    post: (path, body) => request(baseUrl, token, path, body, "POST"),
    put: (path, body) => request(baseUrl, token, path, body, "PUT")
  };
}

interface ApiClient {
  readonly get: <T>(path: string) => Promise<T>;
  readonly post: <T>(path: string, body: Record<string, unknown>) => Promise<T>;
  readonly put: <T>(path: string, body: Record<string, unknown>) => Promise<T>;
  readonly delete: <T>(path: string) => Promise<T>;
}

async function request<T>(
  baseUrl: string,
  token: string,
  path: string,
  body?: Record<string, unknown>,
  methodOverride?: "GET" | "POST" | "PUT" | "DELETE"
): Promise<T> {
  const method = methodOverride ?? (body ? "POST" : "GET");
  const response = await fetch(new URL(path, baseUrl).toString(), {
    body: body ? JSON.stringify(body) : undefined,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    method
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
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
