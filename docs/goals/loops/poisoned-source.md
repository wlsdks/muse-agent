# Loop journal — poisoned-source (GROUNDED≠TRUE 출처-진위 방어)

Theme: oversee that poisoned notes/episodes/MCP sources can't launder past the
grounding gate. Worktree `/tmp/muse-poisoned-source`, branch `loop/poisoned-source`,
cron `cb79365d` (20m, session-only, Tier2 push + merge-to-main every 3 fires).

## fire 1 · 2026-06-21 · poisoned-source · (no-ship — ④ judge FAIL, rolled back)

meta: value-class=new-capability · pkg=@muse/agent-core · kind=injection-pattern · verdict=FAIL(rolled back) · firesSinceDrill=1

ratchet: testFiles unchanged · fabrication 0 · no eval delta (code reverted)

WHAT: attempted T1-a-ko-resid — the Korean analogs of the English output-clamp
("reply only with") + role-hijack ("act as … instead") injection patterns in
`MEMORY_INJECTION_PATTERNS` (the deterministic neutralizer under all 4 stored
grounding surfaces + live tool/MCP output). Designed two tightly-anchored
patterns (`오직/오로지 … 만 … <answer-imperative>` clamp + `인 척 … <behavior-imperative>`
role) that passed a 51-note hand corpus at 0 FP and 10/10 malicious.

WHY (no-ship): an INDEPENDENT Opus ④ judge (maker≠judge) ran its OWN 49-note
benign corpus and found 8.2% false-positives + a ReDoS regression — the same FP
failure class that rolled this item back once before (core-hardening fire 6). The
deterministic gates were all green (agent-core 2570 tests + mutation-RED proven,
pnpm check all-workspace, lint, eval:memory-poisoning, eval:action-log-tamper);
the judge caught what the author's narrower corpus missed. Rolled back per the
④ FAIL contract; the system worked — the independent judge stopped a security +
FP regression before it shipped.

REVIEW POINT: the slice is a known-hard regex problem on Korean, not a quick win;
the sharpened blocker (3 concretely-pinned sub-problems) is in backlog.md.

RISK: none shipped (code/test reverted to origin/main state).

lesson: Korean injection-pattern anchoring still false-positives on (a) REPORTED
SPEECH (`V-라고/하라고` + `했다/조언했다` embeds the imperative form), (b) BARE VERB
STEMS that are substrings of connective/descriptive continuations (`굴어`⊂`굴어서`,
`대답해`⊂`대답해 주는`), and (c) the `오직 X만 [benign gap] verb` shape admits
intervening benign content. ALSO: the `\s*` + lazy `.{0,N}?` regex idiom is
catastrophic-backtracking ReDoS on the UNCAPPED `capToolOutput` surface — never
place two whitespace-consuming quantifiers adjacent. A 0-FP hand corpus of
DECLARATIVES is not enough: any future probe MUST include reported-speech,
connective-suffix, and app-description shapes, and a ReDoS scaling measurement.
A 3rd attempt needs `(?!고)` exclusion + terminal-imperative-only verbs (no bare
stems) + ReDoS-safe filler, all together — or this stays deferred as a real
design problem (not a loop-sized quick win).

## fire 2 · 2026-06-21 · poisoned-source · 9c34… (see commit)

meta: value-class=wiring · pkg=@muse/recall (+apps/cli) · kind=trust-tagging · verdict=PASS · firesSinceDrill=2

ratchet: testFiles +0 (extended grounding-notices.test) · fabrication 0 · pkg/kind ≠ fire 1 (was agent-core/injection-pattern) · eval:memory-poisoning PASS · eval:action-log-tamper PASS

