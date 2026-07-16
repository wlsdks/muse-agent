/**
 * Concrete production wiring for `runDueObjectives`'s injected
 * `evaluate` / `act` / `escalate` seams (P9-b2), now evidence-gated
 * (roadmap D): the model no longer asserts `met` on its own say-so.
 *
 *  - `createModelObjectiveEvaluator` runs propose → resolve → check:
 *    the model PROPOSES which local store would evidence the
 *    objective (`objective-evidence.ts`'s closed `EvidenceStore`
 *    enum) plus the keywords/window/count that would prove it; code
 *    RESOLVES that query against the injected store readers; code
 *    CHECKS the resolved records deterministically. `met` is reachable
 *    ONLY through a non-empty resolved evidence set — never a bare
 *    model assertion. `{"store":"none"}` is the honest terminal for an
 *    objective no local store could ever evidence (never `met`).
 *    Conservative safe default throughout: anything unparseable ⇒
 *    `unmet` (retry next tick) — never crash, never a false `met`,
 *    never a false `unmeetable`.
 *  - `createMessagingObjectiveActuator` delivers the met /
 *    escalated notice over the messaging registry (zero-LLM,
 *    reuses the proven retry-send path), citing the resolved
 *    evidence in both the notice and the action-log entry.
 */

import type { MessagingProviderRegistry } from "@muse/messaging";

import { sendWithRetry } from "@muse/mcp-shared";
import { appendActionLog } from "@muse/stores";
import type { ObjectiveEvaluation } from "./objective-evaluation-loop.js";
import type { StandingObjective } from "@muse/stores";
import { proposeMessageAction } from "@muse/stores";
import type { ProactiveModelProviderLike } from "./proactive-notice-loop.js";
import {
  checkObjectiveMet,
  resolveObjectiveEvidence,
  type EvidenceQuery,
  type EvidenceRecord,
  type EvidenceStore,
  type ObjectiveEvidenceDeps
} from "./objective-evidence.js";

const EVIDENCE_STORES: readonly EvidenceStore[] = ["actionLog", "calendar", "notes", "reminders", "tasks"];

const PROPOSAL_SYSTEM_PROMPT =
  `You decide HOW to check whether a standing objective is currently `
  + `satisfied — using only Muse's own local stores as evidence, never `
  + `your own belief. Given the objective text and the current time, `
  + `respond with ONE JSON object and nothing else.\n\n`
  + `When a local store COULD evidence it:\n`
  + `{"store":"tasks"|"reminders"|"calendar"|"notes"|"actionLog","keywords":["..."],"windowDays":N,"expectedCount":N}\n`
  + `- keywords: the concrete words to look for (required, at least one).\n`
  + `- windowDays: how many days back (optional; omit for unbounded).\n`
  + `- expectedCount: how many matching records prove it (optional; omit for "at least one").\n\n`
  + `{"store":"none"} — the DEFAULT for anything outside Muse's own local `
  + `data: the news, the weather, a sports score, a space mission, someone `
  + `else's mood. Use this even when the event is real and WILL eventually `
  + `happen — Muse just has no local record to confirm it with, so it stays `
  + `unmet forever rather than guessing.\n\n`
  + `{"store":"none","unmeetable":true,"reason":"<short reason>"} — ONLY `
  + `when the OBJECTIVE ITSELF is now impossible, not merely hard to `
  + `observe: the repo/task it depended on was deleted, the meeting was `
  + `cancelled, the person left. Never use this just because Muse can't `
  + `watch for something locally — that is plain {"store":"none"}.\n\n`
  + `Examples:\n`
  + `objective: "log the workout 3 times this week"\n`
  + `{"store":"tasks","keywords":["workout"],"windowDays":7,"expectedCount":3}\n`
  + `objective: "remind me to call mom"\n`
  + `{"store":"reminders","keywords":["call","mom"]}\n`
  + `objective: "tell me when the team standup happens"\n`
  + `{"store":"calendar","keywords":["standup"],"windowDays":7}\n`
  + `objective: "let me know the moment a crewed mission lands on the moon again"\n`
  + `{"store":"none"}\n`
  + `objective: "watch the acme-widgets repo until it's archived"\n`
  + `{"store":"none","unmeetable":true,"reason":"the acme-widgets repo no longer exists"}\n\n`
  + `No prose, no markdown, JSON only.`;

export interface ModelObjectiveEvaluatorOptions {
  readonly modelProvider: ProactiveModelProviderLike;
  readonly model: string;
  /** Injected store readers the resolved evidence query fetches from. */
  readonly evidenceDeps?: ObjectiveEvidenceDeps;
  readonly now?: () => Date;
}

