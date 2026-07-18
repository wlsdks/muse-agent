import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { AsyncBlock, Badge, Button, Empty, Icon } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";
import { safeSessionStorage } from "../lib/safe-storage.js";
import { relativeAgo } from "./chats-logic.js";
import { toggleEnabledPatch } from "./flow-edit-compile.js";
import { statusTone } from "./flow-executions-compile.js";
import { formatMetaValue } from "./flow-nodes.js";
import { mergeScheduleRows, writeBuilderFocusHint } from "./scheduled-logic.js";
import { formatCadenceSummary } from "./scheduler-logic.js";

import type { ScheduleRow } from "./scheduled-logic.js";
import type { ApiClient } from "../api/client.js";
import type { FlowsResponse, SchedulerJobsResponse } from "../api/types.js";

/**
 * Builder-grade Scheduled view: ONE operational row per flow — what it
 * does, when it runs, how the last run went — with the controls right on
 * the row (on/off, run now, open in Builder). The upcoming digest/budget/
 * reminder summary stays below as secondary context.
 */
export function ScheduleTable({
  client,
  onNavigate,
  onOpenFlow
}: {
  client: ApiClient;
  onNavigate?: (view: string) => void;
  /** Embedded (Builder list tab) override — select the flow in place instead
   * of navigating views. */
  onOpenFlow?: (id: string) => void;
}) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const flowsQuery = useQuery({
    queryFn: () => client.get<FlowsResponse>("/api/flows"),
    queryKey: ["flows", client.baseUrl]
  });
  const jobsQuery = useQuery({
    queryFn: () => client.get<SchedulerJobsResponse>("/api/scheduler/jobs?limit=100"),
    queryKey: ["scheduler-jobs", client.baseUrl]
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["flows"] });
    void qc.invalidateQueries({ queryKey: ["scheduler-jobs", client.baseUrl] });
  };

  const toggle = useMutation({
    mutationFn: ({ enabled, id }: { id: string; enabled: boolean }) =>
      client.patch(`/api/scheduler/jobs/${encodeURIComponent(id)}`, toggleEnabledPatch(enabled)),
    onSuccess: invalidate
  });
  const runNow = useMutation({
    mutationFn: (id: string) => client.post(`/api/scheduler/jobs/${encodeURIComponent(id)}/trigger`),
    onSuccess: invalidate
  });

  const rows = mergeScheduleRows(flowsQuery.data?.flows ?? [], jobsQuery.data?.items ?? []);
  const active = rows.filter((row) => row.enabled).length;

  const openInBuilder = (id: string) => {
    if (onOpenFlow) {
      onOpenFlow(id);
      return;
    }
    writeBuilderFocusHint(safeSessionStorage(), id);
    onNavigate?.("flows");
  };

  return (
    <AsyncBlock loading={flowsQuery.isLoading || jobsQuery.isLoading} error={flowsQuery.error ?? jobsQuery.error} empty={false}>
      {rows.length === 0 ? (
        <Empty icon={<Icon.clock />} hint={t("scheduled.empty.hint")}>
          {t("scheduled.empty.title")}
          <div style={{ marginTop: 10 }}>
            <Button variant="primary" size="sm" onClick={() => onNavigate?.("flows")}>
              {t("scheduled.goCreate")}
            </Button>
          </div>
        </Empty>
      ) : (
        <>
          <p className="subtle" style={{ margin: "0 0 10px" }}>
            {t("scheduled.summary", { active: active.toString(), paused: (rows.length - active).toString() })}
          </p>
          <div className="sched-table" role="table">
            <div className="sched-row sched-head" role="row">
              <span />
              <span role="columnheader">{t("scheduled.table.what")}</span>
              <span role="columnheader">{t("scheduled.table.when")}</span>
              <span role="columnheader">{t("scheduled.table.lastRun")}</span>
              <span role="columnheader">{t("scheduled.table.actions")}</span>
            </div>
            {rows.map((row) => (
              <ScheduleRowView
                key={row.id}
                row={row}
                locale={locale}
                busy={toggle.isPending || runNow.isPending}
                onToggle={() => toggle.mutate({ enabled: !row.enabled, id: row.id })}
                onRunNow={() => runNow.mutate(row.id)}
                onOpen={() => openInBuilder(row.id)}
              />
            ))}
          </div>
        </>
      )}
    </AsyncBlock>
  );
}

function ScheduleRowView({
  row,
  locale,
  busy,
  onToggle,
  onRunNow,
  onOpen
}: {
  row: ScheduleRow;
  locale: string;
  busy: boolean;
  onToggle: () => void;
  onRunNow: () => void;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className={`sched-row${row.enabled ? "" : " paused"}`} role="row">
      <span className={`dot${row.enabled ? " on" : ""}`} />
      <span className="sched-cell-main" role="cell">
        <button type="button" className="sched-name" onClick={onOpen} title={t("scheduled.openInBuilder")}>
          {row.name}
        </button>
        <span className="sched-what">{row.what}</span>
      </span>
      <span className="sched-cell" role="cell">
        {row.cadence ? formatCadenceSummary(row.cadence, t, locale) : "—"}
        <span className="sched-sub">
          {!row.enabled
            ? t("auto.flows.paused")
            : row.nextRunAtIso
              ? formatMetaValue("nextRunAtIso", row.nextRunAtIso, locale)
              : ""}
        </span>
      </span>
      <span className="sched-cell" role="cell">
        {row.lastStatus ? (
          <>
            <Badge tone={statusTone(row.lastStatus as never)}>{row.lastStatus}</Badge>
            <span className="sched-sub">{row.lastRunAt ? relativeAgo(new Date(row.lastRunAt).toISOString(), t) : ""}</span>
          </>
        ) : (
          <span className="subtle">{t("scheduled.never")}</span>
        )}
      </span>
      <span className="sched-cell sched-actions" role="cell">
        <Button variant="ghost" size="sm" disabled={busy} onClick={onToggle}>
          {t(row.enabled ? "scheduled.turnOff" : "scheduled.turnOn")}
        </Button>
        {/* The scheduler runs a MANUAL trigger even for a paused schedule
            (only automatic runs are skipped) — so Run now stays available. */}
        <Button variant="ghost" size="sm" disabled={busy} onClick={onRunNow}>
          {t("scheduled.runNow")}
        </Button>
        <Button variant="secondary" size="sm" onClick={onOpen}>
          {t("scheduled.openInBuilder")}
        </Button>
      </span>
    </div>
  );
}