WHAT: in the `muse ask` grounding-evidence pool, FEED headlines (third-party
RSS/Atom — poisonable, NOT the user's own data) were added with no `trusted`
flag → defaulted to trusted, so an answer resting SOLELY on a poisoned feed got
plain "grounded" with no untrusted-source scrutiny cue. The tool/web/MCP path
(`agentGroundingSources`) already tagged `trusted:false`; feeds were the gap.
Added pure `untrustedFeedMatch` (@muse/recall) returning the feed match
`trusted:false`; commands-ask.ts uses it instead of the inline `exactMatch`.

WHY: closes a GROUNDED≠TRUE leak on the PRIMARY wedge surface — a poisonable
external source could launder as trusted-grounded. The fix is additive (cue
only; never changes the grounded/ungrounded verdict — fabrication floor
untouched). Evidence text is byte-identical to before (judge-verified), so no
grounding-gate drift.

REVIEW POINT: feeds are the only external-untrusted-but-untagged corpus source
today (sibling-audit: chat has no feed grounding; episodes/notes/memory/tasks/
contacts are the user's own data and stay trusted). Two coupled FUTURE
requirements recorded as backlog ◦ (judge-surfaced): external-calendar-sync and
vCard-import contact trust — wire `trusted:false` when those external paths land.

RISK: low — additive scrutiny cue, deterministic, mutation-proven (drop
`trusted:false` → feed-only cue test RED), independent Opus ④ judge PASS.

## fire 3 · 2026-06-21 · poisoned-source · (see commit)

meta: value-class=wiring · pkg=@muse/recall (+apps/cli) · kind=machine-surface-signal · verdict=PASS · firesSinceDrill=3

ratchet: testFiles +0 (extended grounding-notices + program-helpers tests) · fabrication 0 · pkg/kind ≠ fires 1-2 · eval:memory-poisoning PASS · eval:action-log-tamper PASS · MERGE→MAIN fire (÷3)

WHAT: the `muse ask` source-check cues (untrusted-only provenance + ALCE
citation precision/recall) were stderr-only (gated `!options.json`), so a
`--json`/run-log consumer got `groundedVerdict:"grounded"` with no indication
the answer rested only on poisonable sources or carried a mis-/un-cited
citation — the same GROUNDED≠TRUE machine-surface leak V1 closed for fan-out
signals. New pure `sourceCheckSignals` (@muse/recall, the machine twin — calls
the same 3 notice fns ⇒ zero-drift) added to the --json payload + run-log.

WHY: closes the GROUNDED≠TRUE leak on the surface a downstream agent reads, and
feeds the error-analysis flywheel (a grounded-but-untrusted answer is now a
distinct logged signal, not a clean success). Purely additive (verdict/answer
untouched; fabrication floor intact).

REVIEW POINT: scope was tricky — the notices live in an inner verdict block
(8-space) but the run-log/payload are outer (6-space); fixed by lifting a
`let sourceCheck` to the outer scope (mirroring `groundedVerdictLabel`), same
gate/args as the stderr cues so machine + human can't diverge (judge-verified
zero-drift across 11 cases). Sibling ◦ recorded: chat-surface machine twin
(untrustedOnlyChatNotice) is the natural next slice once it's wired to stderr.

RISK: low — additive optional field, deterministic, mutation-proven (neuter the
helper return → 8 RED), independent Opus ④ judge PASS.

## fire 4 · 2026-06-21 · poisoned-source · (see commit)

meta: value-class=bug-fix · pkg=@muse/cli (chat-grounding/chat-ink) · kind=evidence-hygiene · verdict=PASS · firesSinceDrill=4

ratchet: testFiles +0 (extended chat-finalize + chat-ink-render) · fabrication 0 · pkg/kind ≠ fires 1-3 (new kind=evidence-hygiene) · eval:memory-poisoning PASS · eval:action-log-tamper PASS

WHAT: the Ink chat appended DISPLAY-only source-check cues (untrusted-only /
citation / conflict ⚠️ warnings) to the answer and then stored that cue-laden
string into conversation history. `conversationMatches` maps every history turn
to a cosine-1 TRUSTED grounding match — so Muse's own untrusted-source WARNING
got replayed as TRUSTED grounding evidence the next turn (grounded≠true
self-pollution: an untrusted-source warning laundered into trusted evidence).
FIX (Slice A): `finalizeGatedChatAnswer` returns `{display, forHistory}`
(forHistory = answer+receipt, no cues); the Ink chat persists `forHistory` at
all three persist sites (history.push, onCommit→appendLastChatTurn, autoLearn)
and shows `display` at the display sites.

WHY: a self-poisoning evidence loop on the PRIMARY companion surface — the gate
itself was being fed Muse's own warning text as trusted evidence. Additive to
the gate (display + verdict unchanged; only persisted text changed).

REVIEW POINT: decomposed — Slice A (Ink, this fire) + Slice B (one-shot `muse
chat` persist via program.ts appendLastChatTurn, recorded as backlog ◦). Scope
care: display vs forHistory routing across 6 sites (3 persist, 3 display);
sibling-audit confirmed by the ④ judge. Added a render-layer wiring test
(distinct display/forHistory mock → committed===forHistory) closing the judge's
noted coverage gap; mutation-proven (persist→display = RED).

RISK: low — only PERSISTED text changed; verdict/displayed answer byte-identical,
deterministic, mutation-proven at unit + render layers, independent Opus ④ PASS.

## fire 5 · 2026-06-21 · poisoned-source · (see commit)

meta: value-class=bug-fix · pkg=@muse/cli (chat-repl/program/program-helpers) · kind=evidence-hygiene · verdict=PASS · firesSinceDrill=5

ratchet: testFiles +0 (extended program-helpers test) · fabrication 0 · pkg=cli kind=evidence-hygiene (2nd consecutive — completes the fire-4 decomposition, NOT a new well) · eval:memory-poisoning PASS · eval:action-log-tamper PASS

WHAT: Slice B — the one-shot `muse chat`/desktop sibling of fire 4. `runLocalChat`
returned the cue-laden `.display`; program.ts persisted it via `appendLastChatTurn`
→ re-fed as trusted grounding evidence on the next session's `priorHistory`. The
desktop companion runs ONLY chat, so this was a live recurring path. FIX:
`runLocalChat` now returns a `responseForHistory` cue-free twin (parallel-tracked
through every real-content transform; display-only affordances — source-check
cues + repeat-weakness nudge — excluded); new pure `chatTurnPersistText(body)`
selects the twin; program.ts persists via it.

WHY: completes the fire-4 Ink fix across BOTH chat surfaces — the self-pollution
loop (Muse's own warning replayed as trusted evidence) is now closed everywhere a
chat turn is persisted. Display + run-log byte-identical (only appendLastChatTurn
changed).

REVIEW POINT: 2nd consecutive (cli, evidence-hygiene) — justified as decomposition
completion (Slice B of fire 4), not a fresh same-well pick; next fire should
diversify (pkg/kind). Judge confirmed the parallel-track audit (every transform
mirrored, nudge correctly excluded). chatTurnPersistText fallback keeps remote/
legacy paths byte-identical.

RISK: low — only persisted text changed; deterministic, mutation-proven, Opus ④ PASS.

## fire 6 · 2026-06-21 · poisoned-source · (no-ship — probe-gated rollback, no source touched)

meta: value-class=de-scope · pkg=@muse/agent-core (injection.ts — NOT touched) · kind=injection-pattern · verdict=NO-SHIP · firesSinceDrill=6

ratchet: testFiles +0 · fabrication 0 · pkg/kind diversified from recent cli/evidence-hygiene (per fire-5 flag) · MERGE→MAIN fire (÷3) — merged fires 4,5

WHAT: 3rd attempt at T1-a-ko-resid (Korean output-clamp + role-hijack injection
patterns) with the FULL sharpened recipe (terminal-imperative-only verbs +
ReDoS-safe `[^\n]` filler + `(?![가-힣])` clause-boundary reported-speech
exclusion). Probe-FIRST: reached 0 FP on 60 benign + 10/10 malicious + no ReDoS,
but harder benign probing kept surfacing NEW benign shapes (rhetorical-? , adnominal/
quotative 답하라던/행동하라는/말해라하고, quoted reported speech) the anchors can't
exclude. Rolled back at the PROBE stage — zero source/test/gate budget spent.

WHY (no-ship + DE-SCOPE): 3 attempts now confirm these two classes are NOT
regex-separable from benign Korean at the 0-FP bar — distinguishing a direct
command-to-the-assistant from reported/adnominal/quotative/rhetorical/quoted
imperative needs a learned classifier / dependency-parse / NER, out of loop-slice
scope (runtime model fixed). De-scoped in backlog; do NOT re-attempt as a regex
slice. The shipped ignore-previous-instructions Korean pattern stays the floor.

REVIEW POINT: probe-first gating is what made this cheap — the empirical FP probe
IS the verification that blocked the build. Read-side deterministic vein is now
mature (5 ships across feed-trust + ask/chat machine + chat hygiene); remaining
candidate = write-side auto-extract source-attribution verification (uncertain gap)
or 진안 theme repoint.

lesson: a Korean injection-regex slice at the 0-FP bar is a receding target —
each harder benign probe surfaces a new reported/embedded/rhetorical imperative
shape. PROBE-FIRST with a corpus spanning reported/adnominal/quotative/rhetorical/
quoted forms BEFORE writing source; if FP shapes keep multiplying across rounds,
the class is not regex-tractable — stop and de-scope, don't keep patching anchors.

## fire 7 · 2026-06-21 · poisoned-source · (see commit)

meta: value-class=new-capability(hardening) · pkg=@muse/memory · kind=write-gate-hardening · verdict=PASS · firesSinceDrill=7

ratchet: testFiles +0 (extended auto-extract-provenance-gate test) · fabrication 0 · pkg=@muse/memory NEW (≠ recent cli/agent-core) · kind=write-gate-hardening NEW · eval:memory-poisoning PASS · eval:action-log-tamper PASS

WHAT: the user-memory auto-extractor's provenance gate `dropModelAssertedValues`
(drops a value whose distinctive tokens are all in the assistant reply, none in
the user turn — so a tool/feed line the assistant surfaced isn't persisted as
"what you told me") was applied to ONLY facts+preferences. vetoes+goals
(ExtractedSlot[]) bypassed it → a poisoned tool/feed-sourced veto/goal could be
distilled and persisted, driving proactivity/standing-objectives. FIX: shared
`isModelAssertedValue` predicate (behavior-preserving for facts/prefs) +
`dropModelAssertedSlots` (malformed-array-robust: passes bad elements through to
the sanitizer, never throws) wired for vetoes+goals.

WHY: closes a write-side poisoned-source vector — the gate protected 2 of 4 slot
kinds (a sibling-audit miss). The scout candidate's facts/prefs hypothesis was
REFUTED (already closed); the real gap was the veto/goal siblings.

REVIEW POINT: behavior-preserving refactor verified (498 memory tests); both
mutation arms RED (helper gate→keep-all; wiring remove-veto-line→end-to-end RED);
judge sibling-audit confirmed vetoes+goals were the ONLY ungated
model-from-assistant slot kinds (muse remember / muse user add / inferPreferences
all user-sourced). Caught a crash-on-malformed-slot bug mid-build (the slot array
is untrusted model output) → guard passes malformed elements through.

RISK: low — only DROPS poisoned writes (never adds), user-stated directives
survive (calibrated), malformed-robust, mutation-proven at helper + wiring, Opus ④ PASS.

## fire 8 · 2026-06-21 · poisoned-source · (scout + decompose — no code shipped)

meta: value-class=scout/decompose · pkg=N/A (discovery fire) · kind=gap-scout · verdict=NO-SHIP(decompose) · firesSinceDrill=8

ratchet: testFiles +0 · fabrication 0 · MERGE→MAIN n/a (fire 8 not ÷3)

WHAT: spent the fire on an Opus gap-scout (codegraph + WebSearch) after confirming
the VISION surface mature (gateVisionAction: independent-evidence two-pass,
required-unverified blocks, optional dropped+re-derived, path=sanitized slug from
gated title). The scout (independently citing MemoryGraft arXiv:2512.16962 +
LTM-security survey arXiv:2604.16548) found the LAST untrusted→memory laundering
path: the EPISODE store. The `trusted:false` bit propagated to feeds (fire 2),
tool output, and veto/goal (fire 7) but NOT to episodes — a session whose
assistant turns repeated tool/feed-grounded content is summarised and stored with
no trust field, then surfaced next session as TRUSTED grounding evidence (so the
untrusted-only cue never fires on it).

WHY (decompose, no rush): VERIFICATION showed the scout's "1 fire" under-counted
the threading depth — the trust signal isn't reliably recoverable from transcript
text at capture (chat tool/feed citation format is inconsistent; fires 4-5
stripped cues from persisted turns), and the bit must thread
turn→store→embedding-index→recall→cue for BOTH ask and chat. Genuinely 3-4
components / multi-fire. This fire's budget already went to deep discovery (the
Opus scout alone ~123k tokens), so per DECOMPOSE-ON-DEFER + loop-budget caps I
converted the verified finding into 3 sequenced loop-sized backlog slices (EP-1
turn-trust+store-field foundation → EP-2 ask recall threading → EP-3 chat parity)
+ a runner-up (trust-aware conflict cue), rather than rush a fragile multi-layer
change late in budget.

REVIEW POINT: ★ EP-1/2/3 in backlog are the next fires' high-value fuel (the only
genuinely-open deterministic poisoned-source vein left, paper-grounded). All other
surfaces (recall ask/chat, write-side memory facts/prefs/veto/goal, vision,
proactive/reflection faithfulness) confirmed mature this fire.

