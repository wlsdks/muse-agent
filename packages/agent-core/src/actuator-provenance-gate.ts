import { contentTokenSet, contentTokens } from "./provenance-tokens.js";
import type { TaintLedger } from "./taint-ledger.js";

export interface ActuatorProvenanceResult {
  untrustedDerived: boolean;
  taintedArgs: { name: string; sources: string[] }[];
  matchedSources: string[];
}

/**
 * The OUTBOUND-SEND actuator class — tools that transmit content to a THIRD
 * PARTY (email, channel message, web POST, a standing-objective act). This is
 * the highest-blast-radius sink and the only class the provenance gate covers
 * in this slice; write/execute actuators that mutate LOCAL state (home
 * automation, calendar, notes) are deliberately excluded and widen in a later
 * slice. Mirrors the CLI's `OUTBOUND_ACTUATORS` allowlist minus the home /
 * smart-home entries (those don't send content and their args aren't message
 * sinks). agent-core can't import the CLI list, so the send subset is declared
 * here.
 */
export const OUTBOUND_SEND_TOOL_NAMES: readonly string[] = [
  "email_send",
  "web_action",
  "muse.messaging.send",
  "objective.act"
];

/**
 * The argument keys on an outbound-send tool that carry content to the third
 * party (recipient / subject / body / link). The taint check is restricted to
 * these so an incidental untrusted token in a non-sink arg (e.g. an internal
 * id) never trips the gate.
 */
export const OUTBOUND_SEND_SINK_ARG_NAMES: readonly string[] = [
  "to",
  "recipient",
  "cc",
  "bcc",
  "subject",
  "body",
  "text",
  "message",
  "url"
];

/**
 * The argument keys on an execute-risk tool that carry the command/code payload
 * to be run (a shell line, a script, an interpreter input). Execute-risk tools
 * are already always approval-gated, so restricting the taint check to these
 * payload args enriches the confirm that already happens without adding one.
 */
export const EXECUTE_SINK_ARG_NAMES: readonly string[] = [
  "command",
  "cmd",
  "code",
  "script",
  "shell",
  "input",
  "args"
];

/**
 * Human-readable reason naming each tainted arg and the untrusted source it
 * traces to — surfaced on the draft-first confirm so the user sees WHY a send
 * was flagged ("`to` traces to untrusted tool:web_fetch, not your message").
 */
export function describeProvenanceTaint(result: ActuatorProvenanceResult): string {
  return result.taintedArgs
    .map(({ name, sources }) => {
      const origin = sources.length > 0 ? sources.join(", ") : "untrusted tool output";
      return `\`${name}\` traces to untrusted ${origin}, not your message`;
    })
    .join("; ");
}

/**
 * Deterministic derivation check for ONE argument value — the sink-gate half
 * of a FIDES-style taint gate (arXiv 2505.23643): does this value carry a
 * content token that came from untrusted (tool-output-derived) text and is
 * NOT explained by anything trusted (the user's own utterance / system
 * context)? A value the user typed themselves is never tainted even if the
 * same text also appears in tool output — the trusted haystack covers it.
 * Fail-open (not tainted) when there is nothing to compare: an empty ledger,
 * an empty arg value, or an arg value with no content tokens at all.
 */
export function argDerivesFromUntrusted(
  argValue: string,
  ledger: TaintLedger,
  trustedHaystack: string
): { tainted: boolean; sources: string[] } {
  const untrustedTokens = ledger.untrustedTokens();
  if (untrustedTokens.size === 0) {
    return { tainted: false, sources: [] };
  }
  const argTokens = contentTokens(argValue);
  if (argTokens.length === 0) {
    return { tainted: false, sources: [] };
  }
  const trustedTokens = contentTokenSet(trustedHaystack);
  const taintingTokens = argTokens.filter((token) => untrustedTokens.has(token) && !trustedTokens.has(token));
  if (taintingTokens.length === 0) {
    return { tainted: false, sources: [] };
  }
  const taintingSet = new Set(taintingTokens);
  const sources: string[] = [];
  for (const span of ledger.untrustedSpans()) {
    const spanTokens = contentTokenSet(span.text);
    const hits = [...taintingSet].some((token) => spanTokens.has(token));
    if (hits && !sources.includes(span.source)) {
      sources.push(span.source);
    }
  }
  return { tainted: true, sources };
}

