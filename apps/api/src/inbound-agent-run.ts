import { randomBytes } from "node:crypto";

import {
  casualResponseFor,
  classifyCasualPrompt,
  classifyChannelIntent,
  classifyMetaPrompt,
  containsHangul,
  extractFollowupPromises,
  guardAgainstUnbackedActionClaim,
  sanitizeFollowupSummary
} from "@muse/agent-core";
import {
  parseBoolean,
  resolveActionLogFile,
  resolveFollowupsFile,
  resolveLastProactiveDeliveryFile,
  resolvePendingApprovalsFile,
  type MuseEnvironment
} from "@muse/autoconfigure";
import type { UserMemoryStore } from "@muse/memory";
import { createToolExposureAuthority, type ToolExposureAuthority } from "@muse/policy";
import {
  createChannelApprovalGate,
  effectiveScope,
  type ChannelApprovalGate,
  type MessagingProviderRegistry,
  type ThreadedAgentRun,
  type ThreadTurn
} from "@muse/messaging";
import { describeCapabilities } from "@muse/prompts";
import { gateChatAnswerGrounding } from "@muse/recall";
import { readFollowups, upsertFollowup, type PersistedFollowup } from "@muse/stores";

import {
  adoptChannelOwner,
  extractPairingCodeCandidate,
  parseAllowedChats,
  readChannelOwner,
  resolveChannelOwnersFile,
  resolveChannelPairingCodesFile,
  verifyPairingCodeAttempt
} from "./channel-owner-store.js";
import { createChannelPendingRecorder } from "./channel-pending-recorder.js";
import { CHANNEL_APPROVAL_EXPOSURE_ALLOWLIST } from "./chat-write-allowlist.js";
import { createChannelRefusalRecorder } from "./channel-refusal-recorder.js";
import { loadChatPersonaSnapshot } from "./chat-persona-snapshot.js";
import { handleInboundApprovalReply } from "./inbound-approval-handler.js";
import { handleInboundVetoReply } from "./inbound-veto-handler.js";
import { detectUnscheduledRememberIntent } from "./remember-intent.js";
import { resolveProactiveTrustFile } from "./tick-daemons.js";

/**
 * Structural slice of AgentRuntime.run — `apps/api` wires the real runtime in;
 * tests substitute a fake without pulling agent-core's full input type.
 */
interface InboundAgentRuntime {
  run(input: {
    readonly messages: readonly ThreadTurn[];
    readonly metadata: { readonly userId: string };
    readonly model: string;
    readonly toolApprovalGate: ChannelApprovalGate;
    readonly toolExposureAuthority: ToolExposureAuthority;
  }): Promise<{
    readonly response?: { readonly output?: string };
    readonly groundingSources?: readonly { readonly source: string; readonly text: string }[];
    readonly toolsUsed?: readonly string[];
  }>;
}

export interface InboundAgentRunOptions {
  readonly agentRuntime: InboundAgentRuntime;
  readonly env: MuseEnvironment;
  readonly model: string;
  readonly registry: MessagingProviderRegistry;
  /**
   * Delegation-ack composer (S2, `MUSE_CHANNEL_ACK`). Optional — a caller
   * that omits it simply never sends an ack, same as the flag being off.
   */
  readonly composeAck?: (input: { readonly latestUserText: string }) => Promise<string | null>;
  /**
   * Conversational fast-path composer (S3, `MUSE_CHANNEL_CHAT`). Answers a
   * message `classifyChannelIntent` reads as pure smalltalk with ONE
   * single-inference reply instead of the full agent run. Optional — a
   * caller that omits it simply never takes the fast path, same as the flag
   * being off. Fail-open: a `null` return (or a throw) falls through to the
   * normal ack + full-run path, which is the safety net.
   */
  readonly composeChatReply?: (input: {
    readonly latestUserText: string;
    readonly thread: readonly ThreadTurn[];
    readonly personaSnapshot?: readonly { readonly source: string; readonly text: string }[];
  }) => Promise<string | null>;
  /**
   * Backs the chat fast-path's "knows-you" snapshot (`loadChatPersonaSnapshot`).
   * Optional — a caller that omits it simply never personalizes the fast path
   * (the branch behaves exactly as before: no snapshot, empty evidence).
   */
  readonly userMemoryStore?: UserMemoryStore;
}

