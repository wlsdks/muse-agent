/**
 * Pre-execution context transforms extracted from
 * packages/agent-core/src/index.ts.
 *
 * Each transform takes its single dependency as a parameter, returns the
 * adjusted input/context, and is fail-open (errors collapse back to the
 * unmodified input). The AgentRuntime threads them in sequence before the
 * model loop so the boundaries between agent-spec resolution / user-memory
 * injection / stored-summary replay / prompt-layer rendering / exemplar
 * retrieval are all visible at the call site.
 */

import type { AgentSpecResolution } from "@muse/agent-specs";
import { COMPACTION_SUMMARY_PREFIX, type ConversationSummary, type ConversationSummaryStore } from "@muse/memory";
import type { ModelMessage } from "@muse/model";
import {
  buildLayeredSystemPrompt,
  renderExemplarContext,
  type ExemplarRetriever,
  type PromptLayerRegistry
} from "@muse/prompts";

import { renderActiveContextSection, type ActiveContextProvider, type ActiveContextSnapshot } from "./active-context.js";
import {
  renderEpisodicSection,
  type EpisodicRecallProvider,
  type EpisodicRecallSnapshot
} from "./episodic-recall.js";
import {
  renderInboxSection,
  type InboxContextProvider,
  type InboxSnapshot
} from "./inbox-context.js";
import { joinUserMessages } from "./internals.js";
import {
  appendSystemSection,
  applyAgentSpecSystemPrompt,
  latestUserPrompt,
  metadataString,
  renderUserMemorySection
} from "./runtime-helpers.js";
import type {
  AgentRunContext,
  AgentRunInput,
  AgentSpecResolver,
  UserMemoryProvider,
  UserMemorySnapshot
} from "./types.js";

export async function applyAgentSpec(
  input: AgentRunInput,
  resolver: AgentSpecResolver | undefined
): Promise<{
  readonly agentSpec?: AgentSpecResolution;
  readonly input: AgentRunInput;
}> {
  if (!resolver) {
    return { input };
  }

  try {
    const resolution = await resolver.resolve(joinUserMessages(input.messages));

    if (!resolution) {
      return {
        input: {
          ...input,
          metadata: {
            ...input.metadata,
            agentSpecResolutionAttempted: true
          }
        }
      };
    }

    return {
      agentSpec: resolution,
      input: {
        ...input,
        messages: applyAgentSpecSystemPrompt(input.messages, resolution),
        metadata: {
          ...input.metadata,
          agentSpecConfidence: resolution.confidence,
          agentSpecMatchedKeywords: [...resolution.matchedKeywords],
          agentSpecName: resolution.spec.name,
          agentSpecResolutionAttempted: true,
          agentSpecToolNames: [...resolution.spec.toolNames]
        }
      }
    };
  } catch {
    return {
      input: {
        ...input,
        metadata: {
          ...input.metadata,
          agentSpecResolutionAttempted: true,
          agentSpecResolutionFailed: true
        }
      }
    };
  }
}

/**
 * Stamp a `<transform>Failed: true` flag onto the input metadata
 * so observability can distinguish "transform threw" from
 * "transform not configured". Used by every transform's catch
 * block so failures don't disappear silently — the surface stays
 * fail-open (caller still gets a usable input), but the run span
 * now records WHICH transform tripped.
 */
function failedMetadata(input: AgentRunInput, failureKey: string): AgentRunInput {
  return {
    ...input,
    metadata: {
      ...input.metadata,
      [failureKey]: true
    }
  };
}

/**
 * Resolve the `ActiveContextSnapshot` once per request so both the
 * `applyActiveContext` system-prompt injection AND the importance
 * scorer used during compaction can read from a single source of
 * truth. Fail-open: any error returns `undefined`.
 */