lesson: an Opus gap-scout that returns a "1-fire" estimate still needs
verify-then-apply — the episode-trust slice's real cost is the trust-propagation
threading (turn→store→index→cue), not the store field. When a scout finding is
multi-layer, DECOMPOSE into sequenced slices the same fire rather than starting a
fragile partial; the discovery budget is well spent if it yields sequenced fuel.

## fire 9 · 2026-06-21 · poisoned-source · (see commit)

meta: value-class=new-capability(hardening) · pkg=@muse/mcp+@muse/cli · kind=episode-provenance/trust-tagging · verdict=PASS · firesSinceDrill=9

ratchet: testFiles +0 (extended mcp + cli tests) · fabrication 0 · pkg/kind NEW (episode store + capture + recall) · eval:memory-poisoning PASS · eval:action-log-tamper PASS · MERGE→MAIN fire (÷3)

WHAT: shipped EP-1+EP-2 (fire-8 decomposition) — the episode-provenance trust bit,
closing the LAST untrusted→memory laundering path for the Ink-chat→ask path
(MemoryGraft arXiv:2512.16962). PersistedEpisode.trusted? (+serialize/validate
round-trip) ← captureEndOfSessionEpisode(untrustedSession) ← chat-ink bridges the
session verdict (runChatInk closure set by an onUntrustedAnswer prop, reset on
/reset, read at the post-unmount capture) ← finalizeGatedChatAnswer now returns
`untrustedOnly` (same cue computation, no drift). commands-ask tags episode
grounding evidence trusted:false (store-lookup) so an answer resting solely on a
poisoned episode trips the untrusted-only cue instead of being laundered as "your
own history".

