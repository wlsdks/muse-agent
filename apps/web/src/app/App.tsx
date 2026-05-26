import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { createApiClient } from "../api/client.js";
import { Badge, Icon } from "../components/ui.js";
import { I18nProvider, useI18n } from "../i18n/index.js";
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
import type { Lang, StringKey } from "../i18n/index.js";
import type { ComponentType } from "react";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 10_000 } }
});

type ViewId = "today" | "chat" | "tasks" | "calendar" | "reminders" | "notes" | "activity" | "tools" | "settings";
type GroupKey = "group.workspace" | "group.knowledge" | "group.system";

interface NavEntry {
  readonly id: ViewId;
  readonly labelKey: StringKey;
  readonly icon: ComponentType<{ className?: string }>;
  readonly group: GroupKey;
  readonly Component: ComponentType<{ client: ApiClient }>;
}

const NAV: readonly NavEntry[] = [
  { Component: TodayView, group: "group.workspace", icon: Icon.home, id: "today", labelKey: "nav.today" },
  { Component: ChatView, group: "group.workspace", icon: Icon.chat, id: "chat", labelKey: "nav.chat" },
  { Component: TasksView, group: "group.workspace", icon: Icon.task, id: "tasks", labelKey: "nav.tasks" },
  { Component: CalendarView, group: "group.workspace", icon: Icon.calendar, id: "calendar", labelKey: "nav.calendar" },
  { Component: RemindersView, group: "group.workspace", icon: Icon.bell, id: "reminders", labelKey: "nav.reminders" },
  { Component: NotesView, group: "group.knowledge", icon: Icon.note, id: "notes", labelKey: "nav.notes" },
  { Component: ActivityView, group: "group.knowledge", icon: Icon.activity, id: "activity", labelKey: "nav.activity" },
  { Component: ToolsView, group: "group.system", icon: Icon.tool, id: "tools", labelKey: "nav.tools" },
  { Component: SettingsView, group: "group.system", icon: Icon.settings, id: "settings", labelKey: "nav.settings" }
];

const GROUPS: readonly GroupKey[] = ["group.workspace", "group.knowledge", "group.system"];

export function App() {
  return (
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <Console />
      </QueryClientProvider>
    </I18nProvider>
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
  const { lang, setLang, t } = useI18n();
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

  const connected = health.data?.status === "ok";

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div>
            <div className="brand-name">Muse</div>
            <div className="brand-sub">{t("brand.sub")}</div>
          </div>
        </div>

        {GROUPS.map((group) => (
          <div key={group}>
            <div className="nav-group-label">{t(group)}</div>
            {NAV.filter((n) => n.group === group).map((n) => {
              const NavIcon = n.icon;
              return (
                <button
                  key={n.id}
                  className={`nav-item${n.id === view ? " active" : ""}`}
                  onClick={() => setView(n.id)}
                >
                  <NavIcon />
                  <span>{t(n.labelKey)}</span>
                  {n.id === "tasks" && (openTasks.data?.total ?? 0) > 0 && (
                    <span className="nav-badge">{openTasks.data?.total}</span>
                  )}
                </button>
              );
            })}
          </div>
        ))}

        <div className="sidebar-foot">
          <LangToggle lang={lang} onChange={setLang} />
          <Badge tone={connected ? "ok" : health.isLoading ? "neutral" : "err"}>
            {connected ? t("status.connected") : health.isLoading ? t("status.connecting") : t("status.offline")}
          </Badge>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <h2>{t(active.labelKey)}</h2>
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

function LangToggle({ lang, onChange }: { lang: Lang; onChange: (lang: Lang) => void }) {
  return (
    <div className="lang-toggle" role="group" aria-label="Language">
      <button className={lang === "en" ? "active" : ""} onClick={() => onChange("en")}>
        EN
      </button>
      <button className={lang === "ko" ? "active" : ""} onClick={() => onChange("ko")}>
        한
      </button>
    </div>
  );
}
