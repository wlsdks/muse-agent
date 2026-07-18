import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage } from "@muse/shared/browser";

import { Badge, Button } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";
import {
  actionFormFromJob,
  flowEditToJobPatch,
  isValidCronShape,
  MAX_RETRY_COUNT,
  MIN_RETRY_COUNT,
  outputFormFromJob,
  parseToolArgumentsText,
  SCHEDULE_PRESETS,
  timezoneOptions,
  toolActionFormFromJob,
  triggerFormFromJob,
  type ActionEditForm,
  type OutputEditForm,
  type ScheduleKind,
  type ToolActionEditForm,
  type TriggerEditForm
} from "./flow-edit-compile.js";
import { KIND_LABEL_KEY } from "./flow-nodes.js";
import { NotifyChannelQuickPick } from "./flow-notify-picker.js";
import { isWriteToolSelection, schedulableToolOptions, toolsForServer, uniqueServerNames } from "./flow-tool-catalog.js";

import type { ApiClient } from "../api/client.js";
import type { FlowCanvasNode } from "./flow-canvas-mapping.js";
import type { LoopbackCatalogResponse, ScheduledJobDetail } from "../api/types.js";
import type { StringKey } from "../i18n/index.js";

export const PRESET_LABEL_KEY: Record<string, StringKey> = {
  custom: "auto.flows.preset.custom",
  dailyEvening6: "auto.flows.preset.dailyEvening6",
  dailyMorning9: "auto.flows.preset.dailyMorning9",
  hourly: "auto.flows.preset.hourly",
  weekdays9: "auto.flows.preset.weekdays9",
  weeklyMonday9: "auto.flows.preset.weeklyMonday9"
};

function categoryForKind(kind: FlowCanvasNode["data"]["kind"]): "trigger" | "action" | "output" {
  if (kind === "trigger.schedule") return "trigger";
  if (kind === "action.agent" || kind === "action.tool") return "action";
  return "output";
}

/** A `T` local form value plus a `baseline` snapshot it's compared against
 * for the disabled-while-unchanged Save button — `markSaved` re-baselines
 * after a successful PATCH so the button (and the "Saved" badge) react
 * correctly to the next edit. */
function useSavableForm<T>(initial: T) {
  const [form, setForm] = useState<T>(initial);
  const [baseline, setBaseline] = useState<T>(initial);
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline);
  return { baseline, dirty, form, markSaved: () => setBaseline(form), setForm };
}

/**
 * Fetches the full `ScheduledJob` (not the truncated `/api/flows` projection
 * meta — a long `agentPrompt` is truncated there, and PATCHing that back
 * would permanently truncate the real prompt) and renders the edit form for
 * whichever node category was clicked. `key={node.id}` at the call site
 * forces a fresh mount (fresh initial form state) on every node selection.
 */
export function FlowNodeEditPanel({
  client,
  jobId,
  node,
  onSaved
}: {
  client: ApiClient;
  jobId: string;
  node: FlowCanvasNode;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const job = useQuery({
    queryFn: () => client.get<ScheduledJobDetail>(`/api/scheduler/jobs/${encodeURIComponent(jobId)}`),
    queryKey: ["scheduler-job-detail", client.baseUrl, jobId]
  });

  if (job.isLoading) {
    return <p className="subtle">{t("auto.flows.detailEmpty")}</p>;
  }
  if (job.error || !job.data) {
    return <div className="banner err">{errorMessage(job.error, t("auto.flows.edit.saveFailed"))}</div>;
  }

  const category = categoryForKind(node.data.kind);

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div className="row-title">{t(KIND_LABEL_KEY[node.data.kind])}</div>
      {category === "trigger" && (
        <TriggerEditFields key={node.id} client={client} jobId={jobId} job={job.data} onSaved={onSaved} />
      )}
      {category === "action" && (
        job.data.jobType.toLowerCase() === "agent" ? (
          <ActionEditFields key={node.id} client={client} jobId={jobId} job={job.data} onSaved={onSaved} />
        ) : (
          <ToolActionEditFields key={node.id} client={client} jobId={jobId} job={job.data} onSaved={onSaved} />
        )
      )}
      {category === "output" && (
        <OutputEditFields key={node.id} client={client} jobId={jobId} job={job.data} onSaved={onSaved} />
      )}
    </div>
  );
}

/** The trigger node's inbound-webhook controls: mint/copy/rotate/revoke the
 * secret URL. The token is server-minted; this panel never invents one. */
