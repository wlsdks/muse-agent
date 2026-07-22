import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { errorMessage } from "@muse/shared/browser";

import { AsyncBlock, Badge, Button, Card, Icon } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";
import {
  buildCadenceInput,
  CADENCE_KINDS,
  formatCadenceSummary,
  schedulerStatusLabel,
  schedulerStatusTone,
  weekdayName,
  type CadenceFormState,
  type CadenceKind
} from "./scheduler-logic.js";

import type { ApiClient } from "../api/client.js";
import type { SchedulerJobRow, SchedulerJobsResponse } from "../api/types.js";
import type { StringKey } from "../i18n/index.js";

const CADENCE_KIND_LABEL: Record<CadenceKind, StringKey> = {
  custom: "scheduler.kind.custom",
  daily: "scheduler.kind.daily",
  interval: "scheduler.kind.interval",
  weekdays: "scheduler.kind.weekdays",
  weekly: "scheduler.kind.weekly"
};

const EMPTY_FORM: CadenceFormState = { customText: "", intervalMinutes: "30", kind: "daily", time: "09:00", weekday: 1 };

/**
 * S9 audit #6: a non-dev creates a recurring agent prompt from the browser
 * with a cadence DROPDOWN — no cron syntax. Every cadence this view composes
 * is resolved server-side through the SAME `parseCadence` the CLI's
 * `muse scheduler add --every` uses (`scheduler-logic.ts#buildCadenceInput`
 * never invents a second grammar). Create/manage only — this view never
 * triggers a job run.
 */
