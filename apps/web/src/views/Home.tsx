import { useQuery } from "@tanstack/react-query";

import { Badge, Button, Card, Icon } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";
import { modelChip } from "../lib/model-chip.js";
import { factLabel } from "../lib/memory-labels.js";
import { homeCapabilities, seedChat } from "./home-logic.js";
import { greetingKey } from "./Today.js";

import type { ApiClient } from "../api/client.js";
import type {
  DaemonFlagsResponse,
  EmailStatusResponse,
  HealthResponse,
  MessagingSetupResponse,
  ModelsResponse,
  TodayBriefingResponse,
  UserMemoryResponse
} from "../api/types.js";
import type { Translate } from "../i18n/index.js";
import type { ReactNode } from "react";

interface ReviewThreadsResponse {
  readonly threads?: readonly { readonly id: string; readonly kind: "life" | "work"; readonly linkCount: number; readonly title: string }[];
}

/** One status chip: green dot when ok, amber when attention. Pure (no hooks). */
export function StatusChip({ ok, children, tip }: { ok: boolean; children: ReactNode; tip?: string }) {
  return (
    <span className="status-chip" title={tip}>
      <span className={`model-chip-dot ${ok ? "local" : "cloud"}`} aria-hidden="true" />
      {children}
    </span>
  );
}

/** The 배움 rows on Home: current facts only, humanized labels, and the two
 * correction affordances routed through the agent's real chat path (draft-
 * first) — a UI-side delete would bypass the memory contract. Pure. */
export function LearnedRow({
  factKey,
  value,
  lang,
  t,
  onAsk
}: {
  factKey: string;
  value: string;
  lang: "en" | "ko";
  t: Translate;
  onAsk: (prompt: string) => void;
}) {
  const label = factLabel(factKey, lang);
  return (
    <div className="row">
      <div className="row-main">
        <div className="row-title">{value}</div>
        <div className="row-meta">{label}</div>
      </div>
      <div className="row-actions">
        <Button variant="ghost" size="sm" onClick={() => onAsk(t("home.learned.forgetPrompt", { label, value }))}>
          {t("home.learned.forget")}
        </Button>
      </div>
    </div>
  );
}

/**
 * 홈 — the "state of us" glance: what is connected, what Muse can be asked
 * to do right now, the threads waiting to continue, and what it recently
 * learned (with a correction path). Deliberately NOT the boot view — chat
 * is the front door; Home is one click away as sidebar #1. Every section
 * has a designed empty state so a thin store still reads as a companion,
 * not an empty dashboard.
 */
