import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { AsyncBlock, Badge, Button, Card } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";
import { relativeAgo } from "./chats-logic.js";
import { clampPreview, EXECUTIONS_DEFAULT_LIMIT, executionsUrl, humanizeDurationMs, resolveExecutionDisplay, statusTone } from "./flow-executions-compile.js";

import type { ApiClient } from "../api/client.js";
import type { ScheduledJobExecutionRow, ScheduledJobExecutionsResponse } from "../api/types.js";
import type { StringKey } from "../i18n/index.js";

const STATUS_LABEL_KEY: Record<string, StringKey> = {
  FAILED: "auto.flows.executions.status.failed",
  RUNNING: "auto.flows.executions.status.running",
  SKIPPED: "auto.flows.executions.status.skipped",
  SUCCESS: "auto.flows.executions.status.success"
};

/** Same query key shape the header actions' 지금 실행 / 테스트 실행 mutations
 * invalidate on settle — keep both call sites building it from this one
 * function so a jobId/baseUrl typo can't desync them. */
export function executionsQueryKey(client: Pick<ApiClient, "baseUrl">, jobId: string) {
  return ["flow-executions", client.baseUrl, jobId] as const;
}

export function ExecutionsCard({ client, jobId }: { client: ApiClient; jobId: string }) {
  const { t } = useI18n();
  const q = useQuery({
    queryFn: () => client.get<ScheduledJobExecutionsResponse>(executionsUrl(jobId, EXECUTIONS_DEFAULT_LIMIT)),
    queryKey: executionsQueryKey(client, jobId)
  });
  const items = q.data?.items ?? [];

  return (
    <Card title={t("auto.flows.executions.title")}>
      <AsyncBlock loading={q.isLoading} error={q.error} empty={items.length === 0} emptyLabel={t("auto.flows.executions.empty")}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {items.map((execution) => (
            <ExecutionRow key={execution.id} execution={execution} />
          ))}
        </div>
      </AsyncBlock>
    </Card>
  );
}

function ExecutionRow({ execution }: { execution: ScheduledJobExecutionRow }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const display = resolveExecutionDisplay(execution);
  const preview = clampPreview(display.text);

  return (
    <div className="row" style={{ alignItems: "flex-start", flexDirection: "column" }}>
      <div className="row-main" style={{ width: "100%" }}>
        <div className="row-title" style={{ alignItems: "center", display: "flex", gap: 6, whiteSpace: "normal" }}>
          <Badge tone={statusTone(execution.status)}>
            {t(STATUS_LABEL_KEY[execution.status] ?? "auto.flows.executions.status.skipped")}
          </Badge>
          {execution.dryRun && (
            <Badge tone="neutral" dot={false}>
              {t("auto.flows.executions.dryRunBadge")}
            </Badge>
          )}
        </div>
        <div className="row-meta">
          {relativeAgo(new Date(execution.startedAt).toISOString(), t)} · {humanizeDurationMs(execution.durationMs)}
        </div>
        {execution.triggeredBy === "webhook" && execution.payloadPreview && (
          <div className="row-meta" style={{ marginTop: 6, whiteSpace: "normal" }}>
            {t("auto.flows.executions.webhookPayload")}: {execution.payloadPreview}
          </div>
        )}
        {display.text.length > 0 && (
          <div
            className={`row-meta${display.tone === "error" ? " exec-error" : ""}`}
            style={{ marginTop: 6, whiteSpace: expanded ? "pre-wrap" : "normal" }}
          >
            {expanded ? display.text : preview.text}
            {preview.clamped && (
              <div style={{ marginTop: 4 }}>
                <Button variant="ghost" size="sm" onClick={() => setExpanded((value) => !value)}>
                  {expanded ? t("auto.flows.executions.showLess") : t("auto.flows.executions.showMore")}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