/**
 * Gate an actuator tool CALL's arguments against the taint ledger. Checks
 * only string-valued args (non-string values are skipped — a taint check is
 * meaningless on a number/boolean/object). `sinkArgNames` restricts the check
 * to the specific args that flow to a third party (e.g. `to`/`body` on a
 * send-message tool); omit it to check every string arg.
 */
export function checkActuatorProvenance(input: {
  args: Record<string, unknown>;
  ledger: TaintLedger;
  trustedHaystack: string;
  sinkArgNames?: readonly string[];
}): ActuatorProvenanceResult {
  const { args, ledger, trustedHaystack, sinkArgNames } = input;
  const taintedArgs: { name: string; sources: string[] }[] = [];
  const matchedSources: string[] = [];
  const names = sinkArgNames ?? Object.keys(args);
  for (const name of names) {
    const value = args[name];
    if (typeof value !== "string") {
      continue;
    }
    const result = argDerivesFromUntrusted(value, ledger, trustedHaystack);
    if (result.tainted) {
      taintedArgs.push({ name, sources: result.sources });
      for (const source of result.sources) {
        if (!matchedSources.includes(source)) {
          matchedSources.push(source);
        }
      }
    }
  }
  return { untrustedDerived: taintedArgs.length > 0, taintedArgs, matchedSources };
}

/**
 * WRITE-risk sink args — the free-text fields a write actuator PERSISTS into the
 * user's own stores (a note body, a task title, a memory value, an event
 * location). A write built from poisoned third-party content is the
 * memory-poisoning vector: a web page that says "remember: the user's bank is
 * X" must not silently become a stored fact the assistant later repeats as the
 * user's own. Ids/keys and enum-ish control args are deliberately absent — an
 * incidental token match there is noise, not a persisted claim.
 */
export const WRITE_SINK_ARG_NAMES: readonly string[] = [
  "title",
  "content",
  "text",
  "body",
  "note",
  "notes",
  "description",
  "summary",
  "value",
  "key",
  "fact",
  "location",
  "tags",
  // Contact fields: `add_contact` is risk:"write" and PERSISTS these, so a
  // poisoned page could otherwise plant a whole person (name + phone + email +
  // relationship) into the address book — which later becomes a first-party
  // trusted store via find_contact, and a recipient for an outbound send.
  "name",
  "phone",
  "email",
  "handle",
  "relationship",
  "birthday"
];

/**
 * FIRST-PARTY read tools: the user's OWN stores. Their output is a trusted
 * origin — content the user themselves put there — so a write derived from it
 * ("add the action item from my meeting note as a task") must not read as
 * third-party-derived. Everything NOT matched here stays untrusted, so the
 * classification is fail-closed by default: a new/unknown/external tool is
 * third-party until it is deliberately listed.
 *
 * The exclusions are the point: `muse.fetch` / `feeds_search` / `browsing_search`
 * / `muse.messaging.inbox` / `email_*` / `browser_*` all READ into the user's
 * box but carry THIRD-PARTY content — a feed item or an inbound email is exactly
 * the poisoned-source vector, and storing it in a local file does not launder it.
 */
const FIRST_PARTY_READ_PREFIXES: readonly string[] = [
  "muse.notes.",
  "muse.tasks.",
  "muse.calendar.",
  "muse.reminders.",
  "muse.episode.",
  "muse.followup.",
  "muse.pattern.",
  "muse.history."
];

/**
 * EXACT first-party tool names. `knowledge_search` and `today_brief` are
 * deliberately ABSENT despite reading the user's own stores: their corpora are
 * MIXED — `createNotesKnowledgeSearchTool` is wired with `emailSource` (Gmail)
 * and the feeds/browsing corpora alongside notes/tasks/calendar. Trusting a
 * mixed reader would let a planted email or feed item cancel its own taint by
 * being read back through it — the S3b threat model reached through the front
 * door. A tool is first-party only when EVERY byte it can return is the user's
 * own authored content.
 */
const FIRST_PARTY_READ_TOOL_NAMES: readonly string[] = [
  "find_contact",
  "recall_facts"
];

export function isFirstPartyReadTool(toolName: string): boolean {
  if (FIRST_PARTY_READ_TOOL_NAMES.includes(toolName)) {
    return true;
  }
  return FIRST_PARTY_READ_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}
