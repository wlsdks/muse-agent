import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { Badge, Button, Card, Icon } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";
import { safeSessionStorage } from "../lib/safe-storage.js";
import { modelChip } from "../lib/model-chip.js";
import { factLabel } from "../lib/memory-labels.js";
import { isThreadResumable, OutcomeButtons } from "./continuity-shared.js";
import { OpenedPackCard } from "./ContinuityReview.js";
import { consumeAutoContinueThread, dayRhythmCardState, homeCapabilities, seedChat } from "./home-logic.js";
import { greetingKey, TodaySections } from "./Today.js";

import type { ApiClient } from "../api/client.js";
import type {
  DaemonFlagsResponse,
  DayRhythmStateResponse,
  EmailStatusResponse,
  HealthResponse,
  MessagingSetupResponse,
  ModelsResponse,
  ReconfirmCardResponse,
  UserMemoryResponse
} from "../api/types.js";
import type { OpenedPack, Outcome } from "./continuity-shared.js";
import type { ReviewThreadSummary } from "./continuity-shared.js";
import type { Translate } from "../i18n/index.js";
import type { ReactNode } from "react";

interface ReviewThreadsResponse {
  readonly threads?: readonly ReviewThreadSummary[];
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

const DAY_RHYTHM_QUERY_KEY = "day-rhythm";

/**
 * The Home "하루 리듬" (day rhythm) card — a single opt-in that turns the
 * morning briefing + evening digest from env archaeology into a one-click
 * toggle. Three honest states only (`dayRhythmCardState`): off (default,
 * trust floor), on (armed + shows the paired channel + times), unpaired
 * (turned on but nothing can actually be delivered yet — a deep link to
 * 연동, never a silent no-op).
 */
export function DayRhythmCard({
  client,
  t,
  messagingProviders,
  onNavigate
}: {
  client: ApiClient;
  t: Translate;
  messagingProviders: MessagingSetupResponse["providers"] | undefined;
  onNavigate?: (view: string) => void;
}) {
  const queryClient = useQueryClient();
  const queryKey = [DAY_RHYTHM_QUERY_KEY, client.baseUrl];
  const dayRhythm = useQuery({
    queryFn: () => client.get<DayRhythmStateResponse>("/api/day-rhythm"),
    queryKey
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => client.post<DayRhythmStateResponse>("/api/day-rhythm", { enabled }),
    onSuccess: (next) => queryClient.setQueryData(queryKey, next)
  });

  const state = dayRhythmCardState(dayRhythm.data);
  const busy = toggle.isPending;

  return (
    <Card title={t("home.dayRhythm.title")}>
      {state.kind === "off" && (
        <div className="row">
          <div className="row-main">
            <div className="row-meta">{t("home.dayRhythm.off.explain")}</div>
          </div>
          <Button variant="primary" size="sm" disabled={busy} onClick={() => toggle.mutate(true)}>
            {t("home.dayRhythm.off.button")}
          </Button>
        </div>
      )}
      {state.kind === "unpaired" && (
        <div className="row">
          <div className="row-main">
            <div className="row-meta">{t("home.dayRhythm.unpaired.explain")}</div>
          </div>
          <Button variant="secondary" size="sm" onClick={() => onNavigate?.("integrations")}>
            {t("home.dayRhythm.unpaired.link")}
          </Button>
        </div>
      )}
      {state.kind === "on" && (
        <div className="row">
          <div className="row-main">
            <div className="row-title">
              {t("home.dayRhythm.on.morning", { hour: state.morningHour })} · {t("home.dayRhythm.on.evening", { hour: state.eveningHour })}
            </div>
            <div className="row-meta">
              {t("home.dayRhythm.on.channel", {
                channel: messagingProviders?.find((p) => p.id === state.providerId)?.displayName ?? state.providerId
              })}
            </div>
          </div>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => toggle.mutate(false)}>
            {t("home.dayRhythm.on.button")}
          </Button>
        </div>
      )}
    </Card>
  );
}

const RECONFIRM_CARD_QUERY_KEY = "reconfirm-card";