export async function resolveActiveContextSnapshot(
  context: AgentRunContext,
  provider: ActiveContextProvider | undefined
): Promise<ActiveContextSnapshot | undefined> {
  if (!provider) {
    return undefined;
  }
  try {
    return (await provider.resolve({
      sessionId: metadataString(context.input.metadata, "sessionId"),
      userId: metadataString(context.input.metadata, "userId")
    })) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Inject `[Active Context]` (current time, timezone, working-hours,
 * active task, current focus) so the agent does not have to call
 * `muse.time.now` or the task tools just to orient itself. Caller
 * pre-resolves the snapshot via `resolveActiveContextSnapshot` so
 * the value can be shared with the compaction trim's
 * `importanceContext`.
 */
export function applyActiveContext(
  context: AgentRunContext,
  snapshot: ActiveContextSnapshot | undefined
): AgentRunInput {
  const rendered = renderActiveContextSection(snapshot);
  if (!rendered) {
    return context.input;
  }
  return {
    ...context.input,
    messages: appendSystemSection(context.input.messages, rendered, "active-context"),
    metadata: {
      ...context.input.metadata,
      activeContextApplied: true,
      ...(snapshot?.isWorkingHours !== undefined ? { activeContextInWorkingHours: snapshot.isWorkingHours } : {})
    }
  };
}

/**
 * Inject `[Recent Messages]` (Slack / Discord / Telegram / LINE unread
 * highlights) so the agent does not need to invoke the inbox tool to
 * notice new traffic. Fail-open.
 */
export async function applyInboxContext(
  context: AgentRunContext,
  provider: InboxContextProvider | undefined
): Promise<AgentRunInput> {
  if (!provider) {
    return context.input;
  }
  let snapshot: InboxSnapshot | undefined;
  try {
    snapshot = (await provider.resolve(metadataString(context.input.metadata, "userId"))) ?? undefined;
  } catch {
    // Fail-open: leave the prompt unchanged but stamp a failure
    // flag onto metadata so observability can distinguish
    // "transform failed" from "transform not configured".
    return failedMetadata(context.input, "inboxContextFailed");
  }
  // Iter 56 — thread the run's start time as `nowIso` so the
  // inbox renderer can humanise `receivedAtIso` into "[5 min ago]"
  // / "[3h ago]" / etc. Matches the freshness affordance the other
  // context surfaces already use.
  const rendered = renderInboxSection(snapshot, context.startedAt.toISOString());
  if (!rendered) {
    return context.input;
  }
  return {
    ...context.input,
    messages: appendSystemSection(context.input.messages, rendered, "inbox-context"),
    metadata: {
      ...context.input.metadata,
      inboxContextApplied: true,
      inboxContextMessageCount: snapshot?.messages.length ?? 0
    }
  };
}

/**
 * Inject `[Episodic Memory]` — top-K relevant prior session summaries
 * — so the agent surfaces multi-session memory without each session
 * starting from a blank slate. Fail-open. Skipped silently when the
 * latest user prompt is empty.
 */
export async function applyEpisodicRecall(
  context: AgentRunContext,
  provider: EpisodicRecallProvider | undefined
): Promise<AgentRunInput> {
  if (!provider) {
    return context.input;
  }
  const query = latestUserPrompt(context.input.messages);
  if (!query) {
    return context.input;
  }
  let snapshot: EpisodicRecallSnapshot | undefined;
  try {
    snapshot = (await provider.resolve(query, metadataString(context.input.metadata, "userId"))) ?? undefined;
  } catch {
    return failedMetadata(context.input, "episodicRecallFailed");
  }
  // Iter 53 — thread the run's start time as `nowIso` so the
  // episodic renderer can humanise `createdAtIso` into "1 day ago"
  // / "3 weeks ago" / etc. Matches the freshness affordance the
  // active-context and reminders blocks already use.
  const rendered = renderEpisodicSection(snapshot, context.startedAt.toISOString());
  if (!rendered) {
    return context.input;
  }
  return {
    ...context.input,
    messages: appendSystemSection(context.input.messages, rendered, "episodic-recall"),
    metadata: {
      ...context.input.metadata,
      episodicRecallApplied: true,
      episodicRecallMatchCount: snapshot?.matches.length ?? 0
    }
  };
}

export async function applyUserMemory(
  context: AgentRunContext,
  provider: UserMemoryProvider | undefined,
  maxEntries: number
): Promise<AgentRunInput> {
  if (!provider) {
    return context.input;
  }
  const userId = metadataString(context.input.metadata, "userId");
  if (!userId) {
    return context.input;
  }
  let memory: UserMemorySnapshot | undefined;
  try {
    memory = await provider.findByUserId(userId);
  } catch {
    return failedMetadata(context.input, "userMemoryFailed");
  }
  if (!memory) {
    return context.input;
  }
  const rendered = renderUserMemorySection(memory, maxEntries);
  if (!rendered) {
    return context.input;
  }
  return {
    ...context.input,
    messages: appendSystemSection(context.input.messages, rendered, "user-memory"),
    metadata: {
      ...context.input.metadata,
      userMemoryFactCount: Object.keys(memory.facts).length,
      userMemoryPreferenceCount: Object.keys(memory.preferences).length
    }
  };
}

/**
 * If a conversation summary is persisted for the current `metadata.sessionId`,
 * prepend it as a system message carrying the COMPACTION_SUMMARY_PREFIX so
 * `trimConversationMessages` recognises it on the next compaction round and
 * extends rather than duplicates it. Skips silently when no store, no
 * sessionId, no stored summary, or the inbound messages already carry a
 * compaction-summary system message at index 0.
 */
export async function applyStoredConversationSummary(
  context: AgentRunContext,
  store: ConversationSummaryStore | undefined
): Promise<AgentRunInput> {
  if (!store) {
    return context.input;
  }
  const sessionId = metadataString(context.input.metadata, "sessionId");
  if (!sessionId) {
    return context.input;
  }
  const messages = context.input.messages;
  const firstSystem = messages.find((message) => message.role === "system");
  if (firstSystem && firstSystem.content.startsWith(COMPACTION_SUMMARY_PREFIX)) {
    return context.input;
  }
  let stored: ConversationSummary | undefined;
  try {
    stored = await store.get(sessionId);
  } catch {
    return context.input;
  }
  if (!stored || stored.narrative.trim().length === 0) {
    return context.input;
  }
  const summaryMessage: ModelMessage = {
    content: stored.narrative.startsWith(COMPACTION_SUMMARY_PREFIX)
      ? stored.narrative
      : `${COMPACTION_SUMMARY_PREFIX}: ${stored.narrative}]`,
    role: "system"
  };
  return {
    ...context.input,
    messages: [summaryMessage, ...messages]
  };
}

/**
 * Persists the trimmed compaction summary back to the store keyed by
 * `metadata.sessionId`. Looks at the system message at index 0 of the
 * already-trimmed `request.messages`; only writes when it carries the
 * COMPACTION_SUMMARY_PREFIX. Errors are swallowed so observability writes
 * never block run completion.
 */
export async function persistConversationSummaryFromRequest(
  context: AgentRunContext,
  request: { readonly messages: readonly ModelMessage[] },
  summarizedUpToIndex: number,
  store: ConversationSummaryStore | undefined
): Promise<void> {
  if (!store) {
    return;
  }
  const sessionId = metadataString(context.input.metadata, "sessionId");
  if (!sessionId) {
    return;
  }
  const head = request.messages[0];
  if (!head || head.role !== "system" || !head.content.startsWith(COMPACTION_SUMMARY_PREFIX)) {
    return;
  }
  const userId = metadataString(context.input.metadata, "userId");
  try {
    await store.save({
      narrative: head.content,
      sessionId,
      summarizedUpToIndex,
      ...(userId ? { userId } : {})
    });
  } catch {
    // observability writes are fail-open
  }
}

export function applyPromptLayers(
  context: AgentRunContext,
  providerId: string,
  model: string,
  registry: PromptLayerRegistry | undefined
): AgentRunContext {
  if (!registry) {
    return context;
  }

  const layers = registry.resolve({
    model,
    personaId: metadataString(context.input.metadata, "personaId"),
    promptTemplateId: metadataString(context.input.metadata, "promptTemplateId"),
    providerId
  });

  if (layers.length === 0) {
    return context;
  }

  const systemPrompt = buildLayeredSystemPrompt({}, layers);

  return {
    ...context,
    input: {
      ...context.input,
      messages: appendSystemSection(context.input.messages, systemPrompt, "prompt-layers"),
      metadata: {
        ...context.input.metadata,
        promptLayerIds: layers.map((layer) => layer.id)
      }
    }
  };
}

export async function applyPromptExemplars(
  context: AgentRunContext,
  retriever: ExemplarRetriever | undefined,
  topK: number
): Promise<AgentRunContext> {
  if (!retriever) {
    return context;
  }

  try {
    const query = joinUserMessages(context.input.messages);

    if (query.trim().length === 0) {
      return context;
    }

    const exemplars = renderExemplarContext(
      await retriever.retrieveTopK(query, topK)
    );

    if (!exemplars) {
      return context;
    }

    return {
      ...context,
      input: {
        ...context.input,
        messages: appendSystemSection(context.input.messages, exemplars, "prompt-exemplars"),
        metadata: {
          ...context.input.metadata,
          promptExemplarApplied: true
        }
      }
    };
  } catch {
    return {
      ...context,
      input: {
        ...context.input,
        metadata: {
          ...context.input.metadata,
          promptExemplarRetrievalFailed: true
        }
      }
    };
  }
}
