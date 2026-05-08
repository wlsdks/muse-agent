/**
 * Slack assistant-thread progress hook extracted from
 * packages/integrations/src/index.ts. Owns the friendly tool-name
 * registry, the throttle/length thresholds, and the HookStage that
 * forwards beforeTool/afterTool events to
 * `assistant.threads.setStatus()` via the configured transport.
 *
 * Re-exported from the integrations barrel for backwards compatibility.
 */

import type { AgentRunContext, HookStage } from "@muse/agent-core";
import type { JsonObject } from "@muse/shared";
import type { SlackProgressHookOptions } from "./index.js";

export const SLACK_PROGRESS_DEFAULT_FRIENDLY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  jira_search: "Jira 검색",
  jira_get_issue: "Jira 이슈 조회",
  jira_create_issue: "Jira 이슈 생성",
  jira_update_issue: "Jira 이슈 업데이트",
  jira_add_comment: "Jira 코멘트 작성",
  confluence_search_by_text: "Confluence 검색",
  confluence_get_page: "Confluence 페이지 조회",
  confluence_create_page: "Confluence 페이지 작성",
  bitbucket_list_prs: "Bitbucket PR 조회",
  bitbucket_get_pr: "Bitbucket PR 상세 조회",
  bitbucket_create_pr: "Bitbucket PR 생성",
  rag_search: "내부 문서 검색",
  web_search: "웹 검색"
});

export const SLACK_PROGRESS_DEFAULT_MIN_UPDATE_MS = 1500;
export const SLACK_PROGRESS_MAX_STATUS_LENGTH = 100;

export function createSlackProgressHook(options: SlackProgressHookOptions): HookStage {
  const minUpdateIntervalMs = options.minUpdateIntervalMs ?? SLACK_PROGRESS_DEFAULT_MIN_UPDATE_MS;
  const friendlyNames = options.friendlyNames ?? SLACK_PROGRESS_DEFAULT_FRIENDLY_NAMES;
  const now = options.now ?? (() => Date.now());
  const lastUpdateMsByRunId = new Map<string, number>();

  function readMetadataString(metadata: JsonObject | undefined, key: string): string | undefined {
    if (!metadata) {
      return undefined;
    }
    const value = metadata[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  function friendlyLabel(toolName: string): string {
    const override = friendlyNames[toolName];
    if (typeof override === "string" && override.length > 0) {
      return override;
    }
    return toolName
      .split(/[_\s]+/u)
      .filter((part) => part.length > 0)
      .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
      .join(" ");
  }

  function tryAcquireUpdateSlot(runId: string): boolean {
    const current = now();
    const last = lastUpdateMsByRunId.get(runId);
    if (last !== undefined && current - last < minUpdateIntervalMs) {
      return false;
    }
    lastUpdateMsByRunId.set(runId, current);
    return true;
  }

  async function updateStatus(context: AgentRunContext, status: string): Promise<void> {
    const channelId = readMetadataString(context.input.metadata, "slackChannelId");
    const threadTs = readMetadataString(context.input.metadata, "slackThreadTs");
    if (!channelId || !threadTs) {
      return;
    }

    if (!tryAcquireUpdateSlot(context.runId)) {
      return;
    }

    const truncated =
      status.length > SLACK_PROGRESS_MAX_STATUS_LENGTH
        ? status.slice(0, SLACK_PROGRESS_MAX_STATUS_LENGTH)
        : status;

    try {
      await options.transport.setStatus({ channelId, status: truncated, threadTs });
    } catch (error) {
      options.onError?.(error);
    }
  }

  return {
    afterComplete: async (context) => {
      lastUpdateMsByRunId.delete(context.runId);
    },
    afterTool: async (context, toolCall, result) => {
      const label = friendlyLabel(toolCall.name);
      const message =
        result.status === "completed"
          ? `✓ ${label} 완료 — 다음 단계 진행 중…`
          : `⚠️ ${label} 실패 — 복구 중…`;
      await updateStatus(context, message);
    },
    beforeTool: async (context, toolCall) => {
      await updateStatus(context, `🔍 ${friendlyLabel(toolCall.name)} 중…`);
    },
    id: options.id ?? "slack-progress",
    onError: async (context) => {
      lastUpdateMsByRunId.delete(context.runId);
    }
  };
}
