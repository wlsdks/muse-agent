import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { AsyncBlock, Badge, Button, Card, Empty, Icon } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";
import { safeDateTime } from "../lib/datetime.js";
import { actionResultLabel, objectiveStatusLabel } from "./autonomy-labels.js";
import { nextTabIndex } from "./tabKeyNav.js";
import { timeUntil } from "./Today.js";
import { consumePersonalStatusFocus, focusPersonalStatusTarget } from "./personal-status-navigation.js";

import type { ApiClient } from "../api/client.js";
import type {
  ActionsResponse,
  AutomationUpcomingResponse,
  GatewayRouteStatus,
  ObjectivesResponse,
  ProgressiveAutonomyReviewDecision,
  ProgressiveAutonomyReviewOpportunity,
  ProgressiveAutonomyReviewResponse,
  UpcomingDigestRuntimeDecision,
  UpcomingDigestRuntimeStatus,
  UpcomingFollowupRuntimeDecision,
  UpcomingFollowupRuntimeStatus,
  UpcomingPatternRuntimeDecision,
  UpcomingPatternRuntimeStatus,
  UpcomingProactiveRuntimeDecision,
  UpcomingProactiveRuntimeStatus,
  UpcomingReminderRuntimeDecision,
  UpcomingReminderRuntimeStatus,
  UpcomingDeliveryQueueBucket,
  UpcomingDeliveryQueueSnapshot,
  UpcomingChannelDaemonKind,
  UpcomingChannelRuntime,
  VetoesResponse
} from "../api/types.js";
import type { StringKey, Translate } from "../i18n/index.js";

type Tab = "actions" | "objectives" | "vetoes";
const TABS: readonly { id: Tab; labelKey: StringKey }[] = [
  { id: "actions", labelKey: "auto.tab.actions" },
  { id: "objectives", labelKey: "auto.tab.objectives" },
  { id: "vetoes", labelKey: "auto.tab.vetoes" }
];

function resultTone(result: string): "ok" | "warn" | "err" | "neutral" {
  if (result === "performed") return "ok";
  if (result === "refused") return "warn";
  if (result === "failed") return "err";
  return "neutral";
}
function statusTone(status: string): "ok" | "accent" | "neutral" {
  if (status === "done") return "ok";
  if (status === "active") return "accent";
  return "neutral";
}

export function AutonomyView({ client }: { client: ApiClient }) {
  const { locale, t } = useI18n();
  const [tab, setTab] = useState<Tab>("actions");

  useEffect(() => {
    if (consumePersonalStatusFocus("autonomy") === "vetoes") {
      setTab("vetoes");
      focusPersonalStatusTarget("vetoes");
    }
  }, []);

  return (
    <div className="content-narrow">
      <p className="eyebrow">{t("group.system")}</p>
      <h1 className="page-title">{t("nav.autonomy")}</h1>
      <p className="muted" style={{ marginTop: 4 }}>
        {t("auto.subtitle")}
      </p>

      <div style={{ marginTop: 16 }}>
        <ShadowReviewCard client={client} locale={locale} />
      </div>

      <div className="tabs" style={{ margin: "16px 0" }} role="tablist" aria-label={t("nav.autonomy")}>
        {TABS.map((entry, i) => (
          <button
            key={entry.id}
            role="tab"
            aria-selected={tab === entry.id}
            tabIndex={tab === entry.id ? 0 : -1}
            className={`tab${tab === entry.id ? " active" : ""}`}
            onClick={() => setTab(entry.id)}
            onKeyDown={(e) => {
              const next = nextTabIndex(i, e.key, TABS.length);
              const target = TABS[next];
              if (target && next !== i) {
                e.preventDefault();
                setTab(target.id);
              }
            }}
          >
            {t(entry.labelKey)}
          </button>
        ))}
      </div>

      {tab === "actions" && <ActionsTab client={client} locale={locale} />}
      {tab === "objectives" && <ObjectivesTab client={client} locale={locale} />}
      {tab === "vetoes" && <div id="vetoes" tabIndex={-1}><VetoesTab client={client} locale={locale} /></div>}
    </div>
  );
}

const REVIEW_QUERY_KEY = "autonomy-review";
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

function sourceAllowsDecision(
  opportunity: ProgressiveAutonomyReviewOpportunity,
  decision: ProgressiveAutonomyReviewDecision
): boolean {
  return opportunity.currentSource.state !== "unavailable"
    && !(opportunity.currentSource.state === "stale" && decision === "would-approve");
}

function ShadowReviewCard({ client, locale }: { client: ApiClient; locale: string }) {
  const { t } = useI18n();
  const queryKey = [REVIEW_QUERY_KEY, client.baseUrl] as const;
  const q = useQuery({
    queryFn: () => client.get<ProgressiveAutonomyReviewResponse>("/api/autonomy/review"),
    queryKey
  });

  return (
    <Card title={t("auto.review.title")}>
      <p className="subtle" style={{ fontSize: 12, marginTop: -4, marginBottom: 12 }}>
        {t("auto.review.notice")}
      </p>
      <div aria-live="polite">
        <AsyncBlock
          loading={q.isLoading}
          error={q.error}
          empty={q.data?.opportunity === null}
          emptyLabel={t("auto.review.empty")}
        >
          {q.data?.opportunity && (
            <ShadowReviewOpportunityForm
              key={q.data.opportunity.opportunityId}
              client={client}
              locale={locale}
              opportunity={q.data.opportunity}
              queryKey={queryKey}
              refetching={q.isFetching}
              onRefetch={async () => { await q.refetch(); }}
            />
          )}
        </AsyncBlock>
      </div>
    </Card>
  );
}

