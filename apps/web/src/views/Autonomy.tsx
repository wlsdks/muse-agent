import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { AsyncBlock, Badge, Card, Empty, Icon } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";
import { safeDateTime } from "../lib/datetime.js";
import { actionResultLabel, objectiveStatusLabel } from "./autonomy-labels.js";
import { nextTabIndex } from "./tabKeyNav.js";
import { timeUntil } from "./Today.js";

import type { ApiClient } from "../api/client.js";
import type {
  ActionsResponse,
  AutomationUpcomingResponse,
  ObjectivesResponse,
  VetoesResponse
} from "../api/types.js";
import type { StringKey, Translate } from "../i18n/index.js";

type Tab = "upcoming" | "actions" | "objectives" | "vetoes";
const TABS: readonly { id: Tab; labelKey: StringKey }[] = [
  { id: "upcoming", labelKey: "auto.tab.upcoming" },
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
  const [tab, setTab] = useState<Tab>("upcoming");

  return (
    <div className="content-narrow">
      <p className="eyebrow">{t("group.system")}</p>
      <h1 className="page-title">{t("nav.autonomy")}</h1>
      <p className="muted" style={{ marginTop: 4 }}>
        {t("auto.subtitle")}
      </p>

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

      {tab === "upcoming" && <UpcomingTab client={client} />}
      {tab === "actions" && <ActionsTab client={client} locale={locale} />}
      {tab === "objectives" && <ObjectivesTab client={client} locale={locale} />}
      {tab === "vetoes" && <VetoesTab client={client} locale={locale} />}
    </div>
  );
}

function UpcomingTab({ client }: { client: ApiClient }) {
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
 * Pure presentational render of the four upcoming-automation sections —
 * kept separate from `UpcomingTab` so it's directly testable with a
 * constructed `AutomationUpcomingResponse`, no query resolution needed.
 * Each section renders only when its data is non-null/non-empty; the
 * overall empty state fires only when all four are absent.
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
  const hasBudget = data.budget !== null;
  const hasJobs = data.scheduledJobs.length > 0;
  const hasReminder = data.nextReminder !== null;

  if (!hasDigest && !hasBudget && !hasJobs && !hasReminder) {
    return (
      <Empty icon={<Icon.clock />} hint={t("auto.upcoming.emptyHint")}>
        {t("auto.upcoming.emptyTitle")}
      </Empty>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {data.digest && <DigestCard digest={data.digest} t={t} locale={locale} />}
      {data.budget && <BudgetCard budget={data.budget} t={t} />}
      {data.scheduledJobs.length > 0 && <JobsCard jobs={data.scheduledJobs} t={t} locale={locale} />}
      {data.nextReminder && <ReminderCard reminder={data.nextReminder} t={t} locale={locale} />}
    </div>
  );
}

function DigestCard({
  digest,
  t,
  locale
}: {
  digest: NonNullable<AutomationUpcomingResponse["digest"]>;
  t: Translate;
  locale: string;
}) {
  const when = timeUntil(digest.nextAtIso, t) || safeDateTime(digest.nextAtIso, locale);
  return (
    <Card title={t("auto.upcoming.digestTitle")}>
      <div className="row">
        <div className="row-main">
          <div className="row-title">{t("auto.upcoming.digestLine", { hour: digest.hour, when })}</div>
        </div>
        {!digest.enabled && <Badge tone="neutral">{t("auto.upcoming.digestOff")}</Badge>}
      </div>
    </Card>
  );
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