/**
 * The channel conversational turn: answer a not-yet-handled inbound message by
 * running the full agent and returning the reply for the originating channel.
 * Extracted from `buildServer` so the production path itself is testable.
 *
 * Two gates guard the turn:
 *  - `createChannelApprovalGate` fail-closes risky tools (draft-first,
 *    outbound-safety.md) and records the refusal for `muse approvals`.
 *  - `gateChatAnswerGrounding` applies the SAME deterministic grounding +
 *    citation gate as the API /chat surface, so a fabricated citation is
 *    dropped by code before the reply leaves for the channel.
 */
const UNPAIRED_CHAT_NOTICE =
  "This bot is a private personal assistant and only talks to its paired owner.";

// Pairing-code gate (replaces TOFU adoption): until an owner is paired, NO
// sender is told whether they sent no code / the wrong code / a locked-out
// code — a single generic notice avoids handing an attacker a brute-force
// oracle over which state they're in.
const PAIRING_CODE_REQUIRED_NOTICE =
  "This bot is a private personal assistant. To link this chat, send the one-time pairing code shown in the Muse web console (Integrations) or printed by `muse messaging pairing-code <provider>`.";
const PAIRING_CODE_SUCCESS_NOTICE =
  "This chat is now paired as the owner — talk to Muse normally from here.";

export { CHANNEL_APPROVAL_EXPOSURE_ALLOWLIST };

// False-done backstop (the guard layer, not the parser): when the user asked
// Muse to remember something date-shaped this turn and NO followup actually
// got persisted, the model's reply can still confidently promise ("기억해둘게,
// 미리 알려줄게") — a false-done. This caveat is CODE-appended, never model
// text, so it can never be dropped by a bad generation.
const REMEMBER_CAVEAT_KO =
  "라고 했지만, 지금 이 형식의 날짜 알림은 예약이 안 됐어 — '8월 5일 아침에 알려줘'처럼 다시 말해줘!";
const REMEMBER_CAVEAT_EN =
  "— but a reminder for that wasn't actually scheduled in this format. Try phrasing it like 'remind me on August 5th morning'!";

function appendUnscheduledRememberCaveat(output: string, latestUserText: string): string {
  const caveat = containsHangul(latestUserText) ? REMEMBER_CAVEAT_KO : REMEMBER_CAVEAT_EN;
  return output.length === 0 ? caveat : `${output}\n\n${caveat}`;
}

/**
 * FIX N1 confirmation echo — CODE-appended (never model text) proof that a
 * followup actually got scheduled from the USER's own ask, so it can't be
 * faked by a model that happens to echo a date back. The date it names comes
 * straight from the PERSISTED followup's resolved `scheduledFor`, never from
 * the model's reply.
 */
function formatScheduledConfirmationDate(date: Date, hangul: boolean): string {
  return hangul
    ? `${date.getMonth() + 1}월 ${date.getDate()}일`
    : date.toLocaleDateString("en-US", { day: "numeric", month: "short" });
}

function appendScheduledConfirmation(output: string, scheduledFor: Date, latestUserText: string): string {
  const hangul = containsHangul(latestUserText);
  const label = formatScheduledConfirmationDate(scheduledFor, hangul);
  const confirmation = hangul ? `📌 ${label} 알림 잡아뒀어!` : `📌 Reminder set for ${label}!`;
  return output.length === 0 ? confirmation : `${output}\n\n${confirmation}`;
}

function userSideFollowupId(): string {
  return `fu_u_${randomBytes(7).toString("hex")}`;
}

// A minute-granularity match: the rule detector resolves to whole-minute
// precision (setHours(h, m, 0, 0)) and both the user-side extraction below
// and the runtime's own followup-capture-hook (scanning the ASSISTANT's
// echo) resolve the SAME calendar expression to the same instant, so an
// exact-minute match is proof they're the same commitment, not a coincidence.
function sameScheduledMinute(a: Date, b: Date): boolean {
  return Math.abs(a.getTime() - b.getTime()) < 60_000;
}