function ShadowReviewOpportunityForm({
  client,
  locale,
  opportunity,
  queryKey,
  refetching,
  onRefetch
}: {
  readonly client: ApiClient;
  readonly locale: string;
  readonly opportunity: ProgressiveAutonomyReviewOpportunity;
  readonly queryKey: readonly [typeof REVIEW_QUERY_KEY, string];
  readonly refetching: boolean;
  readonly onRefetch: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const [decision, setDecision] = useState<ProgressiveAutonomyReviewDecision | null>(null);
  const [reason, setReason] = useState("");
  const normalizedReason = reason.trim();
  const { t } = useI18n();
  const reasonError = CONTROL_CHARACTER_PATTERN.test(normalizedReason) || normalizedReason.length > 500
    ? t("auto.review.reasonInvalid")
    : null;
  const mutation = useMutation({
    mutationFn: async (input: {
      readonly decision: ProgressiveAutonomyReviewDecision;
      readonly opportunityId: string;
      readonly reason?: string;
    }) => client.post(
      `/api/autonomy/opportunities/${encodeURIComponent(input.opportunityId)}/decision`,
      { decision: input.decision, ...(input.reason === undefined ? {} : { reason: input.reason }) }
    ),
    onError: async () => {
      await onRefetch();
    },
    onSuccess: async () => {
      setDecision(null);
      setReason("");
      await queryClient.invalidateQueries({ queryKey });
    },
    retry: false
  });
  const busy = mutation.isPending || refetching;

  return (
    <ShadowReviewForm
      busy={busy}
      decision={decision}
      locale={locale}
      mutationError={mutation.error}
      opportunity={opportunity}
      reason={reason}
      reasonError={reasonError}
      onDecision={setDecision}
      onReason={setReason}
      onSubmit={() => {
        if (!decision || reasonError || !sourceAllowsDecision(opportunity, decision)) return;
        mutation.mutate({
          decision,
          opportunityId: opportunity.opportunityId,
          ...(normalizedReason.length === 0 ? {} : { reason: normalizedReason })
        });
      }}
    />
  );
}

function ShadowReviewForm({
  busy,
  decision,
  locale,
  mutationError,
  opportunity,
  reason,
  reasonError,
  onDecision,
  onReason,
  onSubmit
}: {
  readonly busy: boolean;
  readonly decision: ProgressiveAutonomyReviewDecision | null;
  readonly locale: string;
  readonly mutationError: Error | null;
  readonly opportunity: ProgressiveAutonomyReviewOpportunity;
  readonly reason: string;
  readonly reasonError: string | null;
  readonly onDecision: (decision: ProgressiveAutonomyReviewDecision) => void;
  readonly onReason: (reason: string) => void;
  readonly onSubmit: () => void;
}) {
  const { t } = useI18n();
  const options: readonly { readonly label: StringKey; readonly value: ProgressiveAutonomyReviewDecision }[] = [
    { label: "auto.review.wouldApprove", value: "would-approve" },
    { label: "auto.review.wouldDeny", value: "would-deny" },
    { label: "auto.review.needsAdjustment", value: "needs-adjustment" }
  ];
  const sourceState = opportunity.currentSource.state;
  const sourceUnavailable = sourceState === "unavailable";
  const decisionAllowed = decision === null || sourceAllowsDecision(opportunity, decision);
  const sourceLabel = t(`auto.review.source.${sourceState}`);
  const sourceTone = sourceState === "exact" ? "ok" : sourceState === "stale" ? "warn" : "err";

  return (
    <form onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div className="row-main">
          <div className="label">{t("auto.review.action")}</div>
          <div className="row-title">{opportunity.action}</div>
          <div className="row-meta">{t("auto.review.scope", { taskId: opportunity.taskId, threadId: opportunity.threadId })}</div>
          <div className="row-meta">{t("auto.review.linkedAt", { when: safeDateTime(opportunity.linkedAt, locale) })}</div>
          <div className="row-meta">{t("auto.review.recordedAt", { when: safeDateTime(opportunity.recordedAt, locale) })}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="label">{t("auto.review.source")}</div>
          <Badge tone={sourceTone}>{sourceLabel}</Badge>
          {sourceState !== "exact" && (
            <div className="row-meta" style={{ marginTop: 4 }}>{opportunity.currentSource.reason}</div>
          )}
        </div>
      </div>
      <dl style={{ display: "grid", gap: 8, margin: "12px 0" }}>
        <div>
          <dt className="label">{t("auto.review.assessment")}</dt>
          <dd style={{ margin: 0 }}>{opportunity.shadowAssessment}</dd>
        </div>
        <div>
          <dt className="label">{t("auto.review.rationale")}</dt>
          <dd className="subtle" style={{ margin: 0 }}>{opportunity.shadowRationale}</dd>
        </div>
      </dl>
      <fieldset disabled={busy || sourceUnavailable} style={{ border: 0, margin: "12px 0", padding: 0 }}>
        <legend className="label">{t("auto.review.decision")}</legend>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          {options.map((option) => (
            <label key={option.value}>
              <input
                checked={decision === option.value}
                disabled={sourceState === "stale" && option.value === "would-approve"}
                name="autonomy-shadow-decision"
                type="radio"
                value={option.value}
                onChange={() => onDecision(option.value)}
              />{" "}{t(option.label)}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="label" htmlFor="autonomy-shadow-reason">{t("auto.review.reason")}</label>
      <textarea
        aria-describedby={reasonError ? "autonomy-shadow-reason-error" : undefined}
        aria-invalid={reasonError ? true : undefined}
        className="textarea"
        disabled={busy || sourceUnavailable}
        id="autonomy-shadow-reason"
        placeholder={t("auto.review.reasonPlaceholder")}
        value={reason}
        onChange={(event) => onReason(event.target.value)}
      />
      {reasonError && <p className="field-error" id="autonomy-shadow-reason-error" role="alert">{reasonError}</p>}
      {mutationError && <p className="field-error" role="alert">{t("auto.review.failed")}</p>}
      <div style={{ marginTop: 12 }}>
        <Button disabled={busy || sourceUnavailable || decision === null || !decisionAllowed || reasonError !== null} type="submit" variant="primary">
          {busy ? t("auto.review.submitting") : t("auto.review.submit")}
        </Button>
      </div>
    </form>
  );
}

export function UpcomingTab({ client }: { client: ApiClient }) {
  const { locale, t } = useI18n();
  const q = useQuery({
    queryFn: () => client.get<AutomationUpcomingResponse>("/api/automation/upcoming"),
    queryKey: ["automation-upcoming", client.baseUrl]
  });
  return (
    <AsyncBlock loading={q.isLoading} error={q.error} empty={false}>
      {q.data && <UpcomingSections data={q.data} t={t} locale={locale} />}
    </AsyncBlock>
  );
}

/**
 * Pure presentational render of the upcoming-automation sections —
 * kept separate from `UpcomingTab` so it's directly testable with a
 * constructed `AutomationUpcomingResponse`, no query resolution needed.
 * Digest, budget, jobs, and reminder sections render only when their data is
 * non-null/non-empty. Gateway and runtime cards always remain visible so
 * held/unavailable and not-yet-observed state stays explicit.
 */
export function UpcomingSections({
  data,
  t,
  locale
}: {
  data: AutomationUpcomingResponse;
  t: Translate;
  locale: string;
}) {
  const hasDigest = data.digest !== null;
  const hasDigestRuntime = data.digestRuntime !== null && data.digestRuntime !== undefined;
  const hasDigestCard = hasDigest || hasDigestRuntime;
  const hasBudget = data.budget !== null;
  const hasJobs = data.scheduledJobs.length > 0;
  const hasReminder = data.nextReminder !== null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {!hasDigestCard && !hasBudget && !hasJobs && !hasReminder && (
        <Empty icon={<Icon.clock />} hint={t("auto.upcoming.emptyHint")}>
          {t("auto.upcoming.emptyTitle")}
        </Empty>
      )}
      <GatewayCard gateway={data.gateway} t={t} />
      <ChannelRuntimeCard runtime={data.channelRuntime ?? null} t={t} locale={locale} />
      <DeliveryQueueCard snapshot={data.deliveryQueueSnapshot ?? null} t={t} locale={locale} />
      {hasDigestCard && <DigestCard digest={data.digest} digestRuntime={data.digestRuntime ?? null} t={t} locale={locale} />}
      <ProactiveRuntimeCard runtime={data.proactiveRuntime} t={t} locale={locale} />
      <PatternRuntimeCard runtime={data.patternRuntime ?? null} t={t} locale={locale} />
      {data.budget && <BudgetCard budget={data.budget} t={t} />}
      {data.scheduledJobs.length > 0 && <JobsCard jobs={data.scheduledJobs} t={t} locale={locale} />}
      {data.nextReminder && <ReminderCard reminder={data.nextReminder} t={t} locale={locale} />}
      <ReminderRuntimeCard runtime={data.reminderRuntime ?? null} t={t} locale={locale} />
      <FollowupRuntimeCard runtime={data.followupRuntime ?? null} t={t} locale={locale} />
    </div>
  );
}

function DeliveryQueueCard({
  snapshot,
  t,
  locale
}: {
  snapshot: UpcomingDeliveryQueueSnapshot | null;
  t: Translate;
  locale: string;
}) {
  const tone = snapshot?.status === "observed" ? "ok" : "warn";
  return (
    <Card title={t("auto.upcoming.deliveryQueue.title")}>
      <div className="row">
        <div className="row-main">
          {snapshot ? (
            <>
              <div className="row-title">{t("auto.upcoming.deliveryQueue.generatedAt", {
                when: safeDateTime(snapshot.generatedAt, locale) || t("auto.upcoming.deliveryQueue.timeUnavailable")
              })}</div>
              <div className="row-meta">{t("auto.upcoming.deliveryQueue.pending", {
                count: boundedDeliveryQueueCount(snapshot.pendingDrafts.count),
                age: formatDeliveryQueueAge(snapshot.pendingDrafts.oldestAgeMs, t)
              })}</div>
              <div className="row-meta">{t("auto.upcoming.deliveryQueue.followups", {
                overdue: formatDeliveryQueueBucket(snapshot.followups.overdue, t),
                scheduled: formatDeliveryQueueBucket(snapshot.followups.scheduled, t)
              })}</div>
              <div className="row-meta">{t("auto.upcoming.deliveryQueue.reminders", {
                overdue: formatDeliveryQueueBucket(snapshot.reminders.overdue, t),
                scheduled: formatDeliveryQueueBucket(snapshot.reminders.scheduled, t)
              })}</div>
            </>
          ) : (
            <div className="row-title">{t("auto.upcoming.deliveryQueue.unavailable")}</div>
          )}
        </div>
        <Badge tone={tone}>{t(snapshot?.status === "observed"
          ? "auto.upcoming.deliveryQueue.status.observed"
          : "auto.upcoming.deliveryQueue.status.unverified")}</Badge>
      </div>
      <p className="subtle" style={{ fontSize: 12, marginTop: 8 }}>
        {t("auto.upcoming.deliveryQueue.previewOnly")}
      </p>
    </Card>
  );
}

function channelDaemonKindKey(kind: UpcomingChannelDaemonKind | string): StringKey {
  switch (kind) {
    case "telegram-poll": return "auto.upcoming.channelRuntime.daemon.telegramPoll";
    case "matrix-sync": return "auto.upcoming.channelRuntime.daemon.matrixSync";
    case "inbound-reply": return "auto.upcoming.channelRuntime.daemon.inboundReply";
    case "matrix-inbound-reply": return "auto.upcoming.channelRuntime.daemon.matrixInboundReply";
    case "slack-poll": return "auto.upcoming.channelRuntime.daemon.slackPoll";
    case "discord-poll": return "auto.upcoming.channelRuntime.daemon.discordPoll";
    default: return "auto.upcoming.channelRuntime.daemon.unknown";
  }
}

function channelRuntimeStatusKey(status: UpcomingChannelRuntime["status"] | string): StringKey {
  switch (status) {
    case "observed": return "auto.upcoming.channelRuntime.status.observed";
    case "degraded": return "auto.upcoming.channelRuntime.status.degraded";
    default: return "auto.upcoming.channelRuntime.status.unconfigured";
  }
}

function ChannelRuntimeCard({
  runtime,
  t,
  locale
}: {
  runtime: UpcomingChannelRuntime | null;
  t: Translate;
  locale: string;
}) {
  const status = runtime?.status ?? "unconfigured";
  const daemons = runtime?.daemons ?? [];
  const tone = status === "observed" ? "ok" : status === "degraded" ? "warn" : "neutral";
  return (
    <Card title={t("auto.upcoming.channelRuntime.title")}>
      <div className="row">
        <div className="row-main">
          <div className="row-title">{t(channelRuntimeStatusKey(status))}</div>
          {daemons.length === 0 && (
            <div className="row-meta">{t("auto.upcoming.channelRuntime.noObservation")}</div>
          )}
        </div>
        <Badge tone={tone}>{t(channelRuntimeStatusKey(status))}</Badge>
      </div>
      {daemons.map((daemon) => (
        <div className="row" key={daemon.kind}>
          <div className="row-main">
            <div className="row-title">{t(channelDaemonKindKey(daemon.kind))}</div>
            <div className="row-meta">
              {t("auto.upcoming.channelRuntime.ingest", {
                count: formatChannelRuntimeCount(daemon.lastIngestCount, t),
                when: formatChannelRuntimeTime(daemon.lastIngestAtIso, locale, t)
              })}
            </div>
            {daemon.hasError && (
              <div className="row-meta">
                {t("auto.upcoming.channelRuntime.errorObserved", {
                  when: formatChannelRuntimeTime(daemon.lastErrorAtIso, locale, t)
                })}
              </div>
            )}
          </div>
          <Badge tone={daemon.hasError ? "warn" : daemon.running ? "ok" : "neutral"}>
            {daemon.running
              ? t("auto.upcoming.channelRuntime.running")
              : t("auto.upcoming.channelRuntime.stopped")}
          </Badge>
        </div>
      ))}
      <p className="subtle" style={{ fontSize: 12, marginTop: 8 }}>
        {t("auto.upcoming.channelRuntime.previewOnly")}
      </p>
    </Card>
  );
}

function formatChannelRuntimeCount(value: number | null, t: Translate): string {
  if (value === null || !Number.isFinite(value)) return t("auto.upcoming.channelRuntime.countUnavailable");
  return boundedRuntimeCount(value).toString();
}

function formatChannelRuntimeTime(value: string | null, locale: string, t: Translate): string {
  return value ? safeDateTime(value, locale) || t("auto.upcoming.channelRuntime.timeUnavailable") : t("auto.upcoming.channelRuntime.timeUnavailable");
}

function formatDeliveryQueueBucket(bucket: UpcomingDeliveryQueueBucket, t: Translate): string {
  return t("auto.upcoming.deliveryQueue.bucket", {
    age: formatDeliveryQueueAge(bucket.oldestAgeMs, t),
    count: boundedDeliveryQueueCount(bucket.count)
  });
}

function formatDeliveryQueueAge(value: number | null, t: Translate): string {
  const ageMs = boundedDeliveryQueueAge(value);
  if (ageMs === null) return t("auto.upcoming.deliveryQueue.ageUnavailable");
  if (ageMs < 60_000) return t("auto.upcoming.deliveryQueue.ageMinutes", { value: 0 });
  if (ageMs < 60 * 60_000) return t("auto.upcoming.deliveryQueue.ageMinutes", { value: Math.floor(ageMs / 60_000) });
  if (ageMs < 24 * 60 * 60_000) return t("auto.upcoming.deliveryQueue.ageHours", { value: Math.floor(ageMs / (60 * 60_000)) });
  return t("auto.upcoming.deliveryQueue.ageDays", { value: Math.floor(ageMs / (24 * 60 * 60_000)) });
}

function boundedDeliveryQueueCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(9_999, Math.max(0, Math.trunc(value)));
}

function boundedDeliveryQueueAge(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.min(1000 * 60 * 60 * 24 * 365 * 100, Math.max(0, Math.trunc(value)));
}

function digestRuntimeDecisionKey(decision: UpcomingDigestRuntimeDecision | string): StringKey {
  switch (decision) {
    case "already-running": return "auto.upcoming.digestRuntime.decision.alreadyRunning";
    case "already-sent-today": return "auto.upcoming.digestRuntime.decision.alreadySentToday";
    case "cancelled-before-claim": return "auto.upcoming.digestRuntime.decision.cancelledBeforeClaim";
    case "empty": return "auto.upcoming.digestRuntime.decision.empty";
    case "error": return "auto.upcoming.digestRuntime.decision.error";
    case "lock-error": return "auto.upcoming.digestRuntime.decision.lockError";
    case "lock-held": return "auto.upcoming.digestRuntime.decision.lockHeld";
    case "not-due": return "auto.upcoming.digestRuntime.decision.notDue";
    case "preflight-failed": return "auto.upcoming.digestRuntime.decision.preflightFailed";
    case "quiet-hours": return "auto.upcoming.digestRuntime.decision.quietHours";
    case "route-unavailable": return "auto.upcoming.digestRuntime.decision.routeUnavailable";
    case "send-failed": return "auto.upcoming.digestRuntime.decision.sendFailed";
    case "sent": return "auto.upcoming.digestRuntime.decision.sent";
    default: return "auto.upcoming.digestRuntime.decision.unknown";
  }
}

function proactiveRuntimeDecisionKey(decision: UpcomingProactiveRuntimeDecision | string): StringKey {
  switch (decision) {
    case "already-running": return "auto.upcoming.proactiveRuntime.decision.alreadyRunning";
    case "quiet-hours": return "auto.upcoming.proactiveRuntime.decision.quietHours";
    case "route-unavailable": return "auto.upcoming.proactiveRuntime.decision.routeUnavailable";
    case "session-locked": return "auto.upcoming.proactiveRuntime.decision.sessionLocked";
    case "lock-held": return "auto.upcoming.proactiveRuntime.decision.lockHeld";
    case "lock-error": return "auto.upcoming.proactiveRuntime.decision.lockError";
    case "no-imminent": return "auto.upcoming.proactiveRuntime.decision.noImminent";
    case "suppressed": return "auto.upcoming.proactiveRuntime.decision.suppressed";
    case "fired": return "auto.upcoming.proactiveRuntime.decision.fired";
    case "completed": return "auto.upcoming.proactiveRuntime.decision.completed";
    case "error": return "auto.upcoming.proactiveRuntime.decision.error";
    default: return "auto.upcoming.proactiveRuntime.decision.unknown";
  }
}

function reminderRuntimeDecisionKey(decision: UpcomingReminderRuntimeDecision | string): StringKey {
  switch (decision) {
    case "not-configured": return "auto.upcoming.reminderRuntime.decision.notConfigured";
    case "already-running": return "auto.upcoming.reminderRuntime.decision.alreadyRunning";
    case "quiet-hours": return "auto.upcoming.reminderRuntime.decision.quietHours";
    case "lock-held": return "auto.upcoming.reminderRuntime.decision.lockHeld";
    case "lock-error": return "auto.upcoming.reminderRuntime.decision.lockError";
    case "no-due": return "auto.upcoming.reminderRuntime.decision.noDue";
    case "fired": return "auto.upcoming.reminderRuntime.decision.fired";
    case "completed": return "auto.upcoming.reminderRuntime.decision.completed";
    case "error": return "auto.upcoming.reminderRuntime.decision.error";
    default: return "auto.upcoming.reminderRuntime.decision.unknown";
  }
}

function patternRuntimeDecisionKey(decision: UpcomingPatternRuntimeDecision | string): StringKey {
  switch (decision) {
    case "not-configured": return "auto.upcoming.patternRuntime.decision.notConfigured";
    case "already-running": return "auto.upcoming.patternRuntime.decision.alreadyRunning";
    case "quiet-hours": return "auto.upcoming.patternRuntime.decision.quietHours";
    case "lock-held": return "auto.upcoming.patternRuntime.decision.lockHeld";
    case "lock-error": return "auto.upcoming.patternRuntime.decision.lockError";
    case "no-fireable": return "auto.upcoming.patternRuntime.decision.noFireable";
    case "fired": return "auto.upcoming.patternRuntime.decision.fired";
    case "completed": return "auto.upcoming.patternRuntime.decision.completed";
    case "error": return "auto.upcoming.patternRuntime.decision.error";
    default: return "auto.upcoming.patternRuntime.decision.unknown";
  }
}

function PatternRuntimeCard({
  runtime,
  t,
  locale
}: {
  runtime: UpcomingPatternRuntimeStatus | null;
  t: Translate;
  locale: string;
}) {
  return (
    <Card title={t("auto.upcoming.patternRuntime.title")}>
      {runtime ? (
        <PatternRuntimeStatus runtime={runtime} t={t} locale={locale} />
      ) : (
        <div className="row">
          <p className="subtle" style={{ fontSize: 12, margin: 0 }}>
            {t("auto.upcoming.patternRuntime.noObservation")}
          </p>
          <Badge tone="warn">{t("auto.upcoming.patternRuntime.decision.notConfigured")}</Badge>
        </div>
      )}
      <p className="subtle" style={{ fontSize: 12, marginTop: 8 }}>
        {t("auto.upcoming.patternRuntime.previewOnly")}
      </p>
    </Card>
  );
}

function PatternRuntimeStatus({
  runtime,
  t,
  locale
}: {
  runtime: UpcomingPatternRuntimeStatus;
  t: Translate;
  locale: string;
}) {
  const observedAt = safeDateTime(runtime.lastObservedAtIso, locale) || t("auto.upcoming.patternRuntime.timeUnavailable");
  const notConfigured = runtime.lastDecision === "not-configured";
  return (
    <div>
      <div className="row">
        <div className="row-main">
          <div className="row-title">{t(patternRuntimeDecisionKey(runtime.lastDecision))}</div>
          <div className="row-meta">{t("auto.upcoming.patternRuntime.observed", { when: observedAt })}</div>
          <div className="row-meta">
            {t("auto.upcoming.patternRuntime.counts", {
              delivered: boundedRuntimeCount(runtime.lastDeliveredCount),
              errors: boundedRuntimeCount(runtime.lastErrorCount),
              fireable: boundedRuntimeCount(runtime.lastFireableCount),
              fired: boundedRuntimeCount(runtime.lastFiredCount)
            })}
          </div>
        </div>
        <Badge tone={notConfigured ? "warn" : "neutral"}>
          {notConfigured
            ? t("auto.upcoming.patternRuntime.decision.notConfigured")
            : t("auto.upcoming.patternRuntime.previewBadge")}
        </Badge>
      </div>
    </div>
  );
}

function gatewayStatusKey(status: GatewayRouteStatus["status"]): StringKey {
  switch (status) {
    case "resolved": return "auto.upcoming.gateway.resolved";
    case "ambiguous": return "auto.upcoming.gateway.ambiguous";
    case "blocked-local-only": return "auto.upcoming.gateway.blockedLocalOnly";
    case "unconfigured": return "auto.upcoming.gateway.unconfigured";
  }
}

function gatewayReasonKey(reason: NonNullable<GatewayRouteStatus["reason"]>): StringKey {
  switch (reason) {
    case "explicit-route-incomplete": return "auto.upcoming.gateway.reason.explicitRouteIncomplete";
    case "explicit-provider-not-registered": return "auto.upcoming.gateway.reason.explicitProviderNotRegistered";
    case "remote-route-blocked-by-local-only": return "auto.upcoming.gateway.reason.remoteBlockedLocalOnly";
    case "paired-route-inspection-unavailable": return "auto.upcoming.gateway.reason.inspectionUnavailable";
    case "no-single-paired-route": return "auto.upcoming.gateway.reason.noSinglePairedRoute";
    case "multiple-paired-routes": return "auto.upcoming.gateway.reason.multiplePairedRoutes";
  }
}

function GatewayCard({ gateway, t }: { gateway: GatewayRouteStatus; t: Translate }) {
  const route = gateway.providerId && gateway.destination
    ? `${gateway.providerId}:${gateway.destination}`
    : null;
  const tone = gateway.status === "resolved" ? "ok" : gateway.status === "blocked-local-only" || gateway.status === "ambiguous" ? "warn" : "neutral";
  const source = gateway.source === "explicit-config"
    ? t("auto.upcoming.gateway.sourceExplicit")
    : gateway.source === "paired-owner"
      ? t("auto.upcoming.gateway.sourcePaired")
      : t("auto.upcoming.gateway.sourceNone");
  const detail = gateway.reason ? `${source} · ${t(gatewayReasonKey(gateway.reason))}` : source;
  return (
    <Card title={t("auto.upcoming.gatewayTitle")}>
      <div className="row">
        <div className="row-main">
          <div className="label">{t("auto.upcoming.gateway.currentRoute")}</div>
          <div className="row-title">{route ?? t(gatewayStatusKey(gateway.status))}</div>
          <div className="row-meta">{detail}</div>
        </div>
        <Badge tone={tone}>{t(gatewayStatusKey(gateway.status))}</Badge>
      </div>
      <p className="subtle" style={{ fontSize: 12, marginTop: 8 }}>
        {t("auto.upcoming.gatewayNoSend")}
      </p>
    </Card>
  );
}

function DigestCard({
  digest,
  digestRuntime,
  t,
  locale
}: {
  digest: AutomationUpcomingResponse["digest"];
  digestRuntime: UpcomingDigestRuntimeStatus | null;
  t: Translate;
  locale: string;
}) {
  const when = digest ? timeUntil(digest.nextAtIso, t) || safeDateTime(digest.nextAtIso, locale) : null;
  return (
    <Card title={t("auto.upcoming.digestTitle")}>
      {digest && (
        <div className="row">
          <div className="row-main">
            <div className="row-title">{t("auto.upcoming.digestLine", { hour: digest.hour, when: when ?? "" })}</div>
          </div>
          {!digest.enabled && <Badge tone="neutral">{t("auto.upcoming.digestOff")}</Badge>}
        </div>
      )}
      {digestRuntime ? (
        <DigestRuntimeStatus runtime={digestRuntime} t={t} locale={locale} />
      ) : (
        <p className="subtle" style={{ fontSize: 12, marginTop: digest ? 8 : 0 }}>
          {t("auto.upcoming.digestRuntime.noObservation")}
        </p>
      )}
    </Card>
  );
}

function DigestRuntimeStatus({
  runtime,
  t,
  locale
}: {
  runtime: UpcomingDigestRuntimeStatus;
  t: Translate;
  locale: string;
}) {
  const observedAt = safeDateTime(runtime.lastObservedAtIso, locale) || t("auto.upcoming.digestRuntime.timeUnavailable");
  return (
    <div style={{ marginTop: 8 }}>
      <div className="row">
        <div className="row-main">
          <div className="row-title">{t(digestRuntimeDecisionKey(runtime.lastDecision))}</div>
          <div className="row-meta">{t("auto.upcoming.digestRuntime.observed", { when: observedAt })}</div>
          <div className="row-meta">
            {t("auto.upcoming.digestRuntime.counts", { errors: runtime.lastErrorCount, items: runtime.lastItemCount })}
          </div>
          <div className="row-meta">
            <span className="label">{t("auto.upcoming.runtimeRoute.lastExecution")}: </span>
            {formatRuntimeRoute(runtime.lastRoute, t)}
          </div>
        </div>
        <Badge tone="neutral">{t("auto.upcoming.digestRuntime.previewBadge")}</Badge>
      </div>
      <p className="subtle" style={{ fontSize: 12, marginTop: 8 }}>
        {t("auto.upcoming.digestRuntime.previewOnly")}
      </p>
    </div>
  );
}

function ProactiveRuntimeCard({
  runtime,
  t,
  locale
}: {
  runtime: UpcomingProactiveRuntimeStatus | null;
  t: Translate;
  locale: string;
}) {
  return (
    <Card title={t("auto.upcoming.proactiveRuntime.title")}>
      {runtime ? (
        <ProactiveRuntimeStatus runtime={runtime} t={t} locale={locale} />
      ) : (
        <p className="subtle" style={{ fontSize: 12 }}>
          {t("auto.upcoming.proactiveRuntime.noObservation")}
        </p>
      )}
    </Card>
  );
}

function ProactiveRuntimeStatus({
  runtime,
  t,
  locale
}: {
  runtime: UpcomingProactiveRuntimeStatus;
  t: Translate;
  locale: string;
}) {
  const observedAt = safeDateTime(runtime.lastObservedAtIso, locale) || t("auto.upcoming.proactiveRuntime.timeUnavailable");
  const sessionLockedUntil = runtime.sessionLockedUntilIso
    ? safeDateTime(runtime.sessionLockedUntilIso, locale) || t("auto.upcoming.proactiveRuntime.timeUnavailable")
    : null;
  return (
    <div>
      <div className="row">
        <div className="row-main">
          <div className="row-title">{t(proactiveRuntimeDecisionKey(runtime.lastDecision))}</div>
          <div className="row-meta">{t("auto.upcoming.proactiveRuntime.observed", { when: observedAt })}</div>
          <div className="row-meta">
            {t("auto.upcoming.proactiveRuntime.counts", {
              errors: runtime.lastErrorCount,
              fired: runtime.lastFiredCount,
              imminent: runtime.lastImminentCount,
              suppressed: runtime.lastSuppressedCount
            })}
          </div>
          {sessionLockedUntil && (
            <div className="row-meta">
              {t("auto.upcoming.proactiveRuntime.sessionLockedUntil", { when: sessionLockedUntil })}
            </div>
          )}
          <div className="row-meta">
            <span className="label">{t("auto.upcoming.runtimeRoute.lastExecution")}: </span>
            {formatRuntimeRoute(runtime.lastRoute, t)}
          </div>
        </div>
        <Badge tone="neutral">{t("auto.upcoming.proactiveRuntime.previewBadge")}</Badge>
      </div>
      <p className="subtle" style={{ fontSize: 12, marginTop: 8 }}>
        {t("auto.upcoming.proactiveRuntime.previewOnly")}
      </p>
    </div>
  );
}

function formatRuntimeRoute(route: unknown, t: Translate): string {
  if (!isRuntimeRoute(route)) return t("auto.upcoming.runtimeRoute.unavailable");
  const target = route.providerId && route.destination
    ? `${route.providerId}:${route.destination}`
    : t("auto.upcoming.runtimeRoute.noDestination");
  const status = runtimeRouteStatusKey(route.status);
  const reason = route.reason ? runtimeRouteReason(route.reason, t) : null;
  return [target, t(status), reason].filter((part): part is string => part !== null).join(" · ");
}

function isRuntimeRoute(value: unknown): value is GatewayRouteStatus {
  if (typeof value !== "object" || value === null) return false;
  const route = value as Record<string, unknown>;
  return (
    (route.status === "resolved" || route.status === "unconfigured" || route.status === "ambiguous" || route.status === "blocked-local-only")
    && (route.source === null || route.source === "explicit-config" || route.source === "paired-owner")
    && (route.providerId === null || typeof route.providerId === "string")
    && (route.destination === null || typeof route.destination === "string")
    && typeof route.localOnly === "boolean"
    && (route.reason === null || typeof route.reason === "string")
  );
}

function runtimeRouteStatusKey(status: GatewayRouteStatus["status"]): StringKey {
  switch (status) {
    case "resolved": return "auto.upcoming.gateway.resolved";
    case "ambiguous": return "auto.upcoming.gateway.ambiguous";
    case "blocked-local-only": return "auto.upcoming.gateway.blockedLocalOnly";
    case "unconfigured": return "auto.upcoming.gateway.unconfigured";
  }
}

function runtimeRouteReason(reason: string, t: Translate): string | null {
  switch (reason) {
    case "explicit-route-incomplete": return t("auto.upcoming.gateway.reason.explicitRouteIncomplete");
    case "explicit-provider-not-registered": return t("auto.upcoming.gateway.reason.explicitProviderNotRegistered");
    case "remote-route-blocked-by-local-only": return t("auto.upcoming.gateway.reason.remoteBlockedLocalOnly");
    case "paired-route-inspection-unavailable": return t("auto.upcoming.gateway.reason.inspectionUnavailable");
    case "no-single-paired-route": return t("auto.upcoming.gateway.reason.noSinglePairedRoute");
    case "multiple-paired-routes": return t("auto.upcoming.gateway.reason.multiplePairedRoutes");
    default: return null;
  }
}

function BudgetCard({ budget, t }: { budget: NonNullable<AutomationUpcomingResponse["budget"]>; t: Translate }) {
  const hourLeft = Math.max(0, budget.hourCap - budget.hourUsed);
  const dayLeft = Math.max(0, budget.dayCap - budget.dayUsed);
  return (
    <Card title={t("auto.upcoming.budgetTitle")}>
      <div className="row-title">
        {t("auto.upcoming.budgetLine", { dayCap: budget.dayCap, dayLeft, hourCap: budget.hourCap, hourLeft })}
      </div>
      <p className="subtle" style={{ fontSize: 12, marginTop: 4 }}>
        {t("auto.upcoming.budgetExplainer")}
      </p>
    </Card>
  );
}

function JobsCard({
  jobs,
  t,
  locale
}: {
  jobs: AutomationUpcomingResponse["scheduledJobs"];
  t: Translate;
  locale: string;
}) {
  return (
    <Card title={t("auto.upcoming.jobsTitle")} count={jobs.length}>
      {jobs.map((job) => (
        <div className="row" key={job.id}>
          <div className="row-main">
            <div className="row-title">{job.label}</div>
            {job.nextRunAtIso && <div className="row-meta">{safeDateTime(job.nextRunAtIso, locale)}</div>}
          </div>
        </div>
      ))}
    </Card>
  );
}

function ReminderCard({
  reminder,
  t,
  locale
}: {
  reminder: NonNullable<AutomationUpcomingResponse["nextReminder"]>;
  t: Translate;
  locale: string;
}) {
  return (
    <Card title={t("auto.upcoming.reminderTitle")}>
      <div className="row">
        <div className="row-main">
          <div className="row-title">{reminder.text}</div>
          <div className="row-meta">{safeDateTime(reminder.dueAtIso, locale)}</div>
        </div>
      </div>
    </Card>
  );
}

function ReminderRuntimeCard({
  runtime,
  t,
  locale
}: {
  runtime: UpcomingReminderRuntimeStatus | null;
  t: Translate;
  locale: string;
}) {
  return (
    <Card title={t("auto.upcoming.reminderRuntime.title")}>
      {runtime ? (
        <ReminderRuntimeStatus runtime={runtime} t={t} locale={locale} />
      ) : (
        <p className="subtle" style={{ fontSize: 12 }}>
          {t("auto.upcoming.reminderRuntime.noObservation")}
        </p>
      )}
    </Card>
  );
}

function ReminderRuntimeStatus({
  runtime,
  t,
  locale
}: {
  runtime: UpcomingReminderRuntimeStatus;
  t: Translate;
  locale: string;
}) {
  const observedAt = safeDateTime(runtime.lastObservedAtIso, locale) || t("auto.upcoming.reminderRuntime.timeUnavailable");
  return (
    <div>
      <div className="row">
        <div className="row-main">
          <div className="row-title">{t(reminderRuntimeDecisionKey(runtime.lastDecision))}</div>
          <div className="row-meta">{t("auto.upcoming.reminderRuntime.observed", { when: observedAt })}</div>
          <div className="row-meta">
            {t("auto.upcoming.reminderRuntime.counts", {
              delivered: boundedRuntimeCount(runtime.lastDeliveredCount),
              due: boundedRuntimeCount(runtime.lastDueCount),
              errors: boundedRuntimeCount(runtime.lastErrorCount),
              fired: boundedRuntimeCount(runtime.lastFiredCount)
            })}
          </div>
        </div>
        <Badge tone="neutral">{t("auto.upcoming.reminderRuntime.previewBadge")}</Badge>
      </div>
      <p className="subtle" style={{ fontSize: 12, marginTop: 8 }}>
        {t("auto.upcoming.reminderRuntime.previewOnly")}
      </p>
    </div>
  );
}

function followupRuntimeDecisionKey(decision: UpcomingFollowupRuntimeDecision | string): StringKey {
  switch (decision) {
    case "not-configured": return "auto.upcoming.followupRuntime.decision.notConfigured";
    case "already-running": return "auto.upcoming.followupRuntime.decision.alreadyRunning";
    case "quiet-hours": return "auto.upcoming.followupRuntime.decision.quietHours";
    case "lock-held": return "auto.upcoming.followupRuntime.decision.lockHeld";
    case "lock-error": return "auto.upcoming.followupRuntime.decision.lockError";
    case "no-due": return "auto.upcoming.followupRuntime.decision.noDue";
    case "fired": return "auto.upcoming.followupRuntime.decision.fired";
    case "completed": return "auto.upcoming.followupRuntime.decision.completed";
    case "error": return "auto.upcoming.followupRuntime.decision.error";
    default: return "auto.upcoming.followupRuntime.decision.unknown";
  }
}

function FollowupRuntimeCard({
  runtime,
  t,
  locale
}: {
  runtime: UpcomingFollowupRuntimeStatus | null;
  t: Translate;
  locale: string;
}) {
  return (
    <Card title={t("auto.upcoming.followupRuntime.title")}>
      {runtime ? (
        <FollowupRuntimeStatus runtime={runtime} t={t} locale={locale} />
      ) : (
        <div className="row">
          <p className="subtle" style={{ fontSize: 12, margin: 0 }}>
            {t("auto.upcoming.followupRuntime.noObservation")}
          </p>
          <Badge tone="warn">{t("auto.upcoming.followupRuntime.decision.notConfigured")}</Badge>
        </div>
      )}
      <p className="subtle" style={{ fontSize: 12, marginTop: 8 }}>
        {t("auto.upcoming.followupRuntime.previewOnly")}
      </p>
    </Card>
  );
}

function FollowupRuntimeStatus({
  runtime,
  t,
  locale
}: {
  runtime: UpcomingFollowupRuntimeStatus;
  t: Translate;
  locale: string;
}) {
  const observedAt = safeDateTime(runtime.lastObservedAtIso, locale) || t("auto.upcoming.followupRuntime.timeUnavailable");
  return (
    <div>
      <div className="row">
        <div className="row-main">
          <div className="row-title">{t(followupRuntimeDecisionKey(runtime.lastDecision))}</div>
          <div className="row-meta">{t("auto.upcoming.followupRuntime.observed", { when: observedAt })}</div>
          <div className="row-meta">
            {t("auto.upcoming.followupRuntime.counts", {
              delivered: boundedRuntimeCount(runtime.lastDeliveredCount),
              due: boundedRuntimeCount(runtime.lastDueCount),
              errors: boundedRuntimeCount(runtime.lastErrorCount),
              fired: boundedRuntimeCount(runtime.lastFiredCount)
            })}
          </div>
        </div>
        <Badge tone={runtime.lastDecision === "not-configured" ? "warn" : "neutral"}>
          {runtime.lastDecision === "not-configured"
            ? t("auto.upcoming.followupRuntime.decision.notConfigured")
            : t("auto.upcoming.followupRuntime.previewBadge")}
        </Badge>
      </div>
    </div>
  );
}

function boundedRuntimeCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(9_999, Math.max(0, Math.trunc(value)));
}

function ActionsTab({ client, locale }: { client: ApiClient; locale: string }) {
  const { t } = useI18n();
  const q = useQuery({
    queryFn: () => client.get<ActionsResponse>("/api/actions?limit=100"),
    queryKey: ["actions", client.baseUrl]
  });
  const list = q.data?.actions ?? [];
  return (
    <Card title={t("auto.tab.actions")} count={q.data?.total ?? 0}>
      <AsyncBlock loading={q.isLoading} error={q.error} empty={list.length === 0}>
        {list.map((a) => (
          <div className="row" key={a.id}>
            <div className="row-main">
              <div className="row-title">{a.what}</div>
              <div className="row-meta">
                {a.why}
                {a.detail ? ` · ${a.detail}` : ""} · {new Date(a.when).toLocaleString(locale)}
              </div>
            </div>
            <Badge tone={resultTone(a.result)}>{actionResultLabel(a.result, t)}</Badge>
          </div>
        ))}
      </AsyncBlock>
    </Card>
  );
}

function ObjectivesTab({ client, locale }: { client: ApiClient; locale: string }) {
  const { t } = useI18n();
  const q = useQuery({
    queryFn: () => client.get<ObjectivesResponse>("/api/objectives"),
    queryKey: ["objectives", client.baseUrl]
  });
  const list = q.data?.objectives ?? [];
  return (
    <Card title={t("auto.tab.objectives")} count={q.data?.total ?? 0}>
      <p className="subtle" style={{ fontSize: 12, marginTop: -4, marginBottom: 12 }}>
        {t("auto.objNote")}
      </p>
      <AsyncBlock loading={q.isLoading} error={q.error} empty={list.length === 0}>
        {list.map((o) => (
          <div className="row" key={o.id}>
            <div className="row-main">
              <div className="row-title">{o.spec}</div>
              <div className="row-meta">
                {o.kind} · {new Date(o.createdAt).toLocaleDateString(locale)}
                {o.resolution ? ` · ${o.resolution}` : ""}
              </div>
            </div>
            <Badge tone={statusTone(o.status)}>{objectiveStatusLabel(o.status, t)}</Badge>
          </div>
        ))}
      </AsyncBlock>
    </Card>
  );
}

function VetoesTab({ client, locale }: { client: ApiClient; locale: string }) {
  const { t } = useI18n();
  const q = useQuery({
    queryFn: () => client.get<VetoesResponse>("/api/vetoes"),
    queryKey: ["vetoes", client.baseUrl]
  });
  const list = q.data?.vetoes ?? [];
  return (
    <Card title={t("auto.tab.vetoes")} count={q.data?.total ?? 0}>
      <p className="subtle" style={{ fontSize: 12, marginTop: -4, marginBottom: 12 }}>
        {t("auto.vetoNote")}
      </p>
      <AsyncBlock loading={q.isLoading} error={q.error} empty={list.length === 0}>
        {list.map((v) => (
          <div className="row" key={v.id}>
            <div className="row-main">
              <div className="row-title">{v.scope}</div>
              <div className="row-meta">
                {v.reason ? `${v.reason} · ` : ""}
                {safeDateTime(v.vetoedAt, locale)}
              </div>
            </div>
            <Badge tone="warn">{t("auto.vetoBadge")}</Badge>
          </div>
        ))}
      </AsyncBlock>
    </Card>
  );
}
