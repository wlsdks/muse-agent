import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { createApiClient } from "../api/client.js";
import { Badge, Icon } from "../components/ui.js";
import { ActivityView } from "../views/Activity.js";
import { CalendarView } from "../views/Calendar.js";
import { ChatView } from "../views/Chat.js";
import { NotesView } from "../views/Notes.js";
import { RemindersView } from "../views/Reminders.js";
import { SettingsView } from "../views/Settings.js";
import { TasksView } from "../views/Tasks.js";
import { TodayView } from "../views/Today.js";
import { ToolsView } from "../views/Tools.js";

import type { ApiClient } from "../api/client.js";
import type { HealthResponse, TasksResponse } from "../api/types.js";
import type { ComponentType } from "react";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 10_000 } }
});

type ViewId = "today" | "chat" | "tasks" | "calendar" | "reminders" | "notes" | "activity" | "tools" | "settings";

interface NavEntry {
  readonly id: ViewId;
  readonly label: string;
  readonly icon: ComponentType<{ className?: string }>;
  readonly group: "Workspace" | "Knowledge" | "System";
  readonly Component: ComponentType<{ client: ApiClient }>;
}

const NAV: readonly NavEntry[] = [
  { Component: TodayView, group: "Workspace", icon: Icon.home, id: "today", label: "Today" },
  { Component: ChatView, group: "Workspace", icon: Icon.chat, id: "chat", label: "Chat" },
  { Component: TasksView, group: "Workspace", icon: Icon.task, id: "tasks", label: "Tasks" },
  { Component: CalendarView, group: "Workspace", icon: Icon.calendar, id: "calendar", label: "Calendar" },
  { Component: RemindersView, group: "Workspace", icon: Icon.bell, id: "reminders", label: "Reminders" },
  { Component: NotesView, group: "Knowledge", icon: Icon.note, id: "notes", label: "Notes" },
  { Component: ActivityView, group: "Knowledge", icon: Icon.activity, id: "activity", label: "Activity" },
  { Component: ToolsView, group: "System", icon: Icon.tool, id: "tools", label: "Tools" },
  { Component: SettingsView, group: "System", icon: Icon.settings, id: "settings", label: "Settings" }
];

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Console />
    </QueryClientProvider>
  );
}

function readSetting(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function Console() {
  const [apiUrl, setApiUrl] = useState(() => readSetting("muse.apiUrl", "http://127.0.0.1:3030"));
  const [token, setToken] = useState(() => readSetting("muse.token", ""));
  const [view, setView] = useState<ViewId>("today");

  const client = useMemo(() => createApiClient(apiUrl, token), [apiUrl, token]);

  const health = useQuery({
    queryFn: () => client.get<HealthResponse>("/api/health"),
    queryKey: ["health", apiUrl],
    refetchInterval: 15_000
  });
  const openTasks = useQuery({
    queryFn: () => client.get<TasksResponse>("/api/tasks?status=open"),
    queryKey: ["tasks-count", apiUrl, token]
  });

  const active: NavEntry = NAV.find((n) => n.id === view) ?? NAV[0]!;
  const ActiveComponent = active.Component;

  const updateConnection = (url: string, tok: string) => {
    setApiUrl(url);
    setToken(tok);
    try {
      window.localStorage.setItem("muse.apiUrl", url);
      window.localStorage.setItem("muse.token", tok);
    } catch {
      /* storage unavailable */
    }
    void health.refetch();
  };

  const groups = ["Workspace", "Knowledge", "System"] as const;
  const connected = health.data?.status === "ok";

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div>
            <div className="brand-name">Muse</div>
            <div className="brand-sub">AI Conductor</div>
          </div>
        </div>

        {groups.map((group) => (
          <div key={group}>
            <div className="nav-group-label">{group}</div>
            {NAV.filter((n) => n.group === group).map((n) => {
              const NavIcon = n.icon;
              return (
                <button
                  key={n.id}
                  className={`nav-item${n.id === view ? " active" : ""}`}
                  onClick={() => setView(n.id)}
                >
                  <NavIcon />
                  <span>{n.label}</span>
                  {n.id === "tasks" && (openTasks.data?.total ?? 0) > 0 && (
                    <span className="nav-badge">{openTasks.data?.total}</span>
                  )}
                </button>
              );
            })}
          </div>
        ))}

        <div className="sidebar-foot">
          <Badge tone={connected ? "ok" : health.isLoading ? "neutral" : "err"}>
            {connected ? "Connected" : health.isLoading ? "Connecting" : "Offline"}
          </Badge>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <h2>{active.label}</h2>
          <span className="spacer" />
          <span className="mono subtle">{apiUrl.replace(/^https?:\/\//, "")}</span>
        </header>
        <section className="content">
          {view === "settings" ? (
            <SettingsView client={client} apiUrl={apiUrl} token={token} onSave={updateConnection} />
          ) : (
            <ActiveComponent client={client} />
          )}
        </section>
      </main>
    </div>
  );
}
