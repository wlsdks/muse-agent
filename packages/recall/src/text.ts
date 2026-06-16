// Precision-first refusal markers (EN + KO). A refusal grounds NO claim, so
// ANY citation the small model tacks onto it ("…I don't have that. cite as:
// [from preferences.md]") is spurious — and the followable Sources footer
// must never present a source "to verify" for an answer that asserts nothing.
// Kept high-precision (clear no-information phrases only) so a real cited
// answer never matches; the rare partial answer ("I don't have X, but [from
// Y]…") is the accepted precision-first cost (it loses Y's footer link).
const REFUSAL_MARKERS: readonly string[] = [
  "i'm not sure", "i am not sure", "i don't have", "i do not have",
  "don't have access", "do not have access", "no information",
  "none of the provided context", "couldn't find", "could not find",
  "i don't know", "i do not know", "not in your notes", "nothing in your notes",
  "don't have that information", "do not have that information",
  "모르", "없습니다", "없어요", "없어", "정보가 없", "찾을 수 없", "알 수 없",
  "저장하고 있지 않", "가지고 있지 않", "접근할 수 없"
];

// The citation instructions injected into the --with-tools agent system prompt.
// NOTE: the injection-input-guard scans the WHOLE composed prompt (system role
// included), so these lines must carry NO credential word (token / secret /
// password / api key) near an extraction verb — "copy an existing `cite as:`
// token, or a name shown…" once matched the `credential_extraction` pattern
// ("token … shown") and false-blocked EVERY grounded --with-tools query. Use
// "tag", never "token", and keep this dependency-free guard in the test.
// The note marker hands the small model a copy-ready `cite as: [from FILE]`
// token; qwen3:8b often copies the WHOLE line, leaking the "cite as:" label into
// the answer ("…MTU 1380. cite as: [from vpn.md]") — visible on the demo (the
// front door). Strip a "cite as:" that immediately precedes a real citation
// bracket; deterministic, only touches the echoed label, never the citation
// itself. (The chat path streams live, so the label can still flash there — the
// known streaming limitation; buffered / --with-tools / demo paths are clean.)
const ECHOED_CITE_AS_RE = /\bcite\s+as:?\s*(?=\[(?:from|task|event|reminder|session|feed|contact|command|commit|memory|action)\b)/giu;

export function stripEchoedCiteAs(answer: string): string {
  return answer.replace(ECHOED_CITE_AS_RE, "");
}

/**
 * True when the answer is essentially a refusal / "I'm not sure" with no
 * grounded claim — used to deterministically drop any citation the model
 * spuriously attached to it. Pure + exported for direct coverage.
 */
export function answerIsRefusal(answer: string): boolean {
  const lower = answer.toLowerCase();
  return REFUSAL_MARKERS.some((m) => lower.includes(m));
}

// Sentence terminators, colon/dash joiners, and adversative conjunctions (EN +
// KO) — the seams a hedge-then-assert ("I don't have X, but Z" / "I don't have
// X — Z" / "I don't have X: Z" / "I don't have X. Z.") joins a refusal to a
// tacked-on claim across. (Bare comma is excluded — too many pure refusals carry
// a benign comma clause.)
const CLAUSE_SPLIT_RE = /[.!?\n;:—–―]+|\b(?:but|however|though|although|yet|still)\b|그러나|하지만|그런데|근데|다만/giu;

// A clause that NEGATES grounds no positive claim — it is a refusal RESTATEMENT
// ("…that isn't in your notes" / "…못 찾았어요"), not a tacked-on assertion. Used
// so widening the seam set above does not misread a refusal's own (negative)
// continuation as a hedge-then-assert (the fire-139 regression).
const NEGATION_RE = /\b(?:no|not|never|none|nothing|nope)\b|n['']t|없|모르|안\s|못\s/iu;

// …UNLESS the negated clause also carries concrete data (a digit — a time, a
// number, a quantity). "…it's NOT at 3pm, it's at 4pm" is a corrected ASSERTION,
// not a bare restatement, so it must reach the verdict. A digit is the cheap,
// precise signal that a clause states a fact rather than merely denying one.
const CONCRETE_DATA_RE = /\d/u;

// …OR the negated clause PIVOTS to a positive correction with no digit
// ("your manager isn't Alice, it's Bob") — the named-entity analogue of the
// digit signal, and a real fabrication that previously rode through as "pure"
// (the digit heuristic only caught numbers). Only the COMMA-joined pivot needs
// this: a period/seam-joined correction ("…isn't Alice. It's Bob.") already
// splits into its own clause and is caught by the token test. The copula must be
// followed by a REAL value, NOT another negation ("that's not…") or a locational
// restatement ("it's in your notes"), so a pure refusal isn't misread as a claim.
const NEGATION_CORRECTION_RE =
  /(?:n['']t|\b(?:not|never)\b)[^,]*,\s*(?:it['']?s|that['']?s|it is|that is|they['']?re|they are)\s+(?!(?:not|no|never|n['']t|in|on|at|from|sure|clear|listed|available|here|there)\b)[\p{L}\p{N}]/iu;

/**
 * True only for a PURE refusal — a refusal marker with NO substantive claim
 * tacked on. `answerIsRefusal` is a lenient substring test, so it also fires on a
 * HEDGE-THEN-ASSERT ("I don't have access to flights, but your flight is at 9am")
 * — and using it to short-circuit the hard grounding VERDICT lets that fabricated
 * "but…" claim ride through labeled `grounded`. This stricter predicate splits the
 * answer on sentence/seam/adversative boundaries and returns false if any clause
 * carries a real POSITIVE assertion (≥2 word tokens, not itself a refusal and not
 * a negation), so the verdict runs and adjudicates the claim. A negated clause is
 * a refusal restatement, not a claim — skipping it keeps a pure refusal pure even
 * across the colon/dash seams. Conservative on purpose (errs toward letting the
 * verdict warn — the safe direction for a fabrication=0 floor). Use ONLY at the
 * hard verdict gate; the advisory sites keep the lenient `answerIsRefusal`.
 */
export function answerIsPureRefusal(answer: string): boolean {
  if (!answerIsRefusal(answer)) return false;
  for (const clause of answer.split(CLAUSE_SPLIT_RE)) {
    const trimmed = clause.trim();
    if (trimmed.length === 0) continue;
    // A negation→positive-correction pivot ("…isn't Alice, it's Bob") smuggles a
    // corrected ASSERTION even when the clause also carries a refusal marker
    // and no digit, so it's checked BEFORE the refusal / negation-only skips
    // (which would otherwise let the named-entity fabrication ride through pure).
    if (NEGATION_CORRECTION_RE.test(trimmed)) return false;
    const isNegationOnly = NEGATION_RE.test(trimmed) && !CONCRETE_DATA_RE.test(trimmed);
    if (answerIsRefusal(trimmed) || isNegationOnly) continue;
    const tokens = trimmed.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
    if (tokens.length >= 2) return false;
  }
  return true;
}

/**
 * Whether a `--file` payload is BINARY (a PDF, image, archive, office doc…)
 * rather than readable text. Reading such a file as UTF-8 yields garbled bytes,
 * and grounding on that garbage makes the small model HALLUCINATE plausible
 * content and cite it `[from <file>]` — a fabrication. So we refuse to ground on
 * it. Heuristic (deterministic, no deps): a NUL byte is the canonical binary
 * signal (text never contains one); failing that, a high ratio of U+FFFD
 * replacement chars from a lossy UTF-8 decode means the bytes were not text.
 * Only the first ~8 KB is inspected — enough to classify, cheap on a big file.
 */
export function looksLikeBinaryContent(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 8192);
  if (sample.length === 0) {
    return false;
  }
  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }
  }
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(sample);
  let replacements = 0;
  for (const char of decoded) {
    if (char === "�") {
      replacements += 1;
    }
  }
  return replacements / decoded.length > 0.1;
}

