import { contentTokenSet, contentTokens } from "./provenance-tokens.js";
import type { TaintLedger } from "./taint-ledger.js";

export interface ActuatorProvenanceResult {
  untrustedDerived: boolean;
  taintedArgs: { name: string; sources: string[] }[];
  matchedSources: string[];
  /**
   * The CONFIDENTIALITY axis (FIDES arXiv:2505.23643): args carrying content that
   * came from the user's OWN stores — their notes, calendar, contacts — but NOT
   * from anything they typed this turn. An outbound send built from that content
   * is data LEAVING the box that the user never wrote into the message: the exfil
   * half of the provenance problem, and a different harm from an injection.
   */
  privateDerived: boolean;
  privateArgs: string[];
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
export function describeProvenanceExfil(result: ActuatorProvenanceResult): string {
  return `${result.privateArgs.map((name) => `\`${name}\``).join(", ")} carr${result.privateArgs.length === 1 ? "ies" : "y"} content from your own notes/records that you did not type in this message — confirm you want it to leave`;
}

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
  /**
   * When set, args are ALSO classified against the user's own first-party stores
   * (the confidentiality axis). Pass the ledger's `firstPartyHaystack()`.
   */
  privateHaystack?: string;
}): ActuatorProvenanceResult {
  const { args, ledger, trustedHaystack, sinkArgNames, privateHaystack } = input;
  const taintedArgs: { name: string; sources: string[] }[] = [];
  const matchedSources: string[] = [];
  const privateArgs: string[] = [];
  const names = sinkArgNames ?? Object.keys(args);
  for (const name of names) {
    const value = args[name];
    if (typeof value !== "string") {
      continue;
    }
    const result = argDerivesFromUntrusted(value, ledger, trustedHaystack);
    // Split the taint by ORIGIN. Every tool result is recorded untrusted, so a
    // send built from the user's OWN note used to read "traces to untrusted
    // tool:muse.notes.search" — a false injection alarm that trains the user to
    // click through the one warning that matters. An arg whose tokens appear ONLY
    // in first-party spans is not an injection risk; it is a CONFIDENTIALITY one,
    // and it is reported as such below. (If the note quotes a page fetched this
    // run, that page's own span still matches and the injection warning fires —
    // the strict posture for send/execute is preserved.)
    const thirdPartySources = result.sources.filter((source) => !isFirstPartyReadTool(source.replace(/^tool:/u, "")));
    if (result.tainted && thirdPartySources.length > 0) {
      taintedArgs.push({ name, sources: thirdPartySources });
      for (const source of thirdPartySources) {
        if (!matchedSources.includes(source)) {
          matchedSources.push(source);
        }
      }
    }
    // Confidentiality: the arg carries content from the user's own stores that
    // they did NOT type this turn. Reuses the same token-overlap primitive, with
    // the first-party corpus as the needle-source instead of the untrusted one.
    if (privateHaystack !== undefined && privateHaystack.trim().length > 0
      && argDerivesFromCorpus(value, privateHaystack, trustedHaystack)) {
      privateArgs.push(name);
    }
  }
  return {
    matchedSources,
    privateArgs,
    privateDerived: privateArgs.length > 0,
    taintedArgs,
    untrustedDerived: taintedArgs.length > 0
  };
}

/**
 * True when `value` carries content tokens that appear in `corpus` but NOT in
 * `trustedHaystack` (what the user themselves typed). Same shape as
 * `argDerivesFromUntrusted`, over an arbitrary corpus — used for the first-party
 * (private) classification.
 */
export function argDerivesFromCorpus(value: string, corpus: string, trustedHaystack: string): boolean {
  const valueTokens = contentTokens(value);
  if (valueTokens.length === 0) {
    return false;
  }
  const corpusTokens = contentTokenSet(corpus);
  const userTokens = contentTokenSet(trustedHaystack);
  return valueTokens.some((token) => corpusTokens.has(token) && !userTokens.has(token));
}

function ngramSet(tokens: readonly string[], size: number): Set<string> {
  const spans = new Set<string>();
  for (let index = 0; index + size <= tokens.length; index += 1) {
    spans.add(tokens.slice(index, index + size).join(" "));
  }
  return spans;
}

/**
 * Confidentiality signal for a NON-URL egress leaf (a header value, a form
 * field): true iff `leafValue` carries a run of >= `minSpan` CONSECUTIVE
 * content tokens that also appear as a consecutive span in the user's own
 * first-party corpus, and that SAME span is absent from what the user typed
 * this turn. Deliberately stronger than `argDerivesFromCorpus`'s
 * single-token `.some()` overlap: fire-1 shipped that check and it was rolled
 * back for rubber-stamping on any shared common word (a header's
 * "application/json" tripping on a note that happens to also contain the
 * word "json" anywhere). A 2-gram match is a real phrase, not incidental
 * vocabulary overlap, so it survives the rollback's lesson.
 *
 * Documented residuals (this is a WARN-only audit signal, not the security
 * boundary — the URL-egress deny + the send/execute single-token taint gate
 * are the actual defenses):
 * - A single opaque credential token (`sk-…`, no separators) is ONE token and
 *   can never form a 2-gram, so a lone secret in a header value is not flagged
 *   here (fire-4 redaction covers it in a URL; a lone secret in a non-URL leaf
 *   whose exact value is also in a same-run note is a niche this misses).
 * - `contentTokens` does not strip stopwords, so a common adjacent pair
 *   ("application json" from a Content-Type header + a chatty note) can still
 *   emit one spurious audit line. Cheapest hardening if it shows up: a
 *   stopword/entropy filter on the n-gram, NOT raising minSpan (which would
 *   weaken real-phrase detection).
 */
export function sharesPrivateSpan(
  leafValue: string,
  privateHaystack: string,
  trustedHaystack: string,
  minSpan = 2
): boolean {
  if (privateHaystack.trim().length === 0) {
    return false;
  }
  const leafTokens = contentTokens(leafValue);
  if (leafTokens.length < minSpan) {
    return false;
  }
  const leafSpans = ngramSet(leafTokens, minSpan);
  if (leafSpans.size === 0) {
    return false;
  }
  const privateSpans = ngramSet(contentTokens(privateHaystack), minSpan);
  const trustedSpans = ngramSet(contentTokens(trustedHaystack), minSpan);
  for (const span of leafSpans) {
    if (privateSpans.has(span) && !trustedSpans.has(span)) {
      return true;
    }
  }
  return false;
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