function WebhookSection({ client, jobId, job }: { client: ApiClient; jobId: string; job: ScheduledJobDetail }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const token = job.webhookTriggerToken ?? null;
  const mint = useMutation({
    mutationFn: () => client.post<{ token: string; urlPath: string }>(`/api/scheduler/jobs/${encodeURIComponent(jobId)}/webhook-token`),
    onSuccess: () => {
      setCopied(false);
      invalidateFlowQueries(client, jobId, qc);
    }
  });
  const revoke = useMutation({
    mutationFn: () => client.del(`/api/scheduler/jobs/${encodeURIComponent(jobId)}/webhook-token`),
    onSuccess: () => {
      setCopied(false);
      invalidateFlowQueries(client, jobId, qc);
    }
  });
  const url = token ? `${client.baseUrl}/api/hooks/flows/${token}` : null;

  return (
    <div style={{ borderTop: "1px solid var(--border)", display: "grid", gap: 6, marginTop: 4, paddingTop: 10 }}>
      <span className="field-label">{t("auto.flows.webhook.title")}</span>
      {url ? (
        <>
          <code className="webhook-url" title={url}>{url}</code>
          <div style={{ display: "flex", gap: 6 }}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void navigator.clipboard?.writeText(url).then(() => setCopied(true));
              }}
            >
              {t(copied ? "auto.flows.webhook.copied" : "auto.flows.webhook.copy")}
            </Button>
            <Button variant="ghost" size="sm" disabled={mint.isPending} onClick={() => mint.mutate()}>
              {t("auto.flows.webhook.rotate")}
            </Button>
            <Button variant="ghost" size="sm" disabled={revoke.isPending} onClick={() => revoke.mutate()}>
              {t("auto.flows.webhook.revoke")}
            </Button>
          </div>
        </>
      ) : (
        <div>
          <Button variant="secondary" size="sm" disabled={mint.isPending} onClick={() => mint.mutate()}>
            {t("auto.flows.webhook.enable")}
          </Button>
        </div>
      )}
      <span className="subtle" style={{ fontSize: 12 }}>{t("auto.flows.webhook.hint")}</span>
    </div>
  );
}

function invalidateFlowQueries(client: ApiClient, jobId: string, qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ["flows"] });
  void qc.invalidateQueries({ queryKey: ["scheduler-job-detail", client.baseUrl, jobId] });
}

function SaveRow({
  canSave,
  dirty,
  save
}: {
  canSave: boolean;
  dirty: boolean;
  save: { isPending: boolean; isSuccess: boolean; error: unknown; mutate: () => void };
}) {
  const { t } = useI18n();
  return (
    <>
      <div style={{ alignItems: "center", display: "flex", gap: 8 }}>
        <Button variant="primary" size="sm" disabled={!canSave} onClick={() => save.mutate()}>
          {save.isPending ? t("auto.flows.edit.saving") : t("auto.flows.edit.save")}
        </Button>
        {!dirty && save.isSuccess && <Badge tone="ok">{t("auto.flows.edit.saved")}</Badge>}
      </div>
      {save.error && <div className="banner err">{errorMessage(save.error, t("auto.flows.edit.saveFailed"))}</div>}
    </>
  );
}

function TriggerEditFields({
  client,
  jobId,
  job,
  onSaved
}: {
  client: ApiClient;
  jobId: string;
  job: ScheduledJobDetail;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { dirty, form, markSaved, setForm } = useSavableForm<TriggerEditForm>(triggerFormFromJob(job));

  const save = useMutation({
    mutationFn: () => client.patch(`/api/scheduler/jobs/${encodeURIComponent(jobId)}`, flowEditToJobPatch("trigger", form)),
    onSuccess: () => {
      markSaved();
      invalidateFlowQueries(client, jobId, qc);
      onSaved();
    }
  });

  const customInvalid = form.schedule.kind === "custom" && !isValidCronShape(form.schedule.customCron);
  const canSave = dirty && !customInvalid && !save.isPending;

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <label style={{ display: "grid", gap: 4 }}>
        <span className="field-label">{t("auto.flows.edit.scheduleLabel")}</span>
        <select
          className="input"
          value={form.schedule.kind}
          onChange={(e) => {
            const kind = e.target.value as ScheduleKind;
            setForm({ ...form, schedule: { customCron: kind === "custom" ? form.schedule.customCron : "", kind } });
          }}
        >
          {SCHEDULE_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {t(PRESET_LABEL_KEY[preset.id]!)}
            </option>
          ))}
          <option value="custom">{t("auto.flows.preset.custom")}</option>
        </select>
      </label>
      {form.schedule.kind === "custom" && (
        <label style={{ display: "grid", gap: 4 }}>
          <span className="field-label">{t("auto.flows.edit.customCronLabel")}</span>
          <input
            className="input"
            type="text"
            placeholder="0 9 * * *"
            value={form.schedule.customCron}
            onChange={(e) => setForm({ ...form, schedule: { customCron: e.target.value, kind: "custom" } })}
          />
          <span className="subtle" style={{ fontSize: 12 }}>{t("auto.flows.edit.customCronHint")}</span>
          {customInvalid && (
            <span className="field-error">
              {t("auto.flows.edit.customCronInvalid")}
            </span>
          )}
        </label>
      )}
      <label style={{ display: "grid", gap: 4 }}>
        <span className="field-label">{t("auto.flows.meta.timezone")}</span>
        <select
          className="input"
          value={form.timezone}
          onChange={(e) => setForm({ ...form, timezone: e.target.value })}
        >
          {timezoneOptions(form.timezone).map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </label>
      <WebhookSection client={client} jobId={jobId} job={job} />
      <SaveRow save={save} dirty={dirty} canSave={canSave} />
    </div>
  );
}