/**
 * The cite label for a `--url`-grounded answer: the page's host (`www.` stripped),
 * so the model cites `[from example.com]` and the gate validates it like a note
 * source. Falls back to the raw URL if it can't be parsed.
 */
export function urlGroundingSource(finalUrl: string): string {
  try {
    return new URL(finalUrl).hostname.replace(/^www\./u, "");
  } catch {
    return finalUrl;
  }
}

/** Render the explicit-link neighbours as a scannable footer (empty when none). */
export function formatGraphLinksSection(links: readonly string[]): string {
  if (links.length === 0) {
    return "";
  }
  const lines = links.map((id) => `  ↔ ${id}`);
  return `\n🔗 Linked notes (your [[wiki-links]]):\n${lines.join("\n")}\n`;
}

/** Render a corpus-overview reply: the note inventory + how to use it. Pure. */
export function formatCorpusOverview(noteFiles: readonly string[], totalCount: number): string {
  const lines = noteFiles.map((file) => `  • ${file}`);
  const more = totalCount > noteFiles.length ? [`  … and ${(totalCount - noteFiles.length).toString()} more`] : [];
  return [
    `You have ${totalCount.toString()} note${totalCount === 1 ? "" : "s"}. I answer specific questions from them — here's what you've got:`,
    ...lines,
    ...more,
    "Ask me anything in them and I'll quote the source."
  ].join("\n");
}

/**
 * Whether this query EXPLICITLY supplied its own grounding source — a `--file`,
 * `--url`, `--git`, or `--shell`. When it did, the empty-notes on-ramp is
 * irrelevant noise (the user told Muse exactly what to ground on). Pure + exported.
 */