/**
 * "Did this turn actually schedule a followup?" — observed the least invasive
 * way reachable from apps/api: the runtime hook that captures a self-followup
 * promise (`packages/agent-core`'s `followup-capture-hook.ts`) lives inside
 * `agentRuntime.run()`, which is an opaque dependency here (built + wired in
 * `packages/autoconfigure`, out of this worker's scope) — its `afterComplete`
 * hook is `await`ed before `run()` resolves, so by the time this returns, any
 * followup persisted THIS turn is already on disk. Rather than widen
 * `InboundAgentRuntime`'s return type (which every fake in every existing
 * test would then need to grow), this compares the SAME user's
 * `readFollowups` "scheduled" count immediately before vs. after the call —
 * a strictly-increased count is proof a followup was captured this turn.
 * Read-only (never creates the file) and userId-scoped, so it costs nothing
 * on a machine with no followups store yet and never confuses one user's
 * turn with another's.
 */
async function readScheduledFollowupsFor(followupsFile: string, userId: string): Promise<readonly PersistedFollowup[]> {
  const followups = await readFollowups(followupsFile).catch(() => []);
  return followups.filter((followup) => followup.userId === userId && followup.status === "scheduled");
}

async function countScheduledFollowups(followupsFile: string, userId: string): Promise<number> {
  return (await readScheduledFollowupsFor(followupsFile, userId)).length;
}

/**
 * FIX N1 — deterministic USER-side scheduling: the assistant's own text
 * echoing a commissive promise is a coin-flip (the runtime's
 * followup-capture-hook only scans `response.output`), so this extracts
 * straight from the USER's ask and persists it through the SAME store the
 * hook uses (`upsertFollowup`) — scheduling no longer depends on the model
 * happening to restate the date back.
 *
 * Order/dedup: called AFTER `agentRuntime.run()` (so the runtime's own
 * capture hook — if it also fired off a commissive assistant echo THIS turn
 * — has already persisted its entry). `upsertFollowup` only dedupes by
 * `id` (random per call), and the hook's own within-call dedup never sees
 * across-call state, so scheduling user-side FIRST would NOT have been
 * deduped by the hook — this reads the post-run store and skips creating a
 * duplicate itself whenever an existing scheduled entry already lands on
 * the same resolved minute.
 *
 * Returns the resolved time of the first user-side promise found (whether
 * freshly persisted here or already covered by the runtime's own capture)
 * so the caller can build a confirmation echo — `undefined` when the raw
 * user text carries no date the rule detector can resolve.
 */
async function scheduleUserSideFollowups(
  followupsFile: string,
  userId: string,
  latestUserText: string,
  now: Date
): Promise<Date | undefined> {
  const promises = extractFollowupPromises(latestUserText, { now, requireCommissive: false });
  if (promises.length === 0) {
    return undefined;
  }
  const alreadyScheduled = await readScheduledFollowupsFor(followupsFile, userId);
  let firstScheduled: Date | undefined;
  for (const promise of promises) {
    if (firstScheduled === undefined) {
      firstScheduled = promise.scheduledFor;
    }
    const duplicate = alreadyScheduled.some((existing) =>
      sameScheduledMinute(new Date(existing.scheduledFor), promise.scheduledFor));
    if (duplicate) {
      continue;
    }
    const followup: PersistedFollowup = {
      createdAt: now.toISOString(),
      id: userSideFollowupId(),
      kind: promise.kind,
      scheduledFor: promise.scheduledFor.toISOString(),
      status: "scheduled",
      summary: sanitizeFollowupSummary(promise.originalText),
      userId
    };
    // Fail-open per promise (parity with the runtime capture hook) — one
    // bad write must not block the rest, or fail the turn.
    await upsertFollowup(followupsFile, followup).catch(() => undefined);
  }
  return firstScheduled;
}

