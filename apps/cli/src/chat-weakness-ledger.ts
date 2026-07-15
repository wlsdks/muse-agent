/**
 * Whetstone weakness-ledger recording for `muse chat` — extracted verbatim
 * from `chat-repl.ts` (behavior-preserving decomposition: same exports, same
 * bodies, only the file boundary moved). This cluster is the detect →
 * classify → persist → nudge pipeline both `runLocalChat` (inline) and the
 * interactive Ink chat (`recordChatTurnWeakness`) drive after a turn
 * finishes. `chat-repl.ts` re-exports the public members so every existing
 * importer (`chat-ink-run.ts`, the weakness-ledger tests) keeps working
 * unchanged.
 */

import { classifyCasualPrompt, isUnbackedActionClaim, type KnowledgeMatch } from "@muse/agent-core";
import type { AskTimeNudge, WeaknessEntry } from "@muse/stores";

import { chatWeaknessAxis, isChatAbstention, isChatGroundedSuccess, type ChatWeaknessAxis } from "./chat-grounding.js";

// The explicit refusal phrases the grounding floor emits ("잘 모르겠어요" /
// "I'm not sure" / "no matching passages") — anchored on these, NOT a bare
// "not sure", so a normal answer that merely contains the words isn't logged.
const REFUSAL_RE = /잘\s*모르겠|모르겠어|관련(된|있는)?\s*(노트|메모|정보|내용)[^.]*없|찾(지|을)\s*(못했|수\s*없)|i'?m\s+not\s+sure|i\s+am\s+not\s+sure|no\s+matching\s+(passages|notes)|don'?t\s+have\s+(that|any)|couldn'?t\s+find/iu;

export function looksLikeRefusal(text: string): boolean {
  return REFUSAL_RE.test(text);
}

/**
 * Append a failure signal to the Whetstone weakness ledger. @muse/mcp +
 * @muse/autoconfigure are loaded LAZILY — a static import of these heavy
 * modules breaks the bun-compiled desktop binary (top-level await in a sync
 * context). Best-effort; swallows every error.
 */
async function recordChatWeakness(
  message: string,
  axis: ChatWeaknessAxis,
  deps: RecordChatWeaknessDeps = {}
): Promise<number | undefined> {
  try {
    const recordWeakness = deps.recordWeakness ?? (await import("@muse/stores")).recordWeakness;
    const { resolveWeaknessesFile } = await import("@muse/autoconfigure");
    const file = deps.weaknessesFile ?? resolveWeaknessesFile(process.env as Record<string, string | undefined>);
    const entry = await recordWeakness(file, { axis, message });
    return entry?.count;
  } catch {
    // a ledger write must never surface as a chat error
    return undefined;
  }
}

export interface RecordChatWeaknessDeps {
  /** Injectable ledger writer + file (tests assert the ledger STATE without a live store). */
  readonly recordWeakness?: (
    file: string,
    signal: { readonly axis: ChatWeaknessAxis; readonly message: string }
  ) => Promise<{ readonly count: number } | undefined>;
  readonly weaknessesFile?: string;
}

export interface ResolveChatWeaknessDeps {
  /** Injectable ledger resolver + file (tests assert resolution without a live store). */
  readonly recordWeaknessResolved?: (file: string, message: string) => Promise<unknown>;
  readonly weaknessesFile?: string;
}

/**
 * Mark this topic's grounding-gap weakness RESOLVED after a grounded success —
 * the parity of ask's `recordAskWeaknessResolvedLive`. Bumps BKT mastery so a
 * now-answered recurring gap stops nudging. @muse/mcp + @muse/autoconfigure load
 * LAZILY (a static import breaks the bun-compiled desktop binary). Best-effort:
 * a ledger write must never surface as a chat error.
 */
export async function chatResolveWeakness(message: string, deps: ResolveChatWeaknessDeps = {}): Promise<void> {
  try {
    const recordWeaknessResolved = deps.recordWeaknessResolved ?? (await import("@muse/stores")).recordWeaknessResolved;
    const file = deps.weaknessesFile ?? (await import("@muse/autoconfigure")).resolveWeaknessesFile(process.env as Record<string, string | undefined>);
    await recordWeaknessResolved(file, message);
  } catch {
    // a ledger write must never surface as a chat error
  }
}

/**
 * Classify a finished chat turn's failure signal and write it to the weakness
 * ledger — the testable seam for the turn's detect→classify→persist step. Mirrors
 * the ASK path (`recordAskWeakness` + `askWeaknessAxis`): `unbacked-action` >
 * `misgrounding` (a non-refusal answer whose cited sources don't support it,
 * GROUNDED != TRUE) > `grounding-gap` (a refusal/empty-fallback). A fully-supported
 * grounded answer writes NOTHING. Best-effort: a null axis writes nothing, a
 * throwing write is swallowed. Returns the resulting topic count (for the repeat nudge).
 */