/**
 * The Home "Muse가 확인하고 싶은 것" card — Muse states ONE uncertain
 * inference about the user (a decayed inferred preference/schedule/veto/goal
 * slot, `selectReconfirmableSlots`' top-1) and the owner confirms or corrects
 * in one tap. A push UI over the SAME pull mechanism `muse user model
 * review` uses server-side — no points/streaks/score, at most one answered
 * per day, and completely silent (renders nothing) when the GET returns no
 * card or errors.
 */
export function ReconfirmCard({ client, t }: { client: ApiClient; t: Translate }) {
  const queryClient = useQueryClient();
  const queryKey = [RECONFIRM_CARD_QUERY_KEY, client.baseUrl];
  const query = useQuery({
    queryFn: () => client.get<ReconfirmCardResponse>("/api/user-model/reconfirm-card"),
    queryKey,
    retry: false
  });
  const [answered, setAnswered] = useState<{ readonly verdict: "confirm" | "reject" } | undefined>();
  const respond = useMutation({
    mutationFn: ({ slotId, verdict }: { readonly slotId: string; readonly verdict: "confirm" | "reject" }) =>
      client.post(`/api/user-model/reconfirm-card/${encodeURIComponent(slotId)}`, { verdict }),
    onSuccess: (_result, variables) => {
      setAnswered({ verdict: variables.verdict });
      return queryClient.invalidateQueries({ queryKey });
    }
  });

  const card = query.data?.card;
  if (!card && !answered) {
    return null;
  }

  return (
    <Card title={t("home.reconfirm.title")}>
      {answered ? (
        <p className="row-meta">{t(answered.verdict === "confirm" ? "home.reconfirm.confirmedAck" : "home.reconfirm.rejectedAck")}</p>
      ) : card ? (
        <div className="row">
          <div className="row-main">
            <Badge tone="neutral">{t("home.reconfirm.guessLabel")}</Badge>
            <div className="row-title" style={{ marginTop: 6 }}>{card.question}</div>
            {card.evidence ? <div className="row-meta">{card.evidence}</div> : null}
            {respond.isError && (
              <div className="row-meta exec-error" style={{ marginTop: 4 }}>{t("home.reconfirm.answerFailed")}</div>
            )}
          </div>
          <div className="row-actions" style={{ gap: 8 }}>
            <Button
              variant="primary"
              size="sm"
              disabled={respond.isPending}
              onClick={() => respond.mutate({ slotId: card.slotId, verdict: "confirm" })}
            >
              {t("home.reconfirm.confirm")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={respond.isPending}
              onClick={() => respond.mutate({ slotId: card.slotId, verdict: "reject" })}
            >
              {t("home.reconfirm.reject")}
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
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
  const queryClient = useQueryClient();
  const [expandedThreadId, setExpandedThreadId] = useState<string | undefined>();
  const [openedPack, setOpenedPack] = useState<OpenedPack | undefined>();
  const [confirmation, setConfirmation] = useState<{ readonly outcome: Outcome; readonly threadId: string } | undefined>();

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
  const continueThread = useMutation({
    mutationFn: (threadId: string) => client.post<OpenedPack>(`/api/attunement/threads/${encodeURIComponent(threadId)}/continue`),
    onSuccess: (result, threadId) => {
      setOpenedPack(result);
      setExpandedThreadId(threadId);
      setConfirmation(undefined);
      return queryClient.invalidateQueries({ queryKey: ["attunement-review", client.baseUrl] });
    }
  });
  const outcome = useMutation({
    mutationFn: ({ deliveryId, value }: { readonly deliveryId: string; readonly threadId: string; readonly value: Outcome }) =>
      client.post(`/api/attunement/deliveries/${encodeURIComponent(deliveryId)}/outcome`, { outcome: value }),
    onSuccess: (_result, variables) => {
      setExpandedThreadId(undefined);
      setOpenedPack(undefined);
      setConfirmation({ outcome: variables.value, threadId: variables.threadId });
      return queryClient.invalidateQueries({ queryKey: ["attunement-review", client.baseUrl] });
    }
  });
  // One-shot handoff from Chat's continuity nudge ("이어서 하기"): open the
  // named thread's Pack inline on mount — the explicit click already
  // happened in Chat, this is its direct continuation, not a fresh
  // autonomous trigger.
  useEffect(() => {
    const threadId = consumeAutoContinueThread(safeSessionStorage());
    if (threadId) {
      continueThread.mutate(threadId);
    }
  }, []);
  const chip = modelChip(models.data?.defaultModel ?? models.data?.active);
  const telegram = messaging.data?.providers.find((p) => p.id === "telegram");
  const replyDaemon = daemons.data?.flags?.find((f) => f.key === "MUSE_INBOUND_REPLY_ENABLED");
  const allThreads = review.data?.threads ?? [];
  // The expanded thread must ALWAYS be among the rendered rows — the chat
  // nudge can hand off a resumable thread that sits below the top-2 slice,
  // and a /continue whose pack renders nowhere would orphan its delivery.
  const threads = (() => {
    const top = allThreads.slice(0, 2);
    if (expandedThreadId && !top.some((thread) => thread.id === expandedThreadId)) {
      const expanded = allThreads.find((thread) => thread.id === expandedThreadId);
      if (expanded) {
        return [expanded, ...top.slice(0, 1)];
      }
    }
    return top;
  })();
  const facts = Object.entries(memory.data?.facts ?? {}).slice(-3).reverse();
  const caps = homeCapabilities({
    emailConfigured: email.data?.configured === true,
    threadCount: review.data?.threads?.length ?? 0
  });

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

      <div style={{ marginTop: 16 }}>
        <DayRhythmCard client={client} messagingProviders={messaging.data?.providers} onNavigate={onNavigate} t={t} />
      </div>

      <div style={{ marginTop: 16 }}>
        <ReconfirmCard client={client} t={t} />
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
              {threads.map((thread) => {
                const resumable = isThreadResumable(thread);
                const expanded = expandedThreadId === thread.id;
                const opening = continueThread.isPending && continueThread.variables === thread.id;
                const openError = continueThread.isError && continueThread.variables === thread.id;
                const confirmed = confirmation?.threadId === thread.id ? confirmation : undefined;
                return (
                  <div key={thread.id}>
                    <div className="row">
                      <div className="row-main">
                        <div className="row-title">{thread.title}</div>
                        <div className="row-meta">
                          <Badge tone="neutral">{thread.kind === "life" ? "Life" : "Work"}</Badge>{" "}
                          {t("home.threads.links", { n: thread.linkCount })}
                        </div>
                      </div>
                      <div className="row-actions">
                        {resumable ? (
                          <Button variant="ghost" size="sm" disabled={opening} onClick={() => continueThread.mutate(thread.id)}>
                            {t("home.threads.nextStep")}
                          </Button>
                        ) : (
                          <Button variant="ghost" size="sm" onClick={() => navigate("continuity")}>
                            {t("home.threads.resume")}
                          </Button>
                        )}
                      </div>
                    </div>
                    {openError ? <p className="banner err" style={{ marginTop: 8 }}>{t("continuity.packError")}</p> : null}
                    {confirmed ? (
                      <p className="row-meta" style={{ marginTop: 4 }}>{t("home.threads.outcomeConfirmed", { outcome: confirmed.outcome })}</p>
                    ) : null}
                    {expanded && openedPack ? (
                      <div style={{ marginTop: 8 }}>
                        <OpenedPackCard openedPack={openedPack} />
                        <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
                          <OutcomeButtons
                            deliveryId={openedPack.delivery.id}
                            disabled={outcome.isPending}
                            onOutcome={(value) => {
                              if (window.confirm(t("continuity.outcomeConfirm", { outcome: value }))) {
                                outcome.mutate({ deliveryId: openedPack.delivery.id, threadId: thread.id, value });
                              }
                            }}
                            t={t}
                          />
                          <Button variant="ghost" size="sm" onClick={() => navigate("continuity")}>
                            {t("home.threads.detail")}
                          </Button>
                        </div>
                        {outcome.isError ? <p className="banner err" style={{ marginTop: 8 }}>{t("continuity.outcomeError")}</p> : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
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
                <Button variant="ghost" size="sm" onClick={() => navigate("notes")}>
                  {t("home.learned.all")}
                </Button>
              </div>
            </>
          )}
        </Card>
      </div>

      <TodaySections client={client} onNavigate={onNavigate} />
    </div>
  );
}