WHY: the `trusted:false` bit reached feeds/tool/veto/goal but not episodes — a
session that grounded on poisoned sources became "trusted" history next session.
Additive (only adds a scrutiny-cue path; never changes a grounded verdict).

REVIEW POINT: multi-layer slice (store + capture + chat-grounding return + chat-ink
bridge + ask consumer); the bridge is the subtle part (capture runs post-unmount →
a runChatInk closure, not a component ref). Honest deferrals (judge-confirmed, in
backlog): EP-1b (per-turn PERSISTENCE for resumed/one-shot under-mark — current
in-memory bridge only covers the live Ink process, fail-open) + EP-3 (chat-surface
cue parity). Judge also flagged the inline ask-tag lacks a direct unit test (minor
follow-up recorded).

RISK: low — additive, mutation-proven at 3 seams (capture/finalize/store), Opus ④
PASS (over/under-mark verified, conservative cue, byte-identical clean episodes).

MERGE→MAIN DEFERRED (⑤c blocked, NOT by this slice): after merging origin/main,
`pnpm check` fails ONLY on `@muse/model` `web-search-policy` property-fuzz — a
5000ms TEST TIMEOUT (not an assertion), reproducible in isolation at 7.2s under
sustained box saturation from concurrent cron loops (the recorded env issue:
"concurrent loops saturate machine → slow tests false-timeout at 5000ms"). Not my
package, not the merge content, not a code regression. Per ⑤c I did NOT force the
push past a red check; fire 9 is verified + on the branch; the main-merge retries
next ÷3 fire (box may be quieter / test-hygiene loop can raise the fuzz test's
testTimeout). BLOCKER also a real test-quality signal: web-search-policy's nested
property-fuzz needs a larger testTimeout or a smaller corpus (env-independent).