export function HomeView({ client, onNavigate }: { client: ApiClient; onNavigate?: (view: string) => void }) {
  const { lang, t } = useI18n();
  const navigate = (view: string) => onNavigate?.(view);

  const health = useQuery({
    queryFn: () => client.get<HealthResponse>("/api/health"),
    queryKey: ["health", client.baseUrl]
  });
  const models = useQuery({
    queryFn: () => client.get<ModelsResponse>("/api/models"),
    queryKey: ["models", client.baseUrl],
    staleTime: 60_000
  });
  const messaging = useQuery({
    queryFn: () => client.get<MessagingSetupResponse>("/api/messaging/setup"),
    queryKey: ["messaging-setup", client.baseUrl]
  });
  const email = useQuery({
    queryFn: () => client.get<EmailStatusResponse>("/api/email/status"),
    queryKey: ["email-status", client.baseUrl]
  });
  const daemons = useQuery({
    queryFn: () => client.get<DaemonFlagsResponse>("/api/settings/daemon-flags"),
    queryKey: ["daemon-flags", client.baseUrl]
  });
  const review = useQuery({
    queryFn: () => client.get<ReviewThreadsResponse>("/api/attunement/review"),
    queryKey: ["attunement-review", client.baseUrl]
  });
  const memory = useQuery({
    queryFn: async () => {
      try {
        return await client.get<UserMemoryResponse>("/api/user-memory/default");
      } catch {
        return {} as UserMemoryResponse;
      }
    },
    queryKey: ["memory", client.baseUrl, "default"]
  });
  const brief = useQuery({
    queryFn: () => client.get<TodayBriefingResponse>("/api/today"),
    queryKey: ["today", client.baseUrl]
  });

  const chip = modelChip(models.data?.defaultModel ?? models.data?.active);
  const telegram = messaging.data?.providers.find((p) => p.id === "telegram");
  const replyDaemon = daemons.data?.flags?.find((f) => f.key === "MUSE_INBOUND_REPLY_ENABLED");
  const threads = (review.data?.threads ?? []).slice(0, 2);
  const facts = Object.entries(memory.data?.facts ?? {}).slice(-3).reverse();
  const caps = homeCapabilities({
    emailConfigured: email.data?.configured === true,
    threadCount: review.data?.threads?.length ?? 0
  });

  const tasks = brief.data?.tasks?.length ?? 0;
  const events = brief.data?.events?.length ?? 0;
  const reminders = brief.data?.reminders?.length ?? 0;

  const ask = (prompt: string) => seedChat(prompt, navigate);

  return (
    <div className="content-narrow">
      <p className="eyebrow">{t("nav.home")}</p>
      <div style={{ alignItems: "flex-start", display: "flex", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 className="page-title">{t("today.greetingLine", { greeting: t(greetingKey()) })}</h1>
          <p className="muted" style={{ marginTop: 4 }}>{t("home.subtitle")}</p>
        </div>
        <Button variant="primary" onClick={() => navigate("chat")}>
          <Icon.chat className="nav-icon" /> {t("home.openChat")}
        </Button>
      </div>

      <div className="status-strip" style={{ marginTop: 18 }}>
        {chip && (
          <StatusChip ok={chip.locality !== "cloud"} tip={t("chat.model.tip")}>
            <span className="mono">{chip.name}</span>
            {chip.locality !== "unknown" && <span>· {t(chip.locality === "local" ? "chat.model.local" : "chat.model.cloud")}</span>}
          </StatusChip>
        )}
        <StatusChip ok={health.data?.status === "ok"}>{t(health.data?.status === "ok" ? "home.status.server" : "home.status.serverDown")}</StatusChip>
        {telegram && <StatusChip ok={telegram.configured}>{t(telegram.configured ? "home.status.telegram" : "home.status.telegramOff")}</StatusChip>}
        <StatusChip ok={email.data?.configured === true}>{t(email.data?.configured ? "home.status.email" : "home.status.emailOff")}</StatusChip>
        {replyDaemon && <StatusChip ok={replyDaemon.enabled === true}>{t(replyDaemon.enabled ? "home.status.reply" : "home.status.replyOff")}</StatusChip>}
        <button type="button" className="status-chip status-chip-link" onClick={() => navigate("integrations")}>
          {t("home.status.all")}
        </button>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t("home.cando.title")}>
          <div className="cap-chips">
            {caps.map((cap) =>
              cap.navigate ? (
                <button key={cap.id} type="button" className="cap-chip" onClick={() => navigate(cap.navigate ?? "chat")}>
                  {t(cap.labelKey)}
                </button>
              ) : (
                <button key={cap.id} type="button" className="cap-chip" onClick={() => ask(t(cap.promptKey ?? cap.labelKey))}>
                  {t(cap.labelKey)}
                </button>
              )
            )}
          </div>
        </Card>
      </div>

      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <Card title={t("home.threads.title")} count={threads.length}>
          {threads.length === 0 ? (
            <div className="empty" style={{ padding: "18px 0" }}>
              <div className="empty-title">{t("home.threads.empty")}</div>
              <div className="empty-hint">{t("home.threads.emptyHint")}</div>
            </div>
          ) : (
            <>
              {threads.map((thread) => (
                <div className="row" key={thread.id}>
                  <div className="row-main">
                    <div className="row-title">{thread.title}</div>
                    <div className="row-meta">
                      <Badge tone="neutral">{thread.kind === "life" ? "Life" : "Work"}</Badge>{" "}
                      {t("home.threads.links", { n: thread.linkCount })}
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => navigate("continuity")}>
                    {t("home.threads.resume")}
                  </Button>
                </div>
              ))}
              <div style={{ marginTop: 8 }}>
                <Button variant="ghost" size="sm" onClick={() => navigate("continuity")}>
                  {t("home.threads.all")}
                </Button>
              </div>
            </>
          )}
        </Card>

        <Card title={t("home.learned.title")} count={facts.length}>
          {facts.length === 0 ? (
            <div className="empty" style={{ padding: "18px 0" }}>
              <div className="empty-title">{t("home.learned.empty")}</div>
              <div className="empty-hint">{t("home.learned.emptyHint")}</div>
            </div>
          ) : (
            <>
              {facts.map(([k, v]) => (
                <LearnedRow key={k} factKey={k} value={v} lang={lang} t={t} onAsk={ask} />
              ))}
              <div style={{ marginTop: 8 }}>
                <Button variant="ghost" size="sm" onClick={() => navigate("memory")}>
                  {t("home.learned.all")}
                </Button>
              </div>
            </>
          )}
        </Card>
      </div>

      <div className="todayline" style={{ marginTop: 16 }}>
        <span>{t("home.today.line", { events, reminders, tasks })}</span>
        <button type="button" className="status-chip-link" onClick={() => navigate("today")} style={{ marginLeft: "auto" }}>
          {t("home.today.more")}
        </button>
      </div>
    </div>
  );
}
