# Loop journal — competitor-parity (openclaw + hermes → Muse gap-filling)

Theme: study /Users/jinan/ai/openclaw (TS, MIT) + /Users/jinan/ai/hermes-agent (Python, MIT/Apache),
find what Muse LACKS, reimplement the pattern (attributed, no verbatim copy), in BIG chunks per fire.
Tier1 (local commit, no push). Worktree: /tmp/muse-competitor-parity. Slug: competitor-parity.

## Candidate gaps (seed — each fire VERIFIES the gap is real before building; Muse may already have it)
- ◦ Plugin SDK / third-party extension package contract (openclaw plugin-sdk, plugin-package-contract) — Muse has `skills` but not a versioned plugin package system. VERIFY vs packages/skills first.
- ◦ Web-content extraction (openclaw web-content-core) — page → clean readable markdown. Muse has `browser`; check if clean-extraction exists.
- ✓ Context compression — ALREADY-HAVE (dropped-context-summarizer.ts, context-transforms.ts)
- ✓ Model catalog — DONE (fire 1)
- ✓ A2A — ALREADY-HAVE substantial (a2a-message, agent-card, signing, peer-registry, receive-quarantine)

## Fires

## fire 1 · 2026-06-30 · skill v2.0 · fire1
meta: value-class=new-capability · pkg=@muse/model+@muse/cli · kind=catalog+CLI · verdict=PASS · firesSinceDrill=1
ratchet: pkg(model,cli)/kind(new-capability) — fire-0 was docs/chore, this is model+cli (diverse). fabrication 0.
- WHAT: model CAPABILITY catalog — `MODEL_CATALOG` + query fns (byCapability/findCatalogModel/localCatalogModels/byProvider) in @muse/model, + `muse models [--vision|--tools|--local|--provider|--json]` CLI. Big-chunk (catalog + query + CLI + tests).
- WHY (gap): openclaw has model-catalog-core; Muse had per-adapter ModelInfo but NO unified queryable capability index nor a `muse models` command (freshness-guarded: 0 ModelCatalog/byCapability/muse-models hits). Complements `muse setup cloud` — pick a model by capability, offline.
- REVIEW: behavioral tests (query/filter logic, not config assertions) + mutation RED + live CLI (--local --vision → gemma4 only). Reimplemented in Muse's ModelInfo shape, openclaw (MIT) attributed, no verbatim copy.
- RISK: catalog DATA is curated/static (capability values conservative; may lag new models) — the QUERY logic is what's tested. `local` honestly = ollama-only (no cloud mislabeled local).