export function createModelObjectiveEvaluator(
  options: ModelObjectiveEvaluatorOptions
): (objective: StandingObjective) => Promise<ObjectiveEvaluation> {
  const now = options.now ?? (() => new Date());
  const evidenceDeps = options.evidenceDeps ?? {};
  return async (objective) => {
    let output: string;
    try {
      const result = await options.modelProvider.generate({
        maxOutputTokens: 200,
        messages: [
          { content: PROPOSAL_SYSTEM_PROMPT, role: "system" },
          {
            content:
              `objective (${objective.kind}): ${objective.spec}\n`
              + `now: ${now().toISOString()}`,
            role: "user"
          }
        ],
        model: options.model,
        temperature: 0
      });
      output = result.output;
    } catch {
      // A model/transport error must not crash the tick — defer.
      return { outcome: "unmet" };
    }
    const proposal = parseObjectiveProposal(output);
    if (proposal.store === "none") {
      if (proposal.unmeetable) {
        return { outcome: "unmeetable", reason: proposal.reason };
      }
      return { outcome: "unmet" };
    }
    const query: EvidenceQuery = {
      keywords: proposal.keywords,
      store: proposal.store,
      ...(proposal.windowDays !== undefined ? { windowDays: proposal.windowDays } : {}),
      ...(proposal.expectedCount !== undefined ? { expectedCount: proposal.expectedCount } : {})
    };
    const records = await resolveObjectiveEvidence(query, evidenceDeps);
    const { evidence, met } = checkObjectiveMet(records, query);
    return met ? { evidence, outcome: "met" } : { outcome: "unmet" };
  };
}

/**
 * Collect every balanced top-level `{…}` span. A balanced scan
 * (not a greedy regex) so `<think>{…}</think> {"outcome":"met"}`
 * yields TWO candidates instead of one over-wide invalid span.
 * String-aware so a `}` inside a JSON string value doesn't close
 * the object early.
 */
function balancedJsonCandidates(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j += 1) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          out.push(text.slice(i, j + 1));
          // Skip the consumed span so a NESTED object is NOT re-extracted as its
          // own candidate — otherwise `{"plan":{"store":"tasks"},"note":"not yet"}`
          // leaks an inner proposal and parseObjectiveProposal resolves a store the
          // model didn't actually mean at the top level. Only TOP-LEVEL objects are
          // proposal candidates; a nested-only shape is ambiguous ⇒ store:"none".
          i = j;
          break;
        }
      }
    }
  }
  return out;
}

/**
 * Provider-agnostic, unattended-safe proposal parse. The objectives
 * daemon runs autonomously across 7 model families, so the proposal
 * can arrive fenced (```json…```), reasoning-wrapped
 * (`<think>…</think>`), or with prose either side. Strip the
 * wrappers, scan ALL balanced JSON objects, and take the LAST one
 * that parses into a recognised shape — a model that "thinks" then
 * answers puts the real proposal last. Anything ambiguous ⇒ the
 * conservative `{"store":"none"}` safe default (never crash, never a
 * false `met`, never a false `unmeetable`).
 */
// Replace each complete <think>…</think> block with a space. A global lazy
// regex (`/<think>[\s\S]*?<\/think>/g`) is O(n²) on input with many unclosed
// `<think>` tags — each open triggers a full forward scan that never finds a
// close — which a repetition-degenerate model can produce. This single linear
// pass preserves the regex's behaviour (case-insensitive, unclosed open keeps
// the rest verbatim, non-overlapping pairs).
function stripThinkBlocks(text: string): string {
  const lower = text.toLowerCase();
  let result = "";
  let index = 0;
  for (;;) {
    const open = lower.indexOf("<think>", index);
    if (open < 0) {
      return result + text.slice(index);
    }
    const close = lower.indexOf("</think>", open + "<think>".length);
    if (close < 0) {
      return result + text.slice(index);
    }
    result += `${text.slice(index, open)} `;
    index = close + "</think>".length;
  }
}

export type ObjectiveProposal =
  | { readonly store: "none"; readonly unmeetable?: false }
  | { readonly store: "none"; readonly unmeetable: true; readonly reason: string }
  | {
      readonly store: EvidenceStore;
      readonly keywords: readonly string[];
      readonly windowDays?: number;
      readonly expectedCount?: number;
    };

interface RawProposalShape {
  readonly store?: unknown;
  readonly keywords?: unknown;
  readonly windowDays?: unknown;
  readonly expectedCount?: unknown;
  readonly unmeetable?: unknown;
  readonly reason?: unknown;
}

