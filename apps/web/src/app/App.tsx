import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import { createApiClient } from "../api/client.js";
import { CommandPalette } from "../components/CommandPalette.js";
import { NoticeToaster } from "../components/NoticeToaster.js";
import { Badge, Icon } from "../components/ui.js";
import { I18nProvider, useI18n } from "../i18n/index.js";
import { ActivityView } from "../views/Activity.js";
import { BoardView } from "../views/Board.js";
import { CalendarView } from "../views/Calendar.js";
import { AutonomyView } from "../views/Autonomy.js";
import { ChatView } from "../views/Chat.js";
import { DashboardView } from "../views/Dashboard.js";
import { MemoryView } from "../views/Memory.js";
import { IntegrationsView } from "../views/Integrations.js";
import { JourneyView } from "../views/Journey.js";
import { MessagingView } from "../views/Messaging.js";
import { NotesView } from "../views/Notes.js";
import { PromptLab } from "../views/PromptLab.js";
import { RemindersView } from "../views/Reminders.js";
import { SettingsView } from "../views/Settings.js";
import { TasksView } from "../views/Tasks.js";
import { TodayView } from "../views/Today.js";
import { McpServersView } from "../views/McpServers.js";
import { SelfImprovementView } from "../views/SelfImprovement.js";
import { SkillsView } from "../views/Skills.js";
import { ToolsView } from "../views/Tools.js";
import { useShortcuts } from "./useShortcuts.js";

import type { ApiClient } from "../api/client.js";
import type { Command } from "../components/CommandPalette.js";
import type { HealthResponse, TaglineResponse, TasksResponse } from "../api/types.js";
import type { Lang, StringKey, Translate } from "../i18n/index.js";
import type { ComponentType } from "react";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 10_000 } }
});

type ViewId =
  | "today"
  | "chat"
  | "tasks"
  | "board"
  | "calendar"
  | "reminders"
  | "messaging"
  | "integrations"
  | "notes"
  | "memory"
  | "journey"
  | "activity"
  | "autonomy"
  | "dashboard"
  | "tools"
  | "mcp"
  | "self-improvement"
  | "skills"
  | "prompt-lab"
  | "settings";
type GroupKey = "group.workspace" | "group.knowledge" | "group.system";

interface NavEntry {
  readonly id: ViewId;
  readonly labelKey: StringKey;
  readonly key: string;
  readonly icon: ComponentType<{ className?: string }>;
  readonly group: GroupKey;
  readonly Component: ComponentType<{ client: ApiClient; onNavigate?: (view: string) => void }>;
}

export const NAV: readonly NavEntry[] = [
  { Component: TodayView, group: "group.workspace", icon: Icon.home, id: "today", key: "t", labelKey: "nav.today" },
  { Component: ChatView, group: "group.workspace", icon: Icon.chat, id: "chat", key: "c", labelKey: "nav.chat" },
  { Component: TasksView, group: "group.workspace", icon: Icon.task, id: "tasks", key: "k", labelKey: "nav.tasks" },
  { Component: BoardView, group: "group.workspace", icon: Icon.chart, id: "board", key: "b", labelKey: "nav.board" },
  { Component: CalendarView, group: "group.workspace", icon: Icon.calendar, id: "calendar", key: "l", labelKey: "nav.calendar" },
  { Component: RemindersView, group: "group.workspace", icon: Icon.bell, id: "reminders", key: "r", labelKey: "nav.reminders" },
  { Component: MessagingView, group: "group.workspace", icon: Icon.mail, id: "messaging", key: "i", labelKey: "nav.messaging" },
  { Component: IntegrationsView, group: "group.workspace", icon: Icon.plug, id: "integrations", key: "e", labelKey: "nav.integrations" },
  { Component: NotesView, group: "group.knowledge", icon: Icon.note, id: "notes", key: "n", labelKey: "nav.notes" },
  { Component: MemoryView, group: "group.knowledge", icon: Icon.brain, id: "memory", key: "m", labelKey: "nav.memory" },
  { Component: JourneyView, group: "group.knowledge", icon: Icon.clock, id: "journey", key: "u", labelKey: "nav.journey" },
  { Component: ActivityView, group: "group.knowledge", icon: Icon.activity, id: "activity", key: "a", labelKey: "nav.activity" },
  { Component: AutonomyView, group: "group.system", icon: Icon.shield, id: "autonomy", key: "y", labelKey: "nav.autonomy" },
  { Component: DashboardView, group: "group.system", icon: Icon.chart, id: "dashboard", key: "d", labelKey: "nav.dashboard" },
  { Component: ToolsView, group: "group.system", icon: Icon.tool, id: "tools", key: "o", labelKey: "nav.tools" },
  { Component: McpServersView, group: "group.system", icon: Icon.plug, id: "mcp", key: "p", labelKey: "nav.mcp" },
  { Component: SelfImprovementView, group: "group.system", icon: Icon.brain, id: "self-improvement", key: "w", labelKey: "nav.selfImprovement" },
  { Component: SkillsView, group: "group.system", icon: Icon.tool, id: "skills", key: "j", labelKey: "nav.skills" },
  { Component: PromptLab, group: "group.system", icon: Icon.tool, id: "prompt-lab", key: "f", labelKey: "nav.promptLab" },
  { Component: SettingsView, group: "group.system", icon: Icon.settings, id: "settings", key: "s", labelKey: "nav.settings" }
];

const GROUPS: readonly GroupKey[] = ["group.workspace", "group.knowledge", "group.system"];