## fire 2 · 2026-06-30 · skill v2.0 · fire2
meta: value-class=correctness-capability · pkg=@muse/agent-core+@muse/autoconfigure · kind=recall-bugfix · verdict=PASS · firesSinceDrill=2
ratchet: pkg(agent-core,autoconfigure)/kind(recall-bugfix) — fire-0 docs, fire-1 model+cli, fire-2 agent-core/recall (diverse). fabrication 0.
- WHAT: NFC normalization in the recall path — `normalizeForRecall` + `lexicalTokenList` NFC-normalizes; sibling-audited the embed input (embedder-base) to NFC too (one seam, lexical + semantic agree).
- WHY (gap): openclaw has normalization-core; Muse's recall tokeniser did NOT NFC-normalize → a macOS-NFD Korean note never matched an NFC query (REPRODUCED: NFD vs NFC '한국어' → disjoint token sets). The grounding edge silently missed a real KO note + falsely abstained — a CORE-edge correctness bug, high value for a bilingual + macOS product.
- REVIEW: behavioral test (NFD phrase ≡ NFC phrase tokens) + mutation RED + ASCII unchanged + NFC (not NFKC, lossless). test:changed agent-core 1524 + autoconfigure 282 green.
- RISK: NFC is canonical-composition (safe); other raw-string recall comparisons (citation exact-resolve, memory-key match) may still be NFC/NFD-naive — noted as a follow-up sibling (not in this fire's proven scope).

## fire 3 · 2026-06-30 · skill v2.0 · fire3
meta: value-class=correctness-capability · pkg=@muse/memory+@muse/agent-core+@muse/recall · kind=recall-bugfix · verdict=PASS · firesSinceDrill=3
ratchet: pkg(memory,agent-core,recall)/kind(recall-bugfix) — 2nd recall fire (fire-2 sibling completion, NOT new vein); 8-fire ratchet not tripped (4 fires). NEXT fire MUST diversify to a different (pkg,kind). fabrication 0.
- WHAT: NFC sibling-audit completion — fire-2 fixed the lexical tokeniser; this NFC-normalizes the 3 remaining recall-comparison sites: `normalizeMemoryKey` (memory, inlined — below agent-core, cycle), `resolvesExact` (agent-core citation resolution), `normalizeField` (recall conflict). KO recall fix now COMPLETE (lexical + semantic + key + citation + conflict all NFC).
- WHY (gap): a half-done NFC fix is a real risk — some recall paths normalized, others not = inconsistent KO matching. openclaw normalization-core centralizes this; Muse's was scattered + NFC-naive at these 3 sites.
- REVIEW: normalizeMemoryKey NFD≡NFC test + mutation RED + ASCII slug unchanged. resolvesExact/normalizeField call the fire-2-tested normalizeForRecall (primitive covered) + caller regression (memory 393, recall 40 green). memory gained NO agent-core import (acyclic).
- RISK: resolvesExact/normalizeField lack a DIRECT behavioral test (private fns) — covered by the tested primitive + caller suites; a dedicated citation/conflict KO test would be a stronger lock (follow-up).

## fire 4 · 2026-06-30 · skill v2.0 · fire4
meta: value-class=correctness-capability · pkg=@muse/model · kind=tool-call-hardening · verdict=PASS · firesSinceDrill=4
ratchet: pkg(model)/kind(tool-call-hardening) — DIVERSIFIED off the 2 recall fires (fire-2,3) as the journal demanded; model-pkg again (fire-1) but a NEW kind. fabrication 0.
- WHAT: harden `recoverToolArgsJson` — new `repairLooseJson` recovers the JSON malformations a small local model commonly emits (trailing commas, single-quoted objects, unquoted keys, curly/smart quotes), applied only after strict parse fails + RE-PARSED (invalid repair → discarded, never a wrong value).
- WHY (gap): reproduced — gemma4-class models emit these in tool-call args; each unrecovered = a DROPPED tool call = a failed agent action. Tool-calling reliability is the binding constraint on a local model (tool-calling.md). openclaw has a dedicated tool-call-repair package; Muse only handled fenced + brace-matched JSON.
- REVIEW: 8 behavioral tests (each malformation → the right OBJECT) + mutation RED + the SAFETY invariant (apostrophe-in-value preserved; re-parse guard ⇒ never a wrong value, only recover-or-undefined). model + wider suites green.
- RISK: the unquoted-key/single-quote regexes are heuristic — but the re-parse guard bounds the blast radius to "no recovery" (undefined), never a corrupted value. Streaming-level repair (openclaw stream-normalizer) is out of scope (deliberately — Muse uses native tool_calls, not text-streamed JSON).

## fire 5 · 2026-06-30 · skill v2.0 · fire5
meta: value-class=correctness-capability · pkg=@muse/model · kind=tool-call-hardening · verdict=PASS · firesSinceDrill=5
ratchet: pkg(model)/kind(tool-call-hardening) — SAME (pkg,kind) as fire-4 (sibling completion: fire-4=args, fire-5=names). model now 3× (fire-1,4,5); tool-call vein COMPLETE. **NEXT fire MUST diversify to a non-model, non-recall (pkg,kind)** (model+tool-call would hit the 8-fire ratchet soon). fabrication 0.
- WHAT: harden `sanitizeToolCallName` — strip a trailing call-paren `evaluate()`, surrounding quotes `"math_eval"`, an echoed OpenAI-style `functions.` prefix. Sibling of fire-4's arg repair → tool-call MALFORMATION recovery now complete (names + args).
- WHY (gap): each malformed NAME fails to match a registered tool → DROPPED call (same failure as a bad arg). Tool-calling reliability is the local-model binding constraint (tool-calling.md).
- REVIEW: 8 behavioral tests (each malformation → the exact registered name; clean name unchanged; empty→unknown) + mutation RED. No over-strip (a paren-less / mid-string-"functions" name is untouched — regexes are end-anchored). model suite 417 green.
- RISK: heuristic regexes — but bounded: worst case a real malformation isn't recovered (call drops as before), never a wrong name (over-strip guarded by end-anchors + the clean-name test).

## fire 6 · 2026-06-30 · skill v2.0 · NO-SHIP (honest exhaustion)
meta: value-class=assessment · pkg=none · kind=exhaustion · verdict=NO-SHIP · firesSinceDrill=6
ratchet: diversified the SCOUT off model/recall (probed tools, fs — fresh pkgs) per the journal flag; no buildable gap found.
- WHAT: scouted + adversarially probed ~8 areas across fresh packages — resilience, cost-estimation, a2a, web-content, context-compression (createModelDroppedContextSummarizer), tool-arg coercion (coerceScalar, cites arXiv:2509.18847), fs edit (applyEdit: line-block match + escaped-whitespace repair + hints), plugin-equiv (skills + mcp). ALL already-have / mature / correct.
- WHY no-ship: the competitor-parity CAPABILITY vein is exhausted — Muse already has openclaw/hermes' tractable capabilities (often citing the same papers), and the fresh functions I probed are well-hardened. Fabricating an already-have fire would violate the FRESHNESS GUARD. Honest exit per loop ⑥/EXHAUSTION.
- lesson: this theme's REAL value (fires 2,4,5) was CORRECTNESS BUGS in Muse's CORE (KO recall NFC, tool-call malformation), NOT missing capabilities — found by ADVERSARIALLY PROBING a real path, not by capability-scouting. A capability-parity theme on a mature codebase saturates in ~5 fires; the productive successor theme is "core-reliability bug-probing" (probe the real recall/tool/loop paths for correctness bugs), or re-theme entirely. Recommend re-pointing or pausing the loop.

## fire 7 · 2026-06-30 · skill v2.0 · fire7
meta: value-class=correctness-capability · pkg=@muse/agent-core+@muse/memory · kind=recall-bugfix · verdict=PASS · firesSinceDrill=7
ratchet: recall-bugfix 3rd time (fire-2,3,7) — NOT new vein hunting; this VALIDATES fire-6's lesson that bug-PROBING (not capability-scouting) is the productive successor. recall input-form robustness now: NFC (Hangul) + full-width fold (CJK width). 8-fire ratchet not tripped. fabrication 0.
- WHAT: full-width ASCII fold in the recall normalization — `normalizeForRecall` (after NFC) + `normalizeMemoryKey` (inline sibling) fold U+FF01–FF5E (full-width "１２３"/"ＡＢＣ") → half-width. Propagates to tokeniser, embedder, resolvesExact, normalizeField.
- WHY (bug, PROBED not scouted): `lexicalTokens('금액 １２３')` tokenised "１２３" separately from ASCII "123" → a note typed/pasted full-width (common on CJK keyboards) never matched an ASCII query. Same recall-miss CLASS as the NFC bug; the productive bug-probe pattern fire-6 predicted found it.
- REVIEW: behavioral test (full-width ≡ ASCII tokens) + mutation RED + TARGETED fold (NOT NFKC — ligature ﬁ left alone, Hangul/ASCII unchanged, no over-normalization). agent-core + memory suites green.
- lesson(meta): bug-PROBING the core keeps finding real recall-miss bugs after capability-scouting saturated (fire-6) — the loop has effectively self-pivoted to the productive theme. Recommend the human re-point the cron prompt to bug-probing explicitly.

## fire 8 · 2026-06-30 · skill v2.0 · fire8
meta: value-class=correctness-safety · pkg=@muse/agent-core · kind=fabrication-guard-bugfix · verdict=PASS · firesSinceDrill=8
ratchet: NEW kind (fabrication-guard-bugfix) — distinct from recall-bugfix (fire-2,3,7) and tool-call-hardening (fire-4,5); the anti-fabrication ARG guard, a different code path + user impact. 8-fire ratchet not tripped. **firesSinceDrill=8 → fire 10 is the non-deferrable JUDGE-DRILL** (firesSinceDrill≥10). fabrication 0 (verified NOT weakened).
- WHAT: `groundToolArguments` (drops a fabricated optional actuator arg the user never said) compared utterance↔arg tokens WITHOUT normalization. Now normalizes BOTH sites via the shared normalizeForRecall (NFC + full-width): `haystack` (utterance) + `contentTokens` (arg).
- WHY (bug, PROBED): a KO user typing an utterance NFD (macOS) + the model filling the arg NFC → the guard FALSE-DROPPED a REAL location ("회의실") as fabricated → the calendar event silently lost the location the user actually said. The anti-fabrication guard mis-firing AGAINST the user on KO locale. High value (it's the moat's guard, and it was eating real user data).
- REVIEW: 3 behavioral tests (NFD-utterance keeps location; full-width grounds; **genuinely-fabricated arg STILL dropped** = guard not weakened) + mutation RED on BOTH normalization sites (each independently load-bearing, opposite directions) + suite 27 green. fabrication=0 preserved (the drop-the-ungrounded path is intact; normalization only removes FALSE drops).
- RISK: normalization can only make MORE tokens match — bounded by the conservative "any-overlap grounds" design; verified it doesn't open a fabrication hole (a truly absent arg still drops).

## fire 9 · 2026-06-30 · skill v2.0 · fire9
meta: value-class=correctness-safety · pkg=@muse/stores · kind=outbound-recipient-bugfix · verdict=PASS · firesSinceDrill=9
ratchet: NEW pkg (@muse/stores) + NEW kind (outbound-recipient-bugfix) — diversified off agent-core. The KO-normalization systematic sweep now spans 6 packages. 8-fire ratchet not tripped. **fire 10 = non-deferrable JUDGE-DRILL (firesSinceDrill≥10).** fabrication/fail-close 0-weakened.
- WHAT: contact name→recipient resolver compared names `.toLowerCase()` only. New inlined `normalizeName` (NFC + full-width fold; inlined — @muse/stores below agent-core) applied at ALL contact-name sites: findContactByName, resolveContact, matchesExact, matchesPartial, upsertConnection. Email/handle/phone (ASCII identifiers) untouched.
- WHY (bug, PROBED): a KO contact stored NFD (macOS) didn't resolve against an NFC query → `resolveContact` returned `unknown` for an EXISTING person → the OUTBOUND flow couldn't address them by their Korean name (outbound-safety rule 3 recipient resolution dead-ending on a real contact). High value (it's the recipient-resolution seam the send gate depends on).
- REVIEW: 3 behavioral tests (NFD contact resolved with right id; full-width resolves; **genuinely-absent name STILL unknown** = fail-close intact) + mutation RED + exact-over-partial precedence preserved (Bob≠Bobby) + suites green. Targeted fold (not NFKC → won't merge distinct identifiers).
- ratchet-note: the KO-normalization root cause is now swept across recall(2,3,7), full-width(7), fabrication-guard(8), recipient-resolution(9). Remaining un-normalized text-match sites are likely thinning — next probe should check OTHER cores or re-confirm exhaustion.

## fire 10 · 2026-06-30 · skill v2.0 · JUDGE-DRILL + fire10
meta: value-class=test-hardening · pkg=@muse/agent-core · kind=invariant-pinning · verdict=PASS · firesSinceDrill=10→0 (DRILL COMPLETE, reset)
ratchet: NEW kind (invariant-pinning, test-only) — distinct from the bugfix run. fabrication 0.
- JUDGE-DRILL (mandatory at firesSinceDrill≥10, non-deferrable): injected a deliberately bad slice — `normalizeForRecall` switched from "NFC + targeted full-width fold" to full `text.normalize("NFKC")` (a plausible "simplification" that PASSED all 5 existing recall tests). The independent Opus ④b judge correctly **FAILED** it: caught the over-normalization (ﬁle→file, ²→2, ①→1, ㎏→kg merge distinct tokens), reasoned the false-grounding risk across the shared seam (citation resolvesExact + anti-fabrication tool-arg guard + contact resolution → fabrication=0 weakening), spotted the tautological X===X no-op + the lying comment, AND flagged the acceptance as insufficient (no test probes a ligature → no mutation teeth). VERIFIER PROVEN TO FAIL-CLOSE (not a rubber-stamp). Drill rolled back (recall-lexical.ts == HEAD, 0 trace).
- REAL WORK (distilled from the drill's finding): the drill exposed that the "no over-normalization" invariant — load-bearing across 6 consumers of this seam — was UNTESTED. Added regression tests pinning NFC-not-NFKC: ﬁ/ﬂ ligatures, ²/①/㎏ compatibility chars stay DISTINCT from their ASCII expansion; the targeted full-width fold ("１２３"→"123") still works. mutation RED (inject NFKC → ligature test RED) + 8/8 green + lint 0. Now any future NFKC regression is caught by a test, not only an alert judge.
- lesson: a judge-drill is not just a verifier check — its FINDING (the untested invariant) is itself the next fire's work. The drill earned a real hardening.

## fire 11 · 2026-06-30 · skill v2.0 · fire11
meta: value-class=capability-coverage · pkg=@muse/mcp-shared · kind=relative-time-coverage · verdict=PASS · firesSinceDrill=1
ratchet: NEW pkg (@muse/mcp-shared) + NEW kind (relative-time-coverage) — diversified off the normalization-bugfix run into a fresh area (scheduling). fabrication 0.
- WHAT: `resolveKoreanDurationOffset` only parsed Arabic-digit + a narrow unit set, so the NATURAL Korean duration phrasings returned undefined from the calendar/reminder scheduler. Added: (1) pre-normalize spelled-out durations to digit form — 일주일→1주, 이주일→2주, 한 주→1주 … 네 주→4주, plus native day words 하루→1일, 이틀→2일, 사흘→3일, 나흘→4일 (all ^-anchored); (2) "주일" added to the unit alternation (longest-first), same 7-day unit as "주".
- WHY (probe): "일주일 뒤" / "이틀 뒤" / "한 주 뒤" — more natural than "1주 뒤"/"2일 뒤" — all returned undefined, so a user's "일주일 뒤 알림" lost its time. Common scheduling phrasings, unambiguous semantics (일주일 = exactly 7 days).
- REVIEW: 9 tests (each phrase → correct +N days, reference time preserved; digit forms unchanged) + mutation RED + false-match probes (이번 주·일요일·하루종일·삼일·한 시간 unaffected — ^-anchor + the `$`-anchored offset regex protect). test:changed green.
- RISK: sibling gaps remain (Sino day words 삼일/사일, "오는 토요일", "3일 후 오후 3시" offset+time, bare "3시"→03:00 AM default) — noted in backlog, NOT in this fire's scope (the AM/PM default is a policy call, deliberately untouched).

## fire 12 · 2026-06-30 · skill v2.0 · fire12
meta: value-class=correctness-bugfix · pkg=@muse/calendar · kind=recurrence-bugfix · verdict=PASS · firesSinceDrill=2
ratchet: NEW pkg (@muse/calendar) + NEW kind (recurrence-bugfix) — genuinely DIVERSIFIED off the KO-locale run (normalization 2-9, scheduling 11) into non-locale calendar date math. fabrication 0.
- WHAT: `expandRecurringEvent` DAILY/WEEKLY occurrence times used FLAT 86_400_000-ms stepping. New `addLocalDays` (setDate, local-time) preserves the wall-clock hour across DST. MONTHLY/YEARLY already local (addMonthsClamped) — unchanged.
- WHY (bug, PROBED + reproduced): a real day across a DST transition is 23/25h, so a daily 10:00 event DRIFTED to 11:00 after the US spring-forward (Mar 8 2026, America/New_York) — a wrong calendar time silently set. Provider-neutral (CalDAV/ICS sync, any-TZ users); KST itself has no DST so the primary user was unaffected, but the engine was wrong.
- REVIEW: 2 DST tests (daily 10:00 + weekly 09:00 stay put across Mar 8) under a pinned TZ + mutation RED (revert to flat-ms → 11:00) + monthly clamping verified intact (Jan31→Feb28→Mar31 recover) + full calendar suite 160 green (no regression; KST daily/weekly unchanged since setDate==flat-ms with no DST).
- RISK: firstWindowIndex still flat-ms estimates the start index but the loop filters per-occurrence (endMs≥fromMs), so the DST-aware times can't skip/dup an in-window instance. Verified by the judge at a window edge.

## fire 13 · 2026-06-30 · skill v2.0 · fire13
meta: value-class=correctness-bugfix · pkg=@muse/stores · kind=recurrence-bugfix · verdict=PASS · firesSinceDrill=3
ratchet: same kind as fire-12 (recurrence-bugfix) but the SIBLING-AUDIT completion of the DST date-math class — fire-12 fixed calendar, this fixes reminders; @muse/stores. fabrication 0.
- WHAT: `nextReminderOccurrence` advanced DAILY/WEEKLY recurring reminders by FLAT 86_400_000-ms (monthly/yearly already local via addMonthsClamped). New `addLocalDays` (setDate) advances from the ORIGINAL due in a loop until strictly after `from` — DST-safe AND still skips periods missed during daemon downtime (mirrors the monthly branch's loop).
- WHY (bug, sibling of fire-12): a daily 09:00 reminder (rent, medication) drifted to 10:00 after a DST transition. Same class as the calendar recurrence bug; reminders re-arm via this function each time they fire, so every recurrence inherited the drift.
- SIBLING-AUDIT (the DST flat-ms class is now swept): calendar recurrence (fire-12) ✓, reminder recurrence (this) ✓, scheduler `computeNextRunAt` = cron-parser + tz option (already TZ-aware, NOT a sibling) ✓. followup-detector "in N days" uses flat-ms too but is a ONE-SHOT soft signal (debatable "+72h vs same-time") — noted, not fixed.
- REVIEW: 3 DST tests (daily 09:00 + weekly hold their wall-clock across Mar 8; downtime-skip lands Mar 10 09:00 strictly after `from`) + mutation RED (revert to flat-ms) + monthly clamp intact + full @muse/stores suite 395 green (KST daily/weekly == old flat-ms).

## fire 14 · 2026-06-30 · skill v2.0 · fire14
meta: value-class=correctness-bugfix · pkg=@muse/domain-tools+@muse/cli · kind=conflict-detection-bugfix · verdict=PASS · firesSinceDrill=4
ratchet: NEW kind (conflict-detection-bugfix) + new area (calendar OVERLAP, not date-stepping) — diversified off the DST recurrence run into non-temporal calendar logic. fabrication 0.
- WHAT: all-day events (span the whole day) were flagged as conflicting with EVERY timed event that day — false clashes. `detectCalendarConflicts` now EXCLUDES all-day events at the CORE (`ConflictEventLike.allDay?` + the valid-filter), so selectUpcomingConflicts (proactivity) is fixed too; wired allDay through the `conflicts` tool (loopback-calendar) + the daemon lister type; brief auto-fixed (passes CalendarEvent[] with allDay).
- WHY (bug, PROBED): a user with an all-day "휴가"/"Birthday" + a 3pm meeting got "휴가 overlaps your 3pm meeting" — noise. calendar-helpers.ts ALREADY filtered all-day (`existing.filter(e => !e.allDay)`, with a comment explaining the exact issue) — proof the bug was real and the 3 other callers each re-dropped the flag.
- REVIEW: 4 tests (all-day∥timed → 0; two all-day → 0; real timed overlap STILL 1; touching still 0) + mutation RED (remove the filter) + the exclusion keys on the allDay FLAG not midnight times (a midnight-but-timed event stays eligible) + domain-tools 797 + cli daemon 71 green.
- RISK: daemon's production conflictWatchCalendarLister isn't wired yet (test-only); the type now carries allDay so it's forward-correct when wired.