function ActionEditFields({
  client,
  jobId,
  job,
  onSaved
}: {
  client: ApiClient;
  jobId: string;
  job: ScheduledJobDetail;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { dirty, form, markSaved, setForm } = useSavableForm<ActionEditForm>(actionFormFromJob(job));

  const save = useMutation({
    mutationFn: () => client.patch(`/api/scheduler/jobs/${encodeURIComponent(jobId)}`, flowEditToJobPatch("action", form)),
    onSuccess: () => {
      markSaved();
      invalidateFlowQueries(client, jobId, qc);
      onSaved();
    }
  });

  const retryCountValid = !form.retryOnFailure || (form.maxRetryCount >= MIN_RETRY_COUNT && form.maxRetryCount <= MAX_RETRY_COUNT);
  const canSave = dirty && form.agentPrompt.trim().length > 0 && retryCountValid && !save.isPending;

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <label style={{ display: "grid", gap: 4 }}>
        <span className="field-label">{t("auto.flows.edit.promptLabel")}</span>
        <textarea
          className="input"
          rows={4}
          value={form.agentPrompt}
          onChange={(e) => setForm({ ...form, agentPrompt: e.target.value })}
        />
      </label>
      <label style={{ display: "grid", gap: 4 }}>
        <span className="field-label">{t("auto.flows.edit.modelLabel")}</span>
        <input
          className="input"
          type="text"
          placeholder={t("auto.flows.edit.modelPlaceholder")}
          value={form.agentModel}
          onChange={(e) => setForm({ ...form, agentModel: e.target.value })}
        />
      </label>
      <label style={{ display: "grid", gap: 4 }}>
        <span className="field-label">{t("auto.flows.edit.systemPromptLabel")}</span>
        <textarea
          className="input"
          rows={3}
          placeholder={t("auto.flows.edit.systemPromptPlaceholder")}
          value={form.agentSystemPrompt}
          onChange={(e) => setForm({ ...form, agentSystemPrompt: e.target.value })}
        />
        <span className="subtle" style={{ fontSize: 12 }}>{t("auto.flows.edit.systemPromptHint")}</span>
      </label>
      <label style={{ alignItems: "center", display: "flex", gap: 8 }}>
        <input
          type="checkbox"
          checked={form.retryOnFailure}
          onChange={(e) => setForm({ ...form, retryOnFailure: e.target.checked })}
        />
        <span className="field-label">{t("auto.flows.edit.retryLabel")}</span>
      </label>
      {form.retryOnFailure && (
        <label style={{ display: "grid", gap: 4, maxWidth: 160 }}>
          <span className="field-label">{t("auto.flows.edit.retryCountLabel")}</span>
          <input
            className="input"
            type="number"
            min={MIN_RETRY_COUNT}
            max={MAX_RETRY_COUNT}
            value={form.maxRetryCount}
            onChange={(e) => setForm({ ...form, maxRetryCount: Number(e.target.value) })}
          />
        </label>
      )}
      <SaveRow save={save} dirty={dirty} canSave={canSave} />
    </div>
  );
}

/**
 * Editing an `action.tool` node — the tool pair is editable through the SAME
 * read-risk loopback cascade (server → tool) the create panel uses, so a
 * live flow can be re-pointed only at a tool that actually exists in the
 * runtime registry; changing the tool resets the args textarea to {} (the
 * old arguments belong to the old tool's schema). PATCHes
 * `{ mcpServerName, toolName, toolArguments }` together.
 */