export async function recordChatWeaknessForTurn(
  args: {
    readonly message: string;
    readonly answer: string;
    readonly matches: readonly KnowledgeMatch[];
    readonly refusal: boolean;
    readonly unbackedAction: boolean;
  },
  deps: RecordChatWeaknessDeps = {}
): Promise<number | undefined> {
  const axis = chatWeaknessAxis({
    answer: args.answer,
    matches: args.matches,
    refusal: args.refusal,
    unbackedAction: args.unbackedAction
  });
  if (axis === null) return undefined;
  return recordChatWeakness(args.message, axis, deps);
}

export interface ChatRepeatNudgeDeps {
  /** Injectable ledger reader + selection/render/topic seams (tests assert the nudge OUTCOME without a live store). */
  readonly readWeaknesses?: (file: string) => Promise<readonly WeaknessEntry[]>;
  readonly selectNudge?: (entries: readonly WeaknessEntry[], topic: string, opts?: { readonly nowMs?: number }) => AskTimeNudge | undefined;
  readonly render?: (nudge: AskTimeNudge, ko: boolean) => string;
  readonly topicKey?: (message: string) => string;
  readonly weaknessesFile?: string;
}

/**
 * The in-chat repeat-weakness nudge — unified onto the shared @muse/mcp helpers so
 * chat and `ask` surface the SAME recurring user-remediable weakness (grounding-gap
 * OR source-conflict), mastery-suppressed, with one axis-aware wording. Returns the
 * parenthetical suffix to append to the answer, or undefined when there is nothing
 * to nudge. @muse/mcp + @muse/autoconfigure load LAZILY (a static import of these
 * heavy modules breaks the bun-compiled desktop binary). Best-effort: any failure
 * (ledger unavailable, etc.) → no nudge.
 */
export async function chatRepeatWeaknessNudge(message: string, deps: ChatRepeatNudgeDeps = {}): Promise<string | undefined> {
  try {
    const mcp = deps.readWeaknesses && deps.selectNudge && deps.render && deps.topicKey ? undefined : await import("@muse/stores");
    const readWeaknesses = deps.readWeaknesses ?? mcp!.readWeaknesses;
    const selectNudge = deps.selectNudge ?? mcp!.askTimeWeaknessNudge;
    const render = deps.render ?? mcp!.renderAskTimeNudge;
    const topicKey = deps.topicKey ?? mcp!.topicKeyFromMessage;
    const file = deps.weaknessesFile ?? (await import("@muse/autoconfigure")).resolveWeaknessesFile(process.env as Record<string, string | undefined>);
    const nudge = selectNudge(await readWeaknesses(file), topicKey(message), { nowMs: Date.now() });
    if (!nudge) return undefined;
    return `\n\n(${render(nudge, /[가-힣]/u.test(message))})`;
  } catch {
    return undefined;
  }
}

/**
 * Whetstone weakness-ledger parity for a chat turn run OUTSIDE `runLocalChat`
 * (the interactive Ink surface, `cli.ink`, drives its own turn loop and never
 * called the classify→persist→nudge sequence above — the MOST-USED chat
 * surface silently skipped the same self-knowledge `runLocalChat` already
 * records). Same detect→classify→persist→nudge steps `runLocalChat` runs
 * inline, extracted so both surfaces share ONE implementation. Returns the
 * repeat-weakness nudge suffix to append to the DISPLAYED answer, or
 * `undefined` when there is nothing to record/nudge. Best-effort: every step
 * it calls already swallows its own errors.
 */
export async function recordChatTurnWeakness(args: {
  readonly question: string;
  readonly answer: string;
  readonly matches: readonly KnowledgeMatch[];
  readonly toolsUsed?: readonly string[];
}): Promise<string | undefined> {
  const isCasual = classifyCasualPrompt(args.question) !== null;
  const refusal = isChatAbstention(args.answer) || looksLikeRefusal(args.answer);
  const unbackedAction = isUnbackedActionClaim({ answer: args.answer, query: args.question, toolNames: args.toolsUsed ?? [] });
  if (unbackedAction) {
    await recordChatWeaknessForTurn({ answer: args.answer, matches: args.matches, message: args.question, refusal, unbackedAction });
    return undefined;
  }
  if (isCasual) return undefined;
  await recordChatWeaknessForTurn({ answer: args.answer, matches: args.matches, message: args.question, refusal, unbackedAction });
  if (isChatGroundedSuccess({ answer: args.answer, matches: args.matches, refusal, unbackedAction })) {
    await chatResolveWeakness(args.question);
  }
  return chatRepeatWeaknessNudge(args.question);
}
