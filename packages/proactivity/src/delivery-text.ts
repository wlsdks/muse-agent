import { escapeSystemPromptMarkers, neutralizeInjectionSpans } from "@muse/agent-core";

/** Neutralize untrusted prose only at a proactivity delivery boundary. */
export function neutralizeProactivityDeliveryText(text: string): string {
  return escapeSystemPromptMarkers(neutralizeInjectionSpans(text));
}
