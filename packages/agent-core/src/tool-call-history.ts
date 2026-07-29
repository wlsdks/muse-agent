import type {
  ModelMessage,
  ModelTool,
  ModelToolCall
} from "@muse/model";

export interface HistoricalToolCall {
  readonly mutating: boolean;
  readonly risk: ModelTool["risk"] | "unknown";
  readonly toolCall: ModelToolCall;
  readonly output?: string;
}

interface MutableHistoricalToolCall {
  readonly mutating: boolean;
  readonly risk: HistoricalToolCall["risk"];
  readonly toolCall: ModelToolCall;
  output?: string;
}

/**
 * Pairs historical assistant tool calls with their following tool results.
 * Ambiguous, reordered, reused-id, or name-mismatched pairs stay unresolved:
 * callers may then fail closed for fallback admission or seed reconcile state.
 */
export function classifyHistoricalToolCalls(
  messages: readonly ModelMessage[],
  tools: readonly ModelTool[] | undefined
): readonly HistoricalToolCall[] {
  const riskByName = new Map((tools ?? []).map((tool) => [tool.name, tool.risk]));
  const occurrences: MutableHistoricalToolCall[] = [];
  const pendingById = new Map<string, MutableHistoricalToolCall[]>();

  for (const message of messages) {
    if (message.role === "assistant" && message.toolCalls) {
      for (const toolCall of message.toolCalls) {
        const risk = riskByName.get(toolCall.name) ?? "unknown";
        const occurrence: MutableHistoricalToolCall = {
          mutating: risk === "write" || risk === "execute",
          risk,
          toolCall
        };
        occurrences.push(occurrence);
        const pending = pendingById.get(toolCall.id) ?? [];
        pending.push(occurrence);
        pendingById.set(toolCall.id, pending);
      }
      continue;
    }

    if (message.role !== "tool" || !message.toolCallId) continue;
    const pending = pendingById.get(message.toolCallId);
    // A result must follow exactly one call with the same id and, when named,
    // the same tool. Anything else cannot prove the effect completed.
    if (
      pending?.length !== 1
      || (message.name !== undefined && message.name !== pending[0]!.toolCall.name)
    ) {
      continue;
    }
    pending[0]!.output = message.content;
    pendingById.delete(message.toolCallId);
  }

  return occurrences;
}
