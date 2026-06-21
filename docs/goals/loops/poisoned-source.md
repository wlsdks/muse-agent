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
