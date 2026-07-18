import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { errorMessage } from "@muse/shared/browser";

import { Button, Icon } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";
import { renameFlowPatch, toggleEnabledPatch } from "./flow-edit-compile.js";
import { dryRunUrl } from "./flow-executions-compile.js";
import { executionsQueryKey } from "./flow-executions.js";

import type { ApiClient } from "../api/client.js";
import type { FlowProjection } from "../api/types.js";

interface TriggerResult {
  readonly result: unknown;
}

export function FlowHeaderActions({
  client,
  flow,
  onDeleted,
  onDuplicated
}: {
  client: ApiClient;
  flow: FlowProjection;
  onDeleted: () => void;
  onDuplicated: (jobId: string) => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const invalidateFlows = () => void qc.invalidateQueries({ queryKey: ["flows"] });
  const invalidateExecutions = () => void qc.invalidateQueries({ queryKey: executionsQueryKey(client, flow.id) });

  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(flow.name);
  useEffect(() => {
    setNameDraft(flow.name);
    setRenaming(false);
  }, [flow.id, flow.name]);

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  useEffect(() => {
    if (!confirmingDelete) {
      return;
    }
    const timer = window.setTimeout(() => setConfirmingDelete(false), 4000);
    return () => window.clearTimeout(timer);
  }, [confirmingDelete]);

  const jobUrl = `/api/scheduler/jobs/${encodeURIComponent(flow.id)}`;

  const toggleEnabled = useMutation({
    mutationFn: () => client.patch(jobUrl, toggleEnabledPatch(!flow.enabled)),
    onSuccess: invalidateFlows
  });

  const rename = useMutation({
    mutationFn: () => client.patch(jobUrl, renameFlowPatch(nameDraft)),
    onSuccess: () => {
      setRenaming(false);
      invalidateFlows();
    }
  });

  const trigger = useMutation({
    mutationFn: () => client.post<TriggerResult>(`${jobUrl}/trigger`),
    onSuccess: () => {
      invalidateFlows();
      invalidateExecutions();
    }
  });

  const dryRun = useMutation({
    mutationFn: () => client.post<TriggerResult>(dryRunUrl(flow.id)),
    onSuccess: invalidateExecutions
  });

  const duplicate = useMutation({
    mutationFn: () =>
      client.post<{ readonly id: string }>(`${jobUrl}/duplicate`, {
        nameSuffix: t("auto.flows.header.duplicateSuffix")
      }),
    onSuccess: (created) => {
      invalidateFlows();
      onDuplicated(created.id);
    }
  });

  const remove = useMutation({
    mutationFn: () => client.del(jobUrl),
    onSuccess: () => {
      invalidateFlows();
      onDeleted();
    }
  });

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 8 }}>
        {renaming ? (
          <>
            <input
              className="input"
              style={{ maxWidth: 240 }}
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
            />
            <Button
              variant="primary"
              size="sm"
              disabled={nameDraft.trim().length === 0 || rename.isPending}
              onClick={() => rename.mutate()}
            >
              {t("auto.flows.header.renameSave")}
            </Button>
          </>
        ) : (
          // The flow's name already heads the workspace (the switcher) — the
          // actions row only carries the rename affordance, not a second title.
          <Button variant="ghost" size="sm" onClick={() => setRenaming(true)}>
            {t("auto.flows.header.rename")}
          </Button>
        )}
        <Button variant="secondary" size="sm" disabled={toggleEnabled.isPending} onClick={() => toggleEnabled.mutate()}>
          {t(flow.enabled ? "auto.flows.header.disable" : "auto.flows.header.enable")}
        </Button>
        <Button variant="secondary" size="sm" disabled={trigger.isPending} onClick={() => trigger.mutate()}>
          {trigger.isPending ? t("auto.flows.header.running") : t("auto.flows.header.runNow")}
        </Button>
        <Button variant="secondary" size="sm" disabled={dryRun.isPending} onClick={() => dryRun.mutate()}>
          {dryRun.isPending ? t("auto.flows.header.dryRunning") : t("auto.flows.header.dryRun")}
        </Button>
        <Button variant="secondary" size="sm" disabled={duplicate.isPending} onClick={() => duplicate.mutate()}>
          {duplicate.isPending ? t("auto.flows.header.duplicating") : t("auto.flows.header.duplicate")}
        </Button>
        <Button
          variant={confirmingDelete ? "danger" : "ghost"}
          size="sm"
          disabled={remove.isPending}
          onClick={() => {
            if (confirmingDelete) {
              remove.mutate();
            } else {
              setConfirmingDelete(true);
            }
          }}
        >
          <Icon.trash className="nav-icon" /> {confirmingDelete ? t("auto.flows.header.deleteConfirm") : t("auto.flows.header.delete")}
        </Button>
      </div>
      {rename.error && <div className="banner err">{errorMessage(rename.error, t("auto.flows.header.renameFailed"))}</div>}
      {trigger.isSuccess && (
        <div className="banner">{t("auto.flows.header.runResult", { status: describeTriggerResult(trigger.data) })}</div>
      )}
      {trigger.error && <div className="banner err">{errorMessage(trigger.error, t("auto.flows.header.runFailed"))}</div>}
      {dryRun.isSuccess && (
        <div className="banner">{t("auto.flows.header.dryRunResult", { status: describeTriggerResult(dryRun.data) })}</div>
      )}
      {dryRun.error && <div className="banner err">{errorMessage(dryRun.error, t("auto.flows.header.dryRunFailed"))}</div>}
      {duplicate.error && <div className="banner err">{errorMessage(duplicate.error, t("auto.flows.header.duplicateFailed"))}</div>}
      {remove.error && <div className="banner err">{errorMessage(remove.error, t("auto.flows.header.deleteFailed"))}</div>}
    </div>
  );
}

function describeTriggerResult(data: TriggerResult | undefined): string {
  if (!data) {
    return "";
  }
  return typeof data.result === "string" ? data.result : JSON.stringify(data.result);
}
