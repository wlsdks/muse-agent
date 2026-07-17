import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ReactFlow, ReactFlowProvider } from "@xyflow/react";
import { useState } from "react";
import { errorMessage } from "@muse/shared/browser";

import { Button, Card } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";
import { flowToCanvas } from "./flow-canvas-mapping.js";
import { FLOW_EDGE_TYPES } from "./flow-edges.js";
import {
  draftToPreviewProjection,
  emptyFlowDraft,
  flowDraftFromCopilot,
  flowDraftToJobInput,
  isFlowDraftValid,
  isValidCronShape,
  MAX_RETRY_COUNT,
  MIN_RETRY_COUNT,
  SCHEDULE_PRESETS,
  type FlowDraft,
  type ScheduleKind
} from "./flow-edit-compile.js";
import { FLOW_NODE_TYPES } from "./flow-nodes.js";
import { PRESET_LABEL_KEY } from "./flow-edit-panel.js";

import type { ApiClient } from "../api/client.js";
import type { FlowDraftPayloadRow, ScheduledJobDetail } from "../api/types.js";

/**
 * 새 흐름 만들기: a form + a live READ-ONLY preview canvas built client-side
 * from the same draft (`draftToPreviewProjection` + the real `flowToCanvas`)
 * so the user sees the exact node/edge shape they're about to create before
 * `POST /api/scheduler/jobs` ever fires. Freeform drag-connect isn't part of
 * this slice — the form guarantees a valid trigger->action->output(+retry)
 * program by construction.
 */
export function FlowCreatePanel({
  client,
  onCreated,
  onCancel,
  initialDraft
}: {
  client: ApiClient;
  onCreated: (jobId: string) => void;
  onCancel: () => void;
  /** A 코파일럿 초안 (copilot draft) to prefill the form with — the user still
   * reviews every field and clicks 만들기; nothing is created automatically. */
  initialDraft?: FlowDraftPayloadRow;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<FlowDraft>(() => (initialDraft ? flowDraftFromCopilot(initialDraft) : emptyFlowDraft()));

  const create = useMutation({
    mutationFn: () => client.post<ScheduledJobDetail>("/api/scheduler/jobs", flowDraftToJobInput(draft)),
    onSuccess: (job) => {
      void qc.invalidateQueries({ queryKey: ["flows"] });
      onCreated(job.id);
    }
  });

  const customInvalid = draft.schedule.kind === "custom" && !isValidCronShape(draft.schedule.customCron);
  const canCreate = isFlowDraftValid(draft) && !create.isPending;
  const canvas = flowToCanvas(draftToPreviewProjection(draft));

  return (
    <Card title={t("auto.flows.create.title")} className="lifted">
      <div style={{ display: "grid", gap: 10, marginTop: 8 }}>
        {initialDraft && <div className="banner">{t("auto.flows.draft.panelNotice")}</div>}
        <label style={{ display: "grid", gap: 4 }}>
          <span className="field-label">{t("auto.flows.create.nameLabel")}</span>
          <input
            className="input"
            type="text"
            placeholder={t("auto.flows.create.namePlaceholder")}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>

        <label style={{ display: "grid", gap: 4 }}>
          <span className="field-label">{t("auto.flows.edit.scheduleLabel")}</span>
          <select
            className="input"
            value={draft.schedule.kind}
            onChange={(e) => {
              const kind = e.target.value as ScheduleKind;
              setDraft({ ...draft, schedule: { customCron: kind === "custom" ? draft.schedule.customCron : "", kind } });
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
        {draft.schedule.kind === "custom" && (
          <label style={{ display: "grid", gap: 4 }}>
            <span className="field-label">{t("auto.flows.edit.customCronLabel")}</span>
            <input
              className="input"
              type="text"
              value={draft.schedule.customCron}
              onChange={(e) => setDraft({ ...draft, schedule: { customCron: e.target.value, kind: "custom" } })}
            />
            <span className="subtle" style={{ fontSize: 12 }}>{t("auto.flows.edit.customCronHint")}</span>
            {customInvalid && (
              <span className="subtle" style={{ color: "var(--err)", fontSize: 12 }}>
                {t("auto.flows.edit.customCronInvalid")}
              </span>
            )}
          </label>
        )}

        <label style={{ display: "grid", gap: 4 }}>
          <span className="field-label">{t("auto.flows.edit.promptLabel")}</span>
          <textarea
            className="input"
            rows={3}
            value={draft.agentPrompt}
            onChange={(e) => setDraft({ ...draft, agentPrompt: e.target.value })}
          />
        </label>

        <label style={{ display: "grid", gap: 4 }}>
          <span className="field-label">{t("auto.flows.edit.modelLabel")}</span>
          <input
            className="input"
            type="text"
            placeholder={t("auto.flows.edit.modelPlaceholder")}
            value={draft.agentModel}
            onChange={(e) => setDraft({ ...draft, agentModel: e.target.value })}
          />
        </label>

        <label style={{ display: "grid", gap: 4 }}>
          <span className="field-label">{t("auto.flows.edit.notifyLabel")}</span>
          <input
            className="input"
            type="text"
            placeholder={t("auto.flows.edit.notifyPlaceholder")}
            value={draft.notificationChannelId}
            onChange={(e) => setDraft({ ...draft, notificationChannelId: e.target.value })}
          />
          <span className="subtle" style={{ fontSize: 12 }}>{t("auto.flows.edit.notifyHint")}</span>
        </label>

        <label style={{ alignItems: "center", display: "flex", gap: 8 }}>
          <input
            type="checkbox"
            checked={draft.retryOnFailure}
            onChange={(e) => setDraft({ ...draft, retryOnFailure: e.target.checked })}
          />
          <span className="field-label">{t("auto.flows.edit.retryLabel")}</span>
        </label>
        {draft.retryOnFailure && (
          <label style={{ display: "grid", gap: 4, maxWidth: 160 }}>
            <span className="field-label">{t("auto.flows.edit.retryCountLabel")}</span>
            <input
              className="input"
              type="number"
              min={MIN_RETRY_COUNT}
              max={MAX_RETRY_COUNT}
              value={draft.maxRetryCount}
              onChange={(e) => setDraft({ ...draft, maxRetryCount: Number(e.target.value) })}
            />
          </label>
        )}

        <div>
          <span className="field-label">{t("auto.flows.create.previewTitle")}</span>
          <div className="flow-canvas-wrap" style={{ height: 180, marginTop: 6 }}>
            <ReactFlowProvider>
              <ReactFlow
                nodes={[...canvas.nodes]}
                edges={[...canvas.edges]}
                nodeTypes={FLOW_NODE_TYPES}
                edgeTypes={FLOW_EDGE_TYPES}
                fitView
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={false}
                panOnScroll={false}
                zoomOnScroll={false}
                proOptions={{ hideAttribution: true }}
              />
            </ReactFlowProvider>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <Button variant="primary" disabled={!canCreate} onClick={() => create.mutate()}>
            {create.isPending ? t("auto.flows.create.creating") : t("auto.flows.create.submit")}
          </Button>
          <Button variant="ghost" onClick={onCancel}>{t("auto.flows.create.cancel")}</Button>
        </div>
        {create.error && <div className="banner err">{errorMessage(create.error, t("auto.flows.create.createFailed"))}</div>}
      </div>
    </Card>
  );
}