function ToolActionEditFields({
  client,
  jobId,
  job,
  onSaved
}: {
  client: ApiClient;
  jobId: string;
  job: ScheduledJobDetail;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { dirty, form, markSaved, setForm } = useSavableForm<ToolActionEditForm>(toolActionFormFromJob(job));
  const catalog = useQuery({
    queryFn: () => client.get<LoopbackCatalogResponse>("/api/muse/loopback"),
    queryKey: ["loopback-catalog", client.baseUrl],
    retry: 0
  });
  const options = catalog.data ? schedulableToolOptions(catalog.data) : [];
  const serverNames = uniqueServerNames(options);
  const toolOptions = toolsForServer(options, form.toolServerName);
  // A job may reference a tool the registry no longer exposes (server down,
  // loopback off) — keep the stored pair selectable so opening the panel
  // never silently blanks a live flow's target.
  const serverChoices = serverNames.includes(form.toolServerName) || form.toolServerName.length === 0
    ? serverNames
    : [form.toolServerName, ...serverNames];
  const toolChoices = toolOptions.some((option) => option.toolName === form.toolName) || form.toolName.length === 0
    ? toolOptions.map((option) => option.toolName)
    : [form.toolName, ...toolOptions.map((option) => option.toolName)];

  const save = useMutation({
    mutationFn: () => client.patch(`/api/scheduler/jobs/${encodeURIComponent(jobId)}`, flowEditToJobPatch("tool", form)),
    onSuccess: () => {
      markSaved();
      invalidateFlowQueries(client, jobId, qc);
      onSaved();
    }
  });

  const argsInvalid = !parseToolArgumentsText(form.toolArgumentsText).ok;
  const pairMissing = form.toolServerName.trim().length === 0 || form.toolName.trim().length === 0;
  const canSave = dirty && !argsInvalid && !pairMissing && !save.isPending;
  const writeSelected = isWriteToolSelection(options, form.toolServerName, form.toolName);

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {writeSelected && (
        <div className="banner warn write-confirm" role="alert">
          {t("auto.flows.writeConfirm.banner")}
        </div>
      )}
      <label style={{ display: "grid", gap: 4 }}>
        <span className="field-label">{t("auto.flows.create.toolServerLabel")}</span>
        <select
          className="input"
          aria-label={t("auto.flows.create.toolServerLabel")}
          value={form.toolServerName}
          onChange={(e) => setForm({ ...form, toolArgumentsText: "{}", toolName: "", toolServerName: e.target.value })}
        >
          {serverChoices.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      </label>
      <label style={{ display: "grid", gap: 4 }}>
        <span className="field-label">{t("auto.flows.create.toolNameLabel")}</span>
        <select
          className="input"
          aria-label={t("auto.flows.create.toolNameLabel")}
          value={form.toolName}
          onChange={(e) => {
            if (e.target.value !== form.toolName) {
              setForm({ ...form, toolArgumentsText: "{}", toolName: e.target.value });
            }
          }}
        >
          {form.toolName.length === 0 && <option value="">{t("auto.flows.create.toolNamePlaceholder")}</option>}
          {toolChoices.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      </label>
      <label style={{ display: "grid", gap: 4 }}>
        <span className="field-label">{t("auto.flows.edit.toolArgsLabel")}</span>
        <textarea
          className="input"
          rows={4}
          value={form.toolArgumentsText}
          onChange={(e) => setForm({ ...form, toolArgumentsText: e.target.value })}
        />
        {argsInvalid && (
          <span className="field-error">
            {t("auto.flows.edit.toolArgsInvalid")}
          </span>
        )}
      </label>
      <SaveRow save={save} dirty={dirty} canSave={canSave} />
    </div>
  );
}

function OutputEditFields({
  client,
  jobId,
  job,
  onSaved
}: {
  client: ApiClient;
  jobId: string;
  job: ScheduledJobDetail;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { dirty, form, markSaved, setForm } = useSavableForm<OutputEditForm>(outputFormFromJob(job));

  const save = useMutation({
    mutationFn: () => client.patch(`/api/scheduler/jobs/${encodeURIComponent(jobId)}`, flowEditToJobPatch("output", form)),
    onSuccess: () => {
      markSaved();
      invalidateFlowQueries(client, jobId, qc);
      onSaved();
    }
  });

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <label style={{ display: "grid", gap: 4 }}>
        <span className="field-label">{t("auto.flows.edit.notifyLabel")}</span>
        <NotifyChannelQuickPick client={client} onPick={(value) => setForm({ notificationChannelId: value })} />
        <input
          className="input"
          type="text"
          placeholder={t("auto.flows.edit.notifyPlaceholder")}
          value={form.notificationChannelId}
          onChange={(e) => setForm({ notificationChannelId: e.target.value })}
        />
        <span className="subtle" style={{ fontSize: 12 }}>{t("auto.flows.edit.notifyHint")}</span>
      </label>
      <SaveRow save={save} dirty={dirty} canSave={dirty && !save.isPending} />
    </div>
  );
}