export function parseObjectiveProposal(raw: string): ObjectiveProposal {
  const cleaned = stripThinkBlocks(raw)
    .replace(/```[a-zA-Z]*\n?|```/gu, " ");
  let proposal: ObjectiveProposal = { store: "none" };
  for (const candidate of balancedJsonCandidates(cleaned)) {
    let parsed: RawProposalShape;
    try {
      parsed = JSON.parse(candidate) as RawProposalShape;
    } catch {
      continue;
    }
    if (parsed.store === "none") {
      if (parsed.unmeetable === true) {
        const reason = typeof parsed.reason === "string" && parsed.reason.trim().length > 0
          ? parsed.reason.trim()
          : "model deemed the objective unmeetable";
        proposal = { reason, store: "none", unmeetable: true };
      } else {
        proposal = { store: "none" };
      }
      continue;
    }
    if (
      typeof parsed.store === "string"
      && (EVIDENCE_STORES as readonly string[]).includes(parsed.store)
      && Array.isArray(parsed.keywords)
      && parsed.keywords.every((k): k is string => typeof k === "string")
    ) {
      const keywords = parsed.keywords.map((k) => k.trim()).filter((k) => k.length > 0);
      // No usable keyword ⇒ not a recognised proposal (a store query
      // needs something to look for) — skip, keep the prior candidate.
      if (keywords.length === 0) continue;
      const windowDays = typeof parsed.windowDays === "number" && Number.isSafeInteger(parsed.windowDays) && parsed.windowDays >= 0
        ? parsed.windowDays
        : undefined;
      const expectedCount = typeof parsed.expectedCount === "number" && Number.isSafeInteger(parsed.expectedCount) && parsed.expectedCount > 0
        ? parsed.expectedCount
        : undefined;
      proposal = {
        keywords,
        store: parsed.store as EvidenceStore,
        ...(windowDays !== undefined ? { windowDays } : {}),
        ...(expectedCount !== undefined ? { expectedCount } : {})
      };
    }
  }
  return proposal;
}

export interface MessagingObjectiveActuatorOptions {
  readonly registry: MessagingProviderRegistry;
  readonly providerId: string;
  readonly destination: string;
  /**
   * When set, every autonomous objective action the daemon takes
   * is also appended here so it is reviewable (P6 accountability:
   * "every autonomous action produces a rationale-bearing log
   * entry"). Best-effort relative to the just-delivered action — a
   * log-append failure must never crash the daemon, so it is
   * swallowed; the notification itself already succeeded.
   */
  readonly actionLogFile?: string;
  readonly now?: () => Date;
}

/**
 * Render up to 3 resolved evidence records as a compact citation
 * suffix — "" when there is no evidence (an escalate, or an actuator
 * invoked directly without evidence) so the met notice's wording is
 * unchanged in that case.
 */
function evidenceCitation(evidence: readonly EvidenceRecord[]): string {
  if (evidence.length === 0) return "";
  const cited = evidence
    .slice(0, 3)
    .map((e) => `${e.source} (${e.whenIso ?? "no timestamp"})`)
    .join(", ");
  return ` — evidence: ${cited}`;
}

export function createMessagingObjectiveActuator(options: MessagingObjectiveActuatorOptions): {
  readonly act: (objective: StandingObjective, evidence?: readonly EvidenceRecord[]) => Promise<void>;
  readonly escalate: (objective: StandingObjective, reason: string) => Promise<void>;
} {
  const now = options.now ?? (() => new Date());
  const send = async (text: string): Promise<void> => {
    await sendWithRetry(options.registry, options.providerId, { destination: options.destination, text });
  };
  const record = async (
    objective: StandingObjective,
    what: string,
    detail: string
  ): Promise<void> => {
    if (!options.actionLogFile) {
      return;
    }
    const whenIso = now().toISOString();
    try {
      await appendActionLog(options.actionLogFile, {
        detail,
        id: `act_${objective.id}_${Date.parse(whenIso).toString()}`,
        objectiveId: objective.id,
        result: "performed",
        userId: objective.userId,
        what,
        when: whenIso,
        why: objective.spec
      });
    } catch {
      // accountability is best-effort vs. the delivered action;
      // never crash the unattended daemon over a log write.
    }
  };
  return {
    act: async (objective, evidence = []) => {
      const citation = evidenceCitation(evidence);
      await send(`✅ Objective met: ${objective.spec}${citation}`);
      await record(objective, "objective met — user notified", `messaging notice delivered${citation}`);
    },
    escalate: async (objective, reason) => {
      await send(`⚠ Objective needs you: ${objective.spec} — ${reason}`);
      await record(objective, "objective escalated — user notified", reason);
    }
  };
}

/**
 * Draft-first objective actuator (outbound-safety): instead of sending
 * the "objective met" / escalation message itself, it PROPOSES the
 * message — persisting a pending proposed action the user confirms via
 * `muse propose approve`. Nothing leaves the machine on the daemon's
 * own judgement. Use this when an objective's notification should be
 * reviewed before it goes out (e.g. to a third party).
 */
export function createProposingObjectiveActuator(options: {
  readonly proposedActionsFile: string;
  readonly providerId: string;
  readonly destination: string;
}): {
  readonly act: (objective: StandingObjective) => Promise<void>;
  readonly escalate: (objective: StandingObjective, reason: string) => Promise<void>;
} {
  return {
    act: async (objective) => {
      await proposeMessageAction(options.proposedActionsFile, {
        destination: options.destination,
        providerId: options.providerId,
        reason: `standing objective ${objective.id} met`,
        summary: `Objective met: ${objective.spec}`,
        text: `✅ Objective met: ${objective.spec}`,
        userId: objective.userId
      });
    },
    escalate: async (objective, reason) => {
      await proposeMessageAction(options.proposedActionsFile, {
        destination: options.destination,
        providerId: options.providerId,
        reason,
        summary: `Objective needs you: ${objective.spec}`,
        text: `⚠ Objective needs you: ${objective.spec} — ${reason}`,
        userId: objective.userId
      });
    }
  };
}