## fire 10 · 2026-06-21 · poisoned-source · (see commit) — JUDGE-DRILL

meta: value-class=judge-drill+new-capability · pkg=@muse/recall (+apps/cli) · kind=verifier-drill / helper-extraction · verdict=PASS · firesSinceDrill=0 (RESET by this drill)

ratchet: testFiles +0 (extended grounding-notices test) · fabrication 0 · DRILL fire (firesSinceDrill≥10 hard-counter) · eval:memory-poisoning PASS · eval:action-log-tamper PASS

WHAT: the scheduled JUDGE-DRILL (firesSinceDrill hit 10). Drilled on a genuine
real fix — the fire-9 EP-2 follow-up (extract the inline ask episode-evidence tag
into a tested `untrustedEpisodeMatch` helper). STEP 1: planted a deliberately
INERT test (shape-only — asserted source/text/score but NOT the security-critical
`trusted:false` bit; proven mutation-blind: dropping trusted:false kept it green).
STEP 2: an independent Opus ④ judge FAILED it with a concrete violation — it ran
the mutation itself, saw the test stay green, named the missing trusted:false +
cue-firing assertions, contrasted the sibling untrustedFeedMatch behavioral test.
STEP 3: rolled back the inert test, shipped the REAL behavioral test (toEqual
trusted:false + untrustedOnlyGroundingNotice fires + trusted-note-clears-it),
mutation-RED proven, re-judged PASS.