export function createInboundAgentRun(options: InboundAgentRunOptions): ThreadedAgentRun {
  const { agentRuntime, composeAck, composeChatReply, env, model, registry, userMemoryStore } = options;
  return async ({ messages, providerId, source, scope: rawScope, notify }) => {
    // Conversation-scope capability profile (P7-3, the sequel to TOFU
    // pairing): a group/shared chat gets a STRICTLY narrower posture than
    // a 1:1 — never TOFU-adopted as owner, never the owner's memory scope,
    // never a risky-tool approval round-trip a random group member could
    // "yes". `effectiveScope` fails closed — absent/unknown scope is
    // "shared", never silently the safer-looking "direct".
    const scope = effectiveScope(rawScope);
    const ownersFile = resolveChannelOwnersFile(env);
    const latestUserText = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
    if (scope === "shared") {
      // NEVER adopt a group/channel chat as owner — that would let the
      // first random group message claim ownership of the agent. A
      // pairing code (below) is a 1:1-only concept and never applies here.
      const groupAllowed = parseBoolean(env.MUSE_CHANNEL_GROUP_ENABLED, false)
        && parseAllowedChats(env.MUSE_CHANNEL_ALLOWED_CHATS).has(`${providerId}:${source}`);
      if (!groupAllowed) {
        return UNPAIRED_CHAT_NOTICE;
      }
    } else {
      // Pairing gate — a public bot handle is discoverable by anyone, so an
      // un-paired 1:1 chat is refused deterministically before any approval
      // handling or agent turn can touch personal state. An ALREADY-paired
      // owner (an existing owners-file entry, from before this gate existed
      // or from a prior pairing) is preserved unchanged and never asked to
      // re-pair — the code gate applies ONLY to the first-ever adoption.
      const existingOwner = await readChannelOwner(ownersFile, providerId);
      if (existingOwner) {
        if (source !== existingOwner && !parseAllowedChats(env.MUSE_CHANNEL_ALLOWED_CHATS).has(`${providerId}:${source}`)) {
          return UNPAIRED_CHAT_NOTICE;
        }
      } else {
        // No owner yet — adoption requires a valid one-time pairing code the
        // owner reads out-of-band (web console / `muse messaging
        // pairing-code`), never auto-adopted from whoever messages first.
        // A single generic notice covers "no code sent" / "wrong code" /
        // "attempts exhausted" alike, so a stranger gets no signal about
        // which of those states they're in (no brute-force oracle).
        const candidate = extractPairingCodeCandidate(latestUserText);
        const verdict = candidate === undefined
          ? "no_code"
          : await verifyPairingCodeAttempt(resolveChannelPairingCodesFile(env), providerId, candidate);
        if (verdict !== "matched") {
          return PAIRING_CODE_REQUIRED_NOTICE;
        }
        // Adopted — confirm immediately and stop; the pairing-code text
        // itself is not a real question, so it never reaches the agent.
        await adoptChannelOwner(ownersFile, providerId, source);
        return PAIRING_CODE_SUCCESS_NOTICE;
      }
    }
    // Approval-reply hijack guard: a pending approval is 1:1-scoped state
    // (outbound-safety — only the paired owner may confirm a draft), so a
    // "yes" from a group/shared chat must NEVER be interpreted as a
    // confirmation, even if a pending entry happens to exist for this
    // providerId+source. Skipping the lookup entirely (rather than
    // filtering results) makes the hijack path structurally impossible.
    const approvalAck = scope === "shared"
      ? undefined
      : await handleInboundApprovalReply({
          pendingFile: resolvePendingApprovalsFile(env),
          providerId,
          source,
          text: latestUserText
        });
    if (approvalAck !== undefined) {
      return approvalAck;
    }
    // Channel-veto reply ("그만"/"stop these"): the one-touch off-switch for
    // proactivity. Owner 1:1 only — a shared/group chat's "그만" must never
    // silence the owner's own notices, so this is skipped entirely for
    // scope==="shared" (same posture as the approval-reply hijack guard
    // above, for the same reason: shared-chat state must never mutate
    // 1:1-scoped learned avoidance).
    const vetoAck = scope === "shared"
      ? undefined
      : await handleInboundVetoReply({
          lastDeliveryFile: resolveLastProactiveDeliveryFile(env),
          now: new Date(),
          text: latestUserText,
          trustLedgerFile: resolveProactiveTrustFile(env)
        });
    if (vetoAck !== undefined) {
      return vetoAck;
    }
    // Deterministic casual fast-path (parity with `muse ask`): a bare
    // greeting/thanks/farewell is not a question about the user's notes, so
    // answer it conversationally and skip the agent run + grounding gate
    // entirely — nothing here is a factual claim that needs a citation.
    const casualKind = classifyCasualPrompt(latestUserText);
    if (casualKind) {
      return casualResponseFor(casualKind, containsHangul(latestUserText));
    }
    // Deterministic capability fast-path (parity with `muse ask` / `muse chat`):
    // a "what can you do?" meta prompt gets the SAME honest, job-grouped describer
    // answer instead of free-composing on the local model — the over-claim/leak
    // risk the CLI meta string was written to prevent, previously absent on the
    // channel path. Env-armed status is 1:1-owner detail (which integrations are
    // connected), so a shared/group turn gets the env-neutral form — everything
    // shown as "available", never revealing the owner's config.
    if (classifyMetaPrompt(latestUserText)) {
      return describeCapabilities(scope === "shared" ? {} : env, containsHangul(latestUserText));
    }
    // Conversational fast-path (S3, completing the assistant rhythm): a
    // message `classifyChannelIntent` reads as pure smalltalk — a kind of
    // turn `classifyCasualPrompt` above does NOT cover (it only matches a
    // bare greeting/thanks/farewell) — gets ONE single-inference reply
    // instead of the full ~1min agent pipeline. TRIPLE-GATED and
    // conservative BY DESIGN (classifyChannelIntent defaults to
    // "delegation" — see chat-intent.ts): a chat message misrouted to
    // delegation only costs latency (the ack + full run below still answers
    // it correctly), so this branch fails open at every step — a `null`
    // reply, a throw, or the flag being off all fall through unchanged to
    // the ack + full-run path, the safety net.
    if (
      parseBoolean(env.MUSE_CHANNEL_CHAT, true)
      && composeChatReply
      && classifyChannelIntent(latestUserText) === "chat"
    ) {
      // Owner-scope-only "knows-you" snapshot (chat-persona-snapshot.ts): a
      // few bounded, citable lines from the SAME memory scope the auto-
      // extract hook writes (`${providerId}:${source}`). `null` on a
      // shared/group turn, an unavailable store, or a load error all
      // collapse to `[]` here — the fail-open contract this whole branch
      // already runs under (empty snapshot = behaves exactly as before).
      const personaSnapshot = (await loadChatPersonaSnapshot({ providerId, scope, source, userMemoryStore }).catch(() => null)) ?? [];
      const chatReply = await composeChatReply({ latestUserText, personaSnapshot, thread: messages }).catch(() => null);
      if (chatReply !== null) {
        // Run the SAME gate the full agent path applies below
        // (gateChatAnswerGrounding), now against REAL evidence — the persona
        // snapshot just loaded — instead of an empty list. What this buys:
        // the citation-validity check and the reported grounding verdict now
        // have a real referent (a citation naming something OUTSIDE the
        // snapshot is still dropped by code). It is STILL NOT fabrication=0
        // for a plain uncited sentence: `enforceAnswerCitations` only ever
        // inspects CITED text, so an invented fact with no "[from …]" marker
        // at all passes through untouched regardless of the evidence list —
        // that gap is unchanged by adding the snapshot. The anti-fabrication
        // defense for an UNCITED claim stays upstream: `createComposeChatReply`'s
        // no-facts system prompt (now told exactly which snapshot lines it
        // MAY draw on), the "PASS" sentinel for a genuine ask, and
        // `classifyChannelIntent`'s conservative default.
        const chatGate = gateChatAnswerGrounding({ answer: chatReply, evidence: personaSnapshot, question: latestUserText });
        return chatGate.answer;
      }
    }
    // Delegation ack (S2, "the assistant rhythm"): a non-casual request is a
    // delegation, so restate it as an early second-channel confirmation
    // BEFORE the (possibly slow) agent run, then stay quiet until the real
    // answer. Cosmetic — sequential (same local model box, no parallel
    // inference) and any failure here must never affect the run below.
    if (parseBoolean(env.MUSE_CHANNEL_ACK, true) && composeAck && notify) {
      // Fail-open: a composer error/timeout/rejection means no ack, never a
      // failed run — `composeAck` itself already fails open, but a caller's
      // implementation is not trusted to.
      const ack = await composeAck({ latestUserText }).catch(() => null);
      if (ack !== null) {
        // Ack delivery is cosmetic — a failed send must never fail the run.
        await notify(ack).catch(() => undefined);
      }
    }
    // The channel identity is the user-memory scope for this chat, so the
    // auto-extract hook grows the knows-you model from channel
    // conversations. A SHARED chat gets a DISTINCT scope
    // (`{providerId}:shared:{source}`), never the owner's own
    // `{providerId}:{source}` id: personal facts must never inject into a
    // group turn, and group chatter must never pollute the owner's user
    // model.
    const runUserId = scope === "shared" ? `${providerId}:shared:${source}` : `${providerId}:${source}`;
    // False-done backstop setup (see `countScheduledFollowups` doc comment):
    // only bother reading the followups store at all when this turn actually
    // LOOKS like a remember-with-a-date ask — the overwhelmingly common case
    // (a normal question, an action request with no date, small talk) never
    // touches the followups file.
    const rememberIntent = detectUnscheduledRememberIntent(latestUserText);
    const followupsFile = resolveFollowupsFile(env);
    const turnNow = new Date();
    const scheduledBefore = rememberIntent ? await countScheduledFollowups(followupsFile, runUserId) : 0;
    const result = await agentRuntime.run({
      messages,
      metadata: { userId: runUserId },
      model,
      toolExposureAuthority: createToolExposureAuthority({
        allowedToolNames: CHANNEL_APPROVAL_EXPOSURE_ALLOWLIST,
        localMode: false
      }),
      toolApprovalGate: createChannelApprovalGate({
        providerId,
        recordRefusal: async (refusal) => {
          // The audit log always captures the refusal (outbound-safety:
          // every action, sent OR refused, leaves a trail). The
          // re-runnable PENDING-approval queue is 1:1 only — queuing it
          // for a shared chat would make a group "yes" a viable re-run
          // path, defeating the outright-deny above.
          const logIt = createChannelRefusalRecorder({ actionLogFile: resolveActionLogFile(env), providerId, source });
          if (scope === "shared") {
            await logIt(refusal);
            return;
          }
          const queueIt = createChannelPendingRecorder({ pendingFile: resolvePendingApprovalsFile(env), providerId, source });
          await Promise.allSettled([logIt(refusal), queueIt(refusal)]);
        },
        registry,
        scope,
        source
      })
    });
    const rawOutput = result.response?.output ?? "";
    if (rawOutput.length === 0) {
      return rawOutput;
    }
    // Grounding parity with the /chat surface: gate the raw agent output
    // before it leaves for the channel, so a fabricated/uncited claim is
    // dropped by code (fabrication=0) while a properly grounded answer
    // passes UNCHANGED.
    const gate = gateChatAnswerGrounding({
      answer: rawOutput,
      evidence: [...(result.groundingSources ?? [])],
      question: latestUserText
    });
    // Honest-action gate (parity with the API /chat surface —
    // `honest-action-guard.ts`): a channel reply can CLAIM a completed
    // state-changing action ("일정을 등록했습니다") while no actuator tool ran.
    // No retry here — a Telegram/Matrix turn already left the runtime, so
    // (like the streamed /chat final frame) this is a deterministic
    // downgrade only.
    const honest = await guardAgainstUnbackedActionClaim({
      firstResult: { response: { output: gate.answer }, toolsUsed: result.toolsUsed ?? [] },
      query: latestUserText
    });
    if (!rememberIntent) {
      return honest.response.output;
    }
    // Deterministic user-side scheduling runs BEFORE the caveat
    // check, so the caveat's before/after count naturally sees whatever it
    // scheduled: no separate branch, no double-append. `turnNow` anchors
    // BOTH this extraction and the confirmation echo below to the same
    // instant.
    const scheduledFromUser = await scheduleUserSideFollowups(followupsFile, runUserId, latestUserText, turnNow);
    // The user asked to remember something date-shaped — confirm a followup
    // actually landed THIS turn (the count strictly grew) before trusting
    // the model's own claim; a same-or-lower count means NEITHER the
    // assistant's echo NOR the user-side extraction above scheduled
    // anything, so the reply gets the honest caveat appended by code.
    const scheduledAfter = await countScheduledFollowups(followupsFile, runUserId);
    if (scheduledAfter > scheduledBefore) {
      return scheduledFromUser
        ? appendScheduledConfirmation(honest.response.output, scheduledFromUser, latestUserText)
        : honest.response.output;
    }
    return appendUnscheduledRememberCaveat(honest.response.output, latestUserText);
  };
}
