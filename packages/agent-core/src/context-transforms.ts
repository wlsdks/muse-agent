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
import {
  COMPACTION_SUMMARY_PREFIX,
  type ConversationSummary,
  type ConversationSummaryStore,
  mergeSalientFacts,
  parseKeyDetailsBlock
} from "@muse/memory";
import type { ModelMessage } from "@muse/model";
import {
  composeSurfacePrompt,
  renderExemplarContext,
  type ExemplarRetriever,
  type PromptLayer,
  type PromptLayerContext,
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
import { renderToolExemplarSection, selectToolExemplars, type ToolExemplar } from "./tool-exemplars.js";
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

const INBOX_GROUNDING_TEXT_CAP = 1000;
const INBOX_GROUNDING_MAX = 24;

/**
 * Map an injected inbox snapshot to grounding-evidence sources
 * `{ source: "inbox/<provider>", text: "<sender>: <body>" }`. A caller's
 * output-side grounding verdict scores a `--with-tools` answer against
 * THESE (the messages the agent was actually shown), the same way it
 * scores against tool outputs — so a correct "Sarah asked you to call her
 * back" answer recalled from a freshly-arrived message is treated as
 * GROUNDED, not false-flagged against the notes-only evidence set. Capped
 * (count + per-message length) so a chatty inbox can't bloat the reverify
 * prompt; empty bodies are skipped.
 */
export function inboxGroundingSources(
  snapshot: InboxSnapshot | undefined
): readonly { readonly source: string; readonly text: string }[] {
  if (!snapshot || snapshot.messages.length === 0) {
    return [];
  }
  const out: { source: string; text: string }[] = [];
  for (const message of snapshot.messages.slice(0, INBOX_GROUNDING_MAX)) {
    const sender = message.sender ? `${message.sender}: ` : "";
    const text = `${sender}${message.text}`.trim();
    if (text.length === 0) {
      continue;
    }
    out.push({
      source: `inbox/${message.providerId}`,
      text: text.length > INBOX_GROUNDING_TEXT_CAP ? text.slice(0, INBOX_GROUNDING_TEXT_CAP) : text
    });
  }
  return out;
}

/**
 * Inject `[Recent Messages]` (Slack / Discord / Telegram / LINE unread
 * highlights) so the agent does not need to invoke the inbox tool to
 * notice new traffic, AND surface the injected messages as grounding
 * evidence so a recalled inbound message is citeable (see
 * `inboxGroundingSources`). One resolve only — the provider advances its
 * injection cursor on resolve, so the snapshot must be captured here, not
 * re-fetched. Fail-open.
 */
export async function applyInboxContextWithGrounding(
  context: AgentRunContext,
  provider: InboxContextProvider | undefined
): Promise<{ readonly input: AgentRunInput; readonly groundingSources: readonly { readonly source: string; readonly text: string }[] }> {
  if (!provider) {
    return { groundingSources: [], input: context.input };
  }
  let snapshot: InboxSnapshot | undefined;
  try {
    snapshot = (await provider.resolve(metadataString(context.input.metadata, "userId"))) ?? undefined;
  } catch {
    // Fail-open: leave the prompt unchanged but stamp a failure
    // flag onto metadata so observability can distinguish
    // "transform failed" from "transform not configured".
    return { groundingSources: [], input: failedMetadata(context.input, "inboxContextFailed") };
  }
  // thread the run's start time as `nowIso` so the
  // inbox renderer can humanise `receivedAtIso` into "[5 min ago]"
  // / "[3h ago]" / etc. Matches the freshness affordance the other
  // context surfaces already use.
  const rendered = renderInboxSection(snapshot, context.startedAt.toISOString());
  if (!rendered) {
    return { groundingSources: [], input: context.input };
  }
  return {
    groundingSources: inboxGroundingSources(snapshot),
    input: {
      ...context.input,
      messages: appendSystemSection(context.input.messages, rendered, "inbox-context"),
      metadata: {
        ...context.input.metadata,
        inboxContextApplied: true,
        inboxContextMessageCount: snapshot?.messages.length ?? 0
      }
    }
  };
}

export async function applyInboxContext(
  context: AgentRunContext,
  provider: InboxContextProvider | undefined
): Promise<AgentRunInput> {
  return (await applyInboxContextWithGrounding(context, provider)).input;
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
  // thread the run's start time as `nowIso` so the
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

// Leading system messages that are NOT a compaction summary — mirrors
// `leadingRealSystemCount` in @muse/memory's trimmer, so a real (persona/
// tool/memory) system prompt already at the front of the array is never
// displaced by the re-injected summary; the summary always lands right
// after it, keeping the stable prefix a caching provider relies on.
function leadingNonSummarySystemCount(messages: readonly ModelMessage[]): number {
  let index = 0;
  while (
    index < messages.length &&
    messages[index]?.role === "system" &&
    !messages[index]!.content.startsWith(COMPACTION_SUMMARY_PREFIX)
  ) {
    index++;
  }
  return index;
}

/**
 * If a conversation summary is persisted for the current `metadata.sessionId`,
 * insert it as a system message carrying the COMPACTION_SUMMARY_PREFIX —
 * right after any real leading system message(s), never before them — so
 * `trimConversationMessages` recognises it on the next compaction round and
 * extends rather than duplicates it. Skips silently when no store, no
 * sessionId, no stored summary, or the inbound messages already carry a
 * compaction-summary system message in that slot.
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
  const insertIndex = leadingNonSummarySystemCount(messages);
  const existing = messages[insertIndex];
  if (existing?.role === "system" && existing.content.startsWith(COMPACTION_SUMMARY_PREFIX)) {
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
    messages: [...messages.slice(0, insertIndex), summaryMessage, ...messages.slice(insertIndex)]
  };
}

/**
 * Persists the trimmed compaction summary back to the store keyed by
 * `metadata.sessionId`. Finds the compaction-summary system message
 * anywhere in the already-trimmed `request.messages` (it may sit after a
 * real leading system prompt, not necessarily at index 0); only writes
 * when one is found. Errors are swallowed so observability writes never
 * block run completion.
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
  const head = request.messages.find(
    (message) => message.role === "system" && message.content.startsWith(COMPACTION_SUMMARY_PREFIX)
  );
  if (!head) {
    return;
  }
  const userId = metadataString(context.input.metadata, "userId");
  try {
    // Parse the [Key details] block from the compaction summary and merge
    // with any facts already stored — ends the wipe (facts ?? [] coercion)
    // and populates the field that had zero writers before.
    const parsedFacts = parseKeyDetailsBlock(head.content);
    let stored: ConversationSummary | undefined;
    try {
      stored = await store.get(sessionId);
    } catch {
      // fail-open: treat as no prior facts
    }
    const mergedFacts = mergeSalientFacts(stored?.facts ?? [], parsedFacts);
    await store.save({
      facts: mergedFacts,
      narrative: head.content,
      sessionId,
      summarizedUpToIndex,
      ...(userId ? { userId } : {})
    });
  } catch {
    // observability writes are fail-open
  }
}

/**
 * Base-prompt resolution for the "chat" surface (docs/strategy/
 * prompt-architecture.md Phase 1) — the FIRST system-prompt transform
 * AgentRuntime runs, so it fires on every run regardless of surface (CLI
 * chat, /api/chat, channel replies all share this one seam). It used to
 * early-return with no system prompt at all when no `PromptLayerRegistry`
 * was configured or it resolved zero layers — since nothing in this
 * codebase wires a registry, that made the identity anchor dead code on
 * the real HTTP path (a fresh /api/chat request with no client-supplied
 * `systemPrompt` reached the model with none). `composeSurfacePrompt`
 * always runs now; registry layers, when present, ADD on top of it.
 */
export function applyPromptLayers(
  context: AgentRunContext,
  providerId: string,
  model: string,
  registry: PromptLayerRegistry | undefined
): AgentRunContext {
  const resolveContext: PromptLayerContext = {
    model,
    personaId: metadataString(context.input.metadata, "personaId"),
    promptTemplateId: metadataString(context.input.metadata, "promptTemplateId"),
    providerId
  };
  const layers: readonly PromptLayer[] = registry ? registry.resolve(resolveContext) : [];
  const systemPrompt = composeSurfacePrompt("chat", {}, { ...resolveContext, layers });

  return {
    ...context,
    input: {
      ...context.input,
      messages: appendSystemSection(context.input.messages, systemPrompt, "prompt-layers"),
      metadata: {
        ...context.input.metadata,
        ...(layers.length > 0 ? { promptLayerIds: layers.map((layer) => layer.id) } : {})
      }
    }
  };
}

/**
 * Inject the few-shot tool-exemplar section (`selectToolExemplars` →
 * `renderToolExemplarSection`) so a small local model imitates a proven tool
 * selection instead of reasoning from scratch — the delivery mechanism for
 * Programmatic Tool Calling, which a 12B never selects without an exemplar
 * (Phase 4: 0/2 → 4/4). Only fires when tools are actually exposed this turn;
 * the restraint cases in the bank keep IrrelAcc from degrading. Fail-open: a
 * bad bank / no lexical overlap / empty query ⇒ no section, never a throw.
 */
export function applyToolExemplars(
  context: AgentRunContext,
  bank: readonly ToolExemplar[] | undefined,
  exposedToolNames: readonly string[],
  topK: number
): AgentRunInput {
  if (!bank || bank.length === 0 || exposedToolNames.length === 0) {
    return context.input;
  }
  try {
    const query = latestUserPrompt(context.input.messages);
    if (!query) {
      return context.input;
    }
    const selected = selectToolExemplars(query, bank, topK);
    const rendered = renderToolExemplarSection(selected);
    if (!rendered) {
      return context.input;
    }
    return {
      ...context.input,
      messages: appendSystemSection(context.input.messages, rendered, "tool-exemplars"),
      metadata: {
        ...context.input.metadata,
        toolExemplarApplied: true,
        toolExemplarCount: selected.length
      }
    };
  } catch {
    return failedMetadata(context.input, "toolExemplarsFailed");
  }
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