export function queryHasAdHocGrounding(options: {
  readonly file?: string;
  readonly url?: string;
  readonly clipboard?: boolean;
  readonly git?: boolean;
  readonly shell?: boolean;
}): boolean {
  return Boolean(
    (options.file && options.file.trim().length > 0)
    || (options.url && options.url.trim().length > 0)
    || options.clipboard
    || options.git
    || options.shell
  );
}

export function corpusOnboardingHint(noteFileCount: number, hasOtherPersonalData = false): string | undefined {
  // The first-run notes on-ramp. Suppressed once the user has notes OR any other
  // personal data (contacts / tasks / reminders / remembered facts) — otherwise
  // it both NAGS to "add notes" and falsely claims "Muse only answers from notes"
  // on the very same turn it answered from your address book. A genuinely empty
  // Muse still gets the hint.
  if (noteFileCount > 0 || hasOtherPersonalData) {
    return undefined;
  }
  return [
    "(your notes corpus is empty — Muse only answers from notes you've added.",
    "   • try a sample first:   muse demo",
    "   • add one file:         muse read <file> --save-to-notes <id>",
    "   • add a whole folder:   muse read <dir> --save-to-notes <prefix>",
    "   • keep it live:         muse watch-folder --ingest --path <dir>)"
  ].join("\n");
}

/**
 * Whether to append the warm refusal close: ONLY when the answer is an honest
 * refusal AND the user already has notes. An EMPTY corpus gets the on-ramp
 * hint instead (so the two never double up), and a real cited answer never
 * gets it. Pure + exported for direct coverage.
 */
export function shouldWarmClose(answer: string, noteFileCount: number): boolean {
  return noteFileCount > 0 && answerIsRefusal(answer);
}

export function composeChatSystemContent(systemPrompt: string, playbookSection: string | undefined): string {
  return playbookSection && playbookSection.trim().length > 0 ? `${playbookSection}\n\n${systemPrompt}` : systemPrompt;
}

/**
 * Whether to nudge the user toward `--repair` after an ungrounded verdict. Only
 * when: the verdict actually fired, `--repair` wasn't already requested, we're
 * not in `--json`, and there IS retrieved evidence to rewrite from (with no
 * evidence the repair would just refuse, so the tip would mislead). Surfaces the
 * constructive-repair capability exactly when it can help. Pure + exported.
 */
export function shouldSuggestRepair(args: {
  readonly verdictFired: boolean;
  readonly repairRequested: boolean;
  readonly json: boolean;
  readonly evidenceCount: number;
}): boolean {
  return args.verdictFired && !args.repairRequested && !args.json && args.evidenceCount > 0;
}

/**
 * Whether to surface the "Removed N citation(s) … treat those claims as
 * unverified" notice. Fires only when the gate actually stripped something AND
 * the answer makes claims to doubt — NOT on a REFUSAL (which asserts nothing, so
 * "treat those claims as unverified" is nonsensical) and NOT on an ACTION request
 * (the model citing a tool name is a harmless quirk). The spurious citation is
 * stripped from the text either way; this gates only the user-facing warning.
 */
export function shouldWarnStrippedCitations(args: {
  readonly strippedCount: number;
  readonly json: boolean;
  readonly isActionRequest: boolean;
  readonly isRefusal: boolean;
}): boolean {
  return args.strippedCount > 0 && !args.json && !args.isActionRequest && !args.isRefusal;
}

// Unmistakable intent words for the OPT-IN perception sources. Precision-first:
// a git-specific token (commit/git/branch/…), never the ambiguous "work on", so
// a non-git refusal ("what's my rent?") never gets a spurious --git tip.
const GIT_INTENT_RE = /\b(commit|commits|committed|committing|git|branch|branches|rebase|rebased|repo|repository|codebase|pull request)\b/iu;

const SHELL_INTENT_RE = /\b(command|commands|terminal|shell|bash|zsh|cli command|docker|kubectl)\b/iu;

/**
 * On a REFUSAL, surface the opt-in perception source that would likely answer
 * the question — so an undiscoverable `--git` / `--shell` flag becomes findable
 * (a user asking "what did I commit?" otherwise just gets "not in your notes" and
 * never learns Muse can read their git history). Precision-first: only an
 * unmistakable intent fires, and only when the matching flag is NOT already on.
 * Pure + exported.
 */
export function suggestOptInSource(
  query: string,
  enabled: { readonly git: boolean; readonly shell: boolean }
): string | undefined {
  if (!enabled.git && GIT_INTENT_RE.test(query)) {
    return "(tip: add --git to also ground on your recent git commits in this repo)";
  }
  if (!enabled.shell && SHELL_INTENT_RE.test(query)) {
    return "(tip: add --shell to also ground on your recent shell-history commands)";
  }
  return undefined;
}
