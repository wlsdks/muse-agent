import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage } from "@muse/shared/browser";

import { Button } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";
import { copilotPayloadFromJob, patchFromDraftRevision } from "./flow-edit-compile.js";
import { describeDraftRevision } from "./flow-draft-diff.js";
import { FlowDraftComposer } from "./flow-draft-composer.js";

import type { ApiClient } from "../api/client.js";
import type { FlowDraftPayloadRow, ScheduledJobDetail } from "../api/types.js";

/**
 * Copilot chat against an EXISTING flow: revision turns run over the live
 * job's projected payload, and the model's proposal becomes a PATCH only
 * after the user presses 적용 (draft-first — chat never mutates a flow by
 * itself). The PATCH body is the deterministic changed-fields mapping
 * (`patchFromDraftRevision`), never the model's raw output; an agent↔tool
 * action flip is refused rather than migrated.
 */
export function EditFlowCopilot({ client, flowId }: { client: ApiClient; flowId: string }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [proposal, setProposal] = useState<FlowDraftPayloadRow | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const job = useQuery({
    queryFn: () => client.get<ScheduledJobDetail>(`/api/scheduler/jobs/${encodeURIComponent(flowId)}`),
    queryKey: ["scheduler-job-detail", client.baseUrl, flowId]
  });

  const apply = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      client.patch(`/api/scheduler/jobs/${encodeURIComponent(flowId)}`, patch),
    onSuccess: () => {
      setProposal(undefined);
      setNotice(t("auto.flows.editChat.applied"));
      void qc.invalidateQueries({ queryKey: ["flows"] });
      void qc.invalidateQueries({ queryKey: ["scheduler-job-detail", client.baseUrl, flowId] });
    }
  });

  if (!job.data) {
    return <p className="subtle" style={{ padding: 12 }}>{t("auto.flows.detailEmpty")}</p>;
  }

  const current = copilotPayloadFromJob(job.data);
  const resolved = proposal ? patchFromDraftRevision(current, proposal) : undefined;

  return (
    <div className="copilot-chat">
      <FlowDraftComposer
        key={flowId}
        client={client}
        currentDraft={current}
        onDrafted={(next) => {
          setNotice(undefined);
          setProposal(next);
        }}
      />
      {proposal && resolved && (
        <div className="copilot-apply">
          {resolved.ok ? (
            <>
              <span className="copilot-apply-text">{describeDraftRevision(current, proposal, t)}</span>
              <Button
                variant="primary"
                size="sm"
                disabled={apply.isPending}
                onClick={() => apply.mutate(resolved.patch as Record<string, unknown>)}
              >
                {t("auto.flows.editChat.apply")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setProposal(undefined)}>
                {t("auto.flows.editChat.discard")}
              </Button>
            </>
          ) : (
            <span className="copilot-apply-text subtle">
              {t(resolved.reason === "action-flip" ? "auto.flows.editChat.actionFlip" : "auto.flows.draft.ackNoChange")}
            </span>
          )}
        </div>
      )}
      {apply.error && <div className="banner err">{errorMessage(apply.error, t("auto.flows.edit.saveFailed"))}</div>}
      {notice && !proposal && <div className="copilot-apply"><span className="copilot-apply-text subtle">{notice}</span></div>}
    </div>
  );
}