export function SchedulerView({ client }: { client: ApiClient }) {
  const { locale, t } = useI18n();
  const qc = useQueryClient();
  const [prompt, setPrompt] = useState("");
  const [form, setForm] = useState<CadenceFormState>(EMPTY_FORM);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const jobs = useQuery({
    queryFn: () => client.get<SchedulerJobsResponse>("/api/scheduler/jobs?limit=100"),
    queryKey: ["scheduler-jobs", client.baseUrl]
  });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ["scheduler-jobs"] });

  const cadence = buildCadenceInput(form);
  const canCreate = prompt.trim().length > 0 && cadence !== undefined;

  const create = useMutation({
    mutationFn: () => client.post<SchedulerJobRow>("/api/scheduler/jobs", { cadence, enabled: true, prompt: prompt.trim() }),
    onSuccess: () => {
      setPrompt("");
      invalidate();
    }
  });
  const toggle = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      client.patch<SchedulerJobRow>(`/api/scheduler/jobs/${input.id}`, { enabled: input.enabled }),
    onSuccess: invalidate
  });
  const remove = useMutation({
    mutationFn: (id: string) => client.del(`/api/scheduler/jobs/${id}`),
    onSuccess: invalidate
  });

  const list = jobs.data?.items ?? [];

  return (
    <div className="content-narrow">
      <p className="eyebrow">{t("group.system")}</p>
      <h1 className="page-title">{t("nav.scheduler")}</h1>
      <p className="muted" style={{ marginTop: 4 }}>
        {t("scheduler.subtitle")}
      </p>

      <Card title={t("scheduler.new")} className="lifted">
        <div style={{ display: "grid", gap: 10, marginTop: 8 }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="field-label">{t("scheduler.prompt")}</span>
            <textarea
              ref={promptRef}
              className="input"
              rows={3}
              placeholder={t("scheduler.promptPlaceholder")}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </label>

          <label style={{ display: "grid", gap: 4, maxWidth: 260 }}>
            <span className="field-label">{t("scheduler.cadenceKind")}</span>
            <select
              className="input"
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value as CadenceKind })}
            >
              {CADENCE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(CADENCE_KIND_LABEL[kind])}
                </option>
              ))}
            </select>
          </label>

          {(form.kind === "daily" || form.kind === "weekdays" || form.kind === "weekly") && (
            <label style={{ display: "grid", gap: 4, maxWidth: 160 }}>
              <span className="field-label">{t("scheduler.time")}</span>
              <input
                className="input"
                type="time"
                value={form.time}
                onChange={(e) => setForm({ ...form, time: e.target.value })}
              />
            </label>
          )}

          {form.kind === "weekly" && (
            <label style={{ display: "grid", gap: 4, maxWidth: 200 }}>
              <span className="field-label">{t("scheduler.weekday")}</span>
              <select
                className="input"
                value={form.weekday}
                onChange={(e) => setForm({ ...form, weekday: Number(e.target.value) })}
              >
                {[0, 1, 2, 3, 4, 5, 6].map((weekday) => (
                  <option key={weekday} value={weekday}>
                    {weekdayName(weekday, locale)}
                  </option>
                ))}
              </select>
            </label>
          )}

          {form.kind === "interval" && (
            <label style={{ display: "grid", gap: 4, maxWidth: 160 }}>
              <span className="field-label">{t("scheduler.intervalMinutes")}</span>
              <input
                className="input"
                type="number"
                min={1}
                max={59}
                value={form.intervalMinutes}
                onChange={(e) => setForm({ ...form, intervalMinutes: e.target.value })}
              />
            </label>
          )}

          {form.kind === "custom" && (
            <label style={{ display: "grid", gap: 4 }}>
              <span className="field-label">{t("scheduler.customCadence")}</span>
              <input
                className="input"
                type="text"
                placeholder={t("scheduler.customCadencePlaceholder")}
                value={form.customText}
                onChange={(e) => setForm({ ...form, customText: e.target.value })}
              />
              <span className="subtle" style={{ fontSize: 12 }}>
                {t("scheduler.customCadenceHint")}
              </span>
            </label>
          )}

          <div>
            <Button variant="primary" disabled={!canCreate || create.isPending} onClick={() => create.mutate()}>
              <Icon.plus className="nav-icon" /> {create.isPending ? t("scheduler.creating") : t("common.add")}
            </Button>
          </div>
          {create.error && (
            <div className="banner err">{errorMessage(create.error, t("scheduler.createFailed"))}</div>
          )}
        </div>
      </Card>

      <div style={{ marginTop: 16 }}>
        <Card title={t("scheduler.jobs")} count={jobs.data?.total ?? 0}>
          <AsyncBlock
            loading={jobs.isLoading}
            error={jobs.error}
            empty={list.length === 0}
            emptyIcon={<Icon.clock />}
            emptyLabel={t("scheduler.empty")}
            emptyAction={{
              icon: <Icon.plus className="nav-icon" />,
              label: t("scheduler.addFirst"),
              onClick: () => promptRef.current?.focus()
            }}
          >
            {list.map((job) => (
              <div className="row" key={job.id}>
                <Icon.clock className="nav-icon" />
                <div className="row-main">
                  <div className="row-title">{job.name}</div>
                  <div className="row-meta">
                    {formatCadenceSummary(job.cadenceSummary, t, locale)}
                    {" · "}
                    {job.lastRunAt !== null
                      ? t("scheduler.lastRun", { when: new Date(job.lastRunAt).toLocaleString(locale) })
                      : t("scheduler.neverRun")}
                  </div>
                </div>
                <Badge tone={job.enabled ? "ok" : "neutral"}>
                  {t(job.enabled ? "scheduler.enabled" : "scheduler.paused")}
                </Badge>
                {job.lastStatus && (
                  <Badge tone={schedulerStatusTone(job.lastStatus)}>{schedulerStatusLabel(job.lastStatus, t)}</Badge>
                )}
                <div className="row-actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={toggle.isPending}
                    onClick={() => toggle.mutate({ enabled: !job.enabled, id: job.id })}
                  >
                    {t(job.enabled ? "scheduler.pause" : "scheduler.resume")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    title={t("common.delete")}
                    ariaLabel={t("common.delete")}
                    onClick={() => {
                      if (window.confirm(t("scheduler.deleteConfirm", { name: job.name }))) {
                        remove.mutate(job.id);
                      }
                    }}
                  >
                    <Icon.trash className="nav-icon" />
                  </Button>
                </div>
              </div>
            ))}
          </AsyncBlock>
        </Card>
      </div>
    </div>
  );
}
