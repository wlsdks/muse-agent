import type { ModelMessage } from "@muse/model";

import type { AgentRunContext, AgentRunInput } from "./types.js";

/**
 * Conservative, high-precision detector for an under-specified
 * request: a contentless imperative with no object/referent ("do
 * it", "handle that", "just send it"). Deliberately narrow — a
 * false positive would make Muse needlessly ask "what do you
 * mean?" on a clear request, so anything with a real object/topic
 * is NOT flagged.
 */
// Trailing punctuation is `[.!]*` (zero or more periods / exclamation
// marks): `do it`, `do it.`, `do it!`, `do it!!`, `do it...` are all
// the same emphatic-contentless-imperative intent. Question mark `?`
// is intentionally NOT included — `do it?` is the user asking Muse
// to confirm, not commanding, so a clarify-directive is the wrong
// response.
const CONTENTLESS_IMPERATIVE =
  /^(?:please\s+)?(?:just\s+)?(?:do|handle|fix|finish|send|update|change|cancel|delete|remove|move|reschedule|sort|deal\s+with|take\s+care\s+of|make)\s+(?:it|that|this|them|those|the\s+thing)[.!]*$|^(?:go\s+ahead|just\s+do\s+it|make\s+it\s+happen|sort\s+it\s+out|take\s+care\s+of\s+it|handle\s+it|do\s+the\s+needful)[.!]*$/u;

export function detectUnderspecifiedRequest(text: string): { readonly ambiguous: boolean; readonly reason?: string } {
  const trimmed = text.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > 40) {
    return { ambiguous: false };
  }
  if (CONTENTLESS_IMPERATIVE.test(trimmed)) {
    return { ambiguous: true, reason: "action with no clear object or referent" };
  }
  return { ambiguous: false };
}

const CLARIFY_DIRECTIVE =
  "The user's request is under-specified — an action with no clear "
  + "object or referent. Do NOT guess or take an action. Ask ONE "
  + "concise clarifying question to resolve what they mean. If a "
  + "single intended action is strongly likely, offer it as a yes/no "
  + "(\"Shall I X?\") instead of doing it.";

/**
 * Context transform: when the latest user message is an
 * under-specified imperative AND there is no prior assistant turn
 * (a contentless "do it" after Muse proposed something is a
 * confirmation, not ambiguity), prepend a system directive steering
 * the agent to ask a clarifying question instead of hallucinating
 * an action. Otherwise the input is returned unchanged.
 */
export function applyClarifyDirective(context: AgentRunContext): AgentRunInput {
  const messages = context.input.messages;
  if (messages.some((message) => message.role === "assistant")) {
    return context.input;
  }
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  if (!lastUser || !detectUnderspecifiedRequest(lastUser.content).ambiguous) {
    return context.input;
  }
  const directive: ModelMessage = { content: CLARIFY_DIRECTIVE, role: "system" };
  return { ...context.input, messages: [directive, ...messages] };
}
