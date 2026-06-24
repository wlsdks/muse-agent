/**
 * CMP-2 production summarizer: turns a Muse `ModelProvider` into a
 * `DroppedContextSummarizer` the runtime can inject. It runs the SAME
 * local model the agent already uses (a second cheap call) over the
 * compacted-away turns to produce a short recap.
 *
 * Model-AGNOSTIC: it takes the Muse `ModelProvider` abstraction, never a
 * vendor SDK, so wiring it keeps agent-core vendor-neutral. It does NOT
 * catch errors — the fail-open contract lives in `summarizeDroppedContext`
 * (a throw there becomes the deterministic fallback), so a transient aux
 * failure degrades to the deterministic summary, never crashes the turn.
 */

import type { DroppedContextSummarizer } from "@muse/memory";
import type { ModelProvider } from "@muse/model";

const SUMMARIZER_SYSTEM_PROMPT =
  "You compress dropped conversation turns into a short factual recap that preserves names, decisions, and open questions. Output ONLY the recap — no preamble, no headings — in 2 to 4 sentences.";

export function createModelDroppedContextSummarizer(
  provider: ModelProvider,
  model: string
): DroppedContextSummarizer {
  return async (messages) => {
    const transcript = messages
      .map((message) => `${message.role}: ${typeof message.content === "string" ? message.content : ""}`)
      .join("\n");
    const response = await provider.generate({
      messages: [
        { content: SUMMARIZER_SYSTEM_PROMPT, role: "system" },
        { content: transcript, role: "user" }
      ],
      model,
      temperature: 0.2
    });
    return response.output;
  };
}