// Primary sidebar nav. Pure + i18n-free (t injected) so the a11y semantics —
// the navigation landmark and aria-current="page" on the active view — are
// unit-testable via renderToStaticMarkup without a DOM.
export function SidebarNav({
  view,
  taskCount,
  t,
  onSelect
}: {
  readonly view: ViewId;
  readonly taskCount: number;
  readonly t: Translate;
  readonly onSelect: (id: ViewId) => void;
}) {
  return (
    <nav className="sidebar-nav" aria-label={t("nav.primary")}>
      {GROUPS.map((group) => (
        <div key={group}>
          <div className="nav-group-label">{t(group)}</div>
          {NAV.filter((n) => n.group === group).map((n) => {
            const NavIcon = n.icon;
            const current = n.id === view;
            return (
              <button
                key={n.id}
                className={`nav-item${current ? " active" : ""}`}
                aria-current={current ? "page" : undefined}
                onClick={() => onSelect(n.id)}
              >
                <NavIcon />
                <span>{t(n.labelKey)}</span>
                {n.id === "tasks" && taskCount > 0 && <span className="nav-badge">{taskCount}</span>}
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

// The sidebar brand block. Pure + i18n-free (t injected) so the fallback
// behavior — a personalized tagline when present, else the static i18n
// subtitle — is unit-testable via renderToStaticMarkup without a DOM.
export function Brand({ tagline, t }: { readonly tagline?: string; readonly t: Translate }) {
  const sub = tagline && tagline.trim().length > 0 ? tagline : t("brand.sub");
  return (
    <div className="brand">
      <div className="brand-mark">M</div>
      <div>
        <div className="brand-name">Muse</div>
        <div className="brand-sub">{sub}</div>
      </div>
    </div>
  );
}

// Small bilingual dot + label driven by the `/api/health` query — replaces
// showing the raw API URL as chrome. `title` (typically the API URL) stays
// available as a tooltip so the address isn't lost, just no longer the
// primary label. Pure + i18n-injected so state → tone/label is unit-testable
// via renderToStaticMarkup without mocking the health query itself.
export function ConnectionBadge({
  connected,
  loading,
  t,
  title
}: {
  readonly connected: boolean;
  readonly loading: boolean;
  readonly t: Translate;
  readonly title?: string;
}) {
  const tone = connected ? "ok" : loading ? "neutral" : "err";
  const label = connected ? t("status.connected") : loading ? t("status.connecting") : t("status.offline");
  return (
    <span title={title}>
      <Badge tone={tone}>{label}</Badge>
    </span>
  );
}

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
  const [paletteOpen, setPaletteOpen] = useState(false);

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
  // Personalized sidebar subtitle. Fetched once per app open per language
  // (staleTime: Infinity keeps it stable within a session — no flicker); the
  // static i18n `brand.sub` is the instant fallback while it loads / on error.
  const tagline = useQuery({
    queryFn: () => client.get<TaglineResponse>(`/api/identity-tagline?lang=${lang}`),
    queryKey: ["identity-tagline", apiUrl, lang],
    retry: 0,
    staleTime: Infinity
  });

  const active: NavEntry = NAV.find((n) => n.id === view) ?? NAV[0]!;
  const ActiveComponent = active.Component;

  const onLeader = useCallback((key: string) => {
    const target = NAV.find((n) => n.key === key);
    if (target) {
      setView(target.id);
    }
  }, []);
  useShortcuts({ onLeader, onTogglePalette: () => setPaletteOpen((p) => !p) });

  const commands = useMemo<readonly Command[]>(
    () =>
      NAV.map((n) => ({
        group: t("cmd.navigate"),
        hint: `G ${n.key.toUpperCase()}`,
        id: n.id,
        run: () => setView(n.id),
        title: t(n.labelKey)
      })),
    [t]
  );

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
        <Brand tagline={tagline.data?.tagline} t={t} />

        <SidebarNav view={view} taskCount={openTasks.data?.total ?? 0} t={t} onSelect={setView} />

        <div className="sidebar-foot">
          <LangToggle lang={lang} onChange={setLang} />
          <ConnectionBadge connected={connected} loading={health.isLoading} t={t} title={apiUrl} />
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <h2>{t(active.labelKey)}</h2>
          <span className="spacer" />
          <button className="cmd-trigger" onClick={() => setPaletteOpen(true)} title={t("cmd.open")}>
            <span>{t("cmd.search")}</span>
            <kbd>⌘K</kbd>
          </button>
        </header>
        <section className="content">
          <div className="view" key={view}>
            {view === "settings" ? (
              <SettingsView client={client} apiUrl={apiUrl} token={token} onSave={updateConnection} />
            ) : (
              <ActiveComponent client={client} onNavigate={(id) => setView(id as ViewId)} />
            )}
          </div>
        </section>
      </main>

      <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />
      <NoticeToaster client={client} token={token} userId="me" />
    </div>
  );
}

export function LangToggle({ lang, onChange }: { lang: Lang; onChange: (lang: Lang) => void }) {
  return (
    <div className="lang-toggle" role="group" aria-label="Language">
      <button aria-pressed={lang === "en"} className={lang === "en" ? "active" : ""} onClick={() => onChange("en")}>
        EN
      </button>
      <button aria-pressed={lang === "ko"} className={lang === "ko" ? "active" : ""} onClick={() => onChange("ko")}>
        한
      </button>
    </div>
  );
}
