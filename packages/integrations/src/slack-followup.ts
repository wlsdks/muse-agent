/**
 * Slack follow-up suggestion primitives extracted from
 * packages/integrations/src/index.ts. Owns the post-response action
 * surface: HTML-comment marker parsing, Block Kit button rendering,
 * action-id formatting, and the SlackInteractionHandler that records
 * clicks (via FollowupSuggestionStore) and re-invokes the agent for
 * the chosen prompt.
 *
 * Re-exported from the integrations barrel for backwards compatibility.
 */

import type { FollowupSuggestionStore } from "@muse/observability";
import type { JsonObject } from "@muse/shared";
import type {
  Awaitable,
  SlackInteractionHandler,
  SlackInteractionPayload,
  SlackMessageTransport,
  SlackResponseUrlTransport
} from "./index.js";

export interface FollowupSuggestion {
  readonly id: string;
  readonly label: string;
  readonly prompt: string;
  readonly category: string;
}

export const FOLLOWUP_ACTION_PREFIX = "followup";
export const FOLLOWUP_MAX_PER_MESSAGE = 5;
export const FOLLOWUP_MAX_LABEL_LENGTH = 75;

const FOLLOWUP_MARKER_PATTERN = /<!--\s*FOLLOWUPS\s*:\s*(\[[\s\S]*?\])\s*-->/u;

export function parseFollowupSuggestions(text: string): readonly FollowupSuggestion[] {
  const match = FOLLOWUP_MARKER_PATTERN.exec(text);
  if (!match || !match[1]) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1].trim());
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const suggestions: FollowupSuggestion[] = [];
  for (const entry of parsed) {
    if (suggestions.length >= FOLLOWUP_MAX_PER_MESSAGE) {
      break;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id = record["id"];
    const label = record["label"];
    const prompt = record["prompt"];
    const category = record["category"];
    if (
      typeof id !== "string" ||
      id.trim().length === 0 ||
      typeof label !== "string" ||
      label.trim().length === 0 ||
      typeof prompt !== "string" ||
      prompt.trim().length === 0 ||
      typeof category !== "string" ||
      category.trim().length === 0
    ) {
      continue;
    }
    suggestions.push({ category, id, label, prompt });
  }
  return suggestions;
}

export function stripFollowupMarker(text: string): string {
  return text.replace(FOLLOWUP_MARKER_PATTERN, "").trimEnd();
}

export function truncateFollowupLabel(label: string): string {
  if (label.length <= FOLLOWUP_MAX_LABEL_LENGTH) {
    return label;
  }
  return `${label.slice(0, FOLLOWUP_MAX_LABEL_LENGTH - 1)}…`;
}

export function followupActionId(suggestion: FollowupSuggestion): string {
  return `${FOLLOWUP_ACTION_PREFIX}.${suggestion.id}`;
}

export function extractFollowupCategory(suggestionId: string): string {
  const underscoreIndex = suggestionId.indexOf("_");
  if (underscoreIndex <= 0) {
    return "other";
  }
  return suggestionId.slice(0, underscoreIndex);
}

export function renderFollowupSuggestionBlocks(suggestions: readonly FollowupSuggestion[]): readonly JsonObject[] {
  if (suggestions.length === 0) {
    return [];
  }
  const limited = suggestions.slice(0, FOLLOWUP_MAX_PER_MESSAGE);
  return [
    {
      elements: limited.map((suggestion) => ({
        action_id: followupActionId(suggestion),
        text: { emoji: true, text: truncateFollowupLabel(suggestion.label), type: "plain_text" },
        type: "button",
        value: suggestion.prompt
      })),
      type: "actions"
    }
  ];
}

export interface FollowupAgentReplyResult {
  readonly text: string;
}

export interface FollowupSuggestionInteractionHandlerOptions {
  readonly store?: FollowupSuggestionStore;
  readonly runAgent: (input: {
    readonly prompt: string;
    readonly payload: SlackInteractionPayload;
    readonly suggestionId: string;
    readonly category: string;
  }) => Awaitable<FollowupAgentReplyResult | null>;
  readonly messageTransport?: SlackMessageTransport;
  readonly responseTransport?: SlackResponseUrlTransport;
  readonly now?: () => Date;
  readonly logger?: (message: string, error?: unknown) => void;
}

export function createFollowupSuggestionInteractionHandler(
  options: FollowupSuggestionInteractionHandlerOptions
): SlackInteractionHandler {
  return {
    actionIdPrefix: FOLLOWUP_ACTION_PREFIX,
    handle: async (payload: SlackInteractionPayload): Promise<boolean> => {
      const prompt = payload.value;
      const channelId = payload.channelId;
      if (!prompt || prompt.trim().length === 0 || !channelId) {
        return true;
      }
      const suggestionId = payload.actionId.startsWith(`${FOLLOWUP_ACTION_PREFIX}.`)
        ? payload.actionId.slice(FOLLOWUP_ACTION_PREFIX.length + 1)
        : payload.actionId;
      const category = extractFollowupCategory(suggestionId);

      try {
        options.store?.recordClick({
          category,
          channelId,
          ...(options.now ? { occurredAt: options.now() } : {}),
          suggestionId,
          userId: payload.userId,
          ...(payload.messageTs ? { messageTs: payload.messageTs } : {})
        });
      } catch (error) {
        options.logger?.("FollowupSuggestionHandler click record failed", error);
      }

      let reply: FollowupAgentReplyResult | null;
      try {
        reply = await options.runAgent({ category, payload, prompt, suggestionId });
      } catch (error) {
        options.logger?.("FollowupSuggestionHandler agent execution failed", error);
        return true;
      }

      if (!reply || reply.text.trim().length === 0) {
        return true;
      }

      try {
        await options.messageTransport?.postMessage({
          channelId,
          text: reply.text,
          ...(payload.messageTs ? { threadTs: payload.messageTs } : {})
        });
      } catch (error) {
        options.logger?.("FollowupSuggestionHandler message post failed", error);
      }

      return true;
    }
  };
}