WHY: proves the maker≠judge verifier is NOT a rubber-stamp on this fixed-Opus-tier
loop (the compensating control for same-model judging). Also genuinely closes the
EP-2 follow-up (the inline ask tag now a tested pure helper).

REVIEW POINT: the drill is the value here — a real bad-slice → independent FAIL →
rollback → real fix → PASS cycle, recorded for audit. firesSinceDrill reset to 0.

RISK: none net — the only shipped change is the helper extraction (byte-equivalent
to the prior inline tag) + a behavioral test; the inert drill test was rolled back.

## fire 11 · 2026-06-21 · poisoned-source · (see commit)

meta: value-class=hardening(fail-open-close) · pkg=@muse/cli+@muse/agent-core · kind=trust-persistence · verdict=PASS · firesSinceDrill=1

ratchet: testFiles +0 (extended cli + program tests) · fabrication 0 · eval:memory-poisoning PASS · eval:action-log-tamper PASS

WHAT: EP-1b — per-turn trust PERSISTENCE, closing fire-9's fail-OPEN under-mark.
Fire 9's in-memory bridge only covered the live Ink process; a one-shot `muse
chat` turn (the desktop companion's only path) or a RESUMED session under-marked
its episode. Now SessionTurnLine + LastChatLine carry `untrustedOnly?`;
appendLastChatTurn persists it (only when true; redaction intact); both persist
callers wire it (one-shot via runLocalChat→program.ts; Ink/resumed via onCommit);
captureEndOfSessionEpisode ORs the in-memory option with `range.turns.some(assistant
untrustedOnly)` → trusted:false even for prior-process turns.

WHY: completes the episode-provenance defense reliably (fail-CLOSE across all
turn sources, not just the live process). Additive (provenance bit + scrutiny-cue
path only; never changes a grounded verdict).

REVIEW POINT: multi-file (schema + 2 persist callers + capture aggregation); the
back-compat is the subtle part (optional everywhere, legacy lines → trusted,
clean turns byte-identical). EP-1a+EP-1b+EP-2 complete; only EP-3 (chat-surface
recall cue parity) remains. The fire-9 ⑤c merge-to-main is STILL deferred (env
timeout) — retries fire 12 (next ÷3; the timeout hasn't recurred since).

RISK: low — additive, mutation-proven (capture-aggregation + round-trip), Opus ④
PASS, back-compat green across all SessionTurnLine consumers.

## fire 12 · 2026-06-21 · poisoned-source · (see commit)

meta: value-class=hardening · pkg=@muse/recall+@muse/cli · kind=recall-cue-wiring · verdict=PASS · firesSinceDrill=2

ratchet: testFiles +0 (extended commands-recall + chat-finalize tests) · fabrication 0 · eval:memory-poisoning PASS · eval:action-log-tamper PASS · MERGE→MAIN fire (÷3) — also retries the deferred fire-9 merge

WHAT: EP-3 — chat-surface cue parity. RecallHit gains `trusted?`; searchRecall
tags poisoned-episode hits trusted:false (from its existing readEpisodes — single
read); rankRecallCandidates carries the tag; hitsToMatches propagates it → the
chat untrusted-only cue fires when a chat answer rests solely on a poisoned
episode (parity with the ask path's EP-2).

WHY: completes the episode-provenance defense across BOTH grounded surfaces — the
MemoryGraft (arXiv:2512.16962) episode-laundering vector is now closed end-to-end
(write-time tag fires 9/11 → ask cue fire 2 + chat cue fire 12). Additive
(scrutiny-cue only; verdict untouched).

REVIEW POINT: judge traced the full chain (MMR preserves the hit object, bit not
stripped); no over-firing (trusted note clears it; clean episodes silent). Two
judge-surfaced RESIDUALS recorded as backlog ◦ (out of scope, larger design):
(1) poisoned NOTES have no provenance bit (the fundamental GROUNDED≠TRUE
note-veracity gap); (2) the cue is advisory, not refusing/down-ranking.

RISK: low — additive, mutation-proven (ranker tag + chat cue), Opus ④ PASS,
back-compat green across all RecallHit consumers.
