# Outward Target Map — the loop's self-directed north star

The loop sets and evolves its own direction. A human intervenes
only by direct command. Until then the loop decides what "outward"
means, using its own judgement of what a great personal AI
assistant does.

## North star

Muse is a personal AI assistant in the spirit of JARVIS: it
**proactively speaks first** from real context (schedule, events,
patterns, follow-ups) AND **responds instantly and completely the
moment it is addressed**, running the full agent loop to finish the
task. Two qualities define every outward goal:

- **Proactive** — initiates from real context before being asked.
- **Instantly responsive & complete** — when addressed, answers now
  and carries the task to done end-to-end.

## Current session focus — 2026-05-27 (human-directed)

P0–P21 are delivered (archived in `archive/TARGETS-P0-P21.md`;
their capability ledger in `archive/CAPABILITIES-through-2026-05-27.md`).
Muse's daemons exist but live only inside the `apps/api` server,
env-gated — they do NOT run as a real background process on the
user's Mac. **This session pursues two sanctioned directions, the
loop choosing the highest-value one per iteration: (A) make the
proactive / perception daemons actually RUN on this Mac as one
user-launched process and prove end-to-end a notice really fires
(target P22); (B) apply good capabilities from freely-usable open
research under the guardrails below.**

Every slice is proven by a real, surface-level check (CLI smoke /
integration / `smoke:live`) driving the real code path against a
contract-faithful fake — never a stubbed registry, never a
happy-path-only assertion (`outbound-safety.md`). Proactive notices
go to the user's OWN channel (low-risk path); web-watch is
read-only — no autonomous third-party send.

## Applying open research (human-directed 2026-05-28)

The loop MAY adopt a capability from a paper when ALL hold; when in
doubt, SKIP:

- **Freely usable.** The paper is openly readable AND nothing
  restricts implementing its idea — open method, no patent / licence
  bar on use. A restricted or patent-encumbered technique is out.
- **Local-first.** No new paid dependency, no cloud API key; runs on
  the local Qwen / Ollama; deterministic where it can be.
- **Cited in the CODE.** A one-line WHY comment names the paper + id
  at the implementation site (e.g.
  `// importance-modulated decay (FadeMem, arXiv 2601.18642)`) — an
  allowed WHY comment per `code-style.md` — AND the `CAPABILITIES.md`
  line names it too.
- **Verified, effect measured.** Ships as a normal slice with a
  green surface-level check; where feasible the check MEASURES the
  paper's claimed effect, not just that the code runs. A research
  idea with no runnable check is not delivered.

Sizing (both directions): a slice too large for one ~10-min commit
is DECOMPOSED across iterations — one end-to-end vertical increment
each, per `iteration-loop.md`. Never crammed into one oversized
turn; never half-shipped.

## Active target

**P37 — Perception growth: read-only local connectors (loop-v2 B3).** The
self-learning core (P36) is delivered end-to-end + felt; this axis grows what
Muse can READ to know you — new local, read-only, per-source sources the agent
can ground on and cite (calendar, then tasks/files), verified against MOCK
data, never the user's real ~/.muse. Value-to-creep ranked; each is read-only
(mutators reject) + `local === true` (egressing sources stay out).

- [x] **P37-1 Local `.ics` calendar reader (B3 ②).** A read-only
  `LocalIcsCalendarProvider` reads a user's EXPORTED `.ics` file (no cloud);
  `parseIcsCalendar` reuses the CalDAV VEVENT parser. Wired as the `ics`
  provider in `buildCalendarRegistry`, so `muse ask` grounds on + cites its
  events via the existing event path. Proven by unit tests (parse timed/all-day,
  skip malformed; provider local:true, range-filter, missing→[], mutators
  reject) + a LIVE `muse ask` on a mock `.ics` (cited "[event: Investor sync
  with Foundry @ Zoom]"; honest refusal on a flight not in the file). calendar
  122 / autoconfigure 464 tests + `pnpm lint` 0/0. (946be45a)

- [x] **P37-2 Ambient secret-skip (B3 GATE-FIRST).** The ambient reader injected
  clipboard/selection/notifications verbatim (no secret-skip) — a copied API
  key / `.env` line reached the model context. `renderAmbientContextSection`
  now `redactSecretsInText`-scrubs the content fields before injection (titles
  pass through). Proven by unit tests (a clipboard `sk-proj-…` + a credentialed
  URI redacted; titles + ordinary text intact) + a LIVE render
  (`OPENAI_API_KEY=[redacted-openai-key]`), cited-answer+refusal unaffected.
  agent-core 1236 tests + `pnpm lint` 0/0. Remaining gate-first half: per-source
  consent (default-OFF clipboard/selection flags) — DEFERRED: the ambient
  run-context injection is currently dormant (no production code wires
  `ambientSnapshotProvider`), so consent there would govern a path no user
  hits; revisit when/if the ambient reader is wired live. (2415874a)

- [x] **P37-3 Recurring (RRULE) events in the local .ics reader.** Real
  calendars are mostly recurring meetings, whose base VEVENT (past DTSTART) is
  filtered out of muse ask's now→+7d window — so without expansion a recurring
  event never surfaced. `parseVEvent` captures the RRULE; `expandRecurringEvent`
  expands FREQ=DAILY/WEEKLY (+INTERVAL/COUNT/UNTIL) into in-window instances
  (capped; unsupported RRULE → base event, never fabricated); the provider
  flat-maps it in listEvents. Proven by unit tests (weekly/daily/interval/
  count/until/unsupported/passthrough/provider) + a LIVE muse ask on a
  `FREQ=DAILY` .ics ("next standup … 2026-06-01 … [event: Engineering daily
  standup]"; honest refusal on an uncovered query). calendar 127 tests +
  `pnpm lint` 0/0. Scope: DAILY/WEEKLY only (MONTHLY/BYDAY-list unsupported →
  base event). (8abab988)

- [x] **P37-4 Zero-config `.ics` calendar (drop-the-file discovery).**
  `buildCalendarRegistry` auto-enables the `ics` provider when
  `~/.muse/calendar.ics` exists, so a user just drops their exported calendar
  and `muse ask` grounds + cites it — no `MUSE_CALENDAR_PROVIDERS` needed
  (read-only + local ⇒ safe to auto-enable). Proven by unit tests
  (auto-register when present / not when absent / no duplicate) + a LIVE muse
  ask with NO calendar env set ("board review … June 3rd … [event: …]"; honest
  refusal on an uncovered query). autoconfigure 467 tests + `pnpm lint` 0/0.
  (7a6780b5)

- [x] **P37-5 Contacts as a `muse ask` grounding source (B3 — your address
  book).** "What's Sarah's email?", "how do I reach the plumber?" — questions
  the local model could only answer from the user's own contacts, which `muse
  ask` didn't read. It now pulls MATCHING contacts (query-token overlap on
  name/aliases/email/handle — never the whole book at the small model), injects
  them as a grounding block, and cites each as `[contact: name]` under the same
  code-not-model citation gate (a new `contacts` class in `enforceAnswerCitations`
  strips any `[contact: …]` not in the matched set). `--no-contacts` opts out.
  Proven by unit tests (`contactMatchScore`: matches first-name/alias/handle, 0
  for unrelated/empty, full-name > partial in cli; citation gate keeps a real
  contact, strips an unknown one in agent-core) + a LIVE `muse ask` on qwen3:8b
  against a MOCK contacts.json (HOME-isolated, empty notes, never real ~/.muse):
  "What is Sarah's email?" → "sarah.chen@foundry.io [contact: Sarah Chen]"
  (cited); "Dr. Patel's phone number?" → honest refusal, no fabricated number/
  citation. agent-core 1239 / cli 1630 tests + `pnpm lint` 0/0. A user can now
  ask Muse about their PEOPLE and get a cited answer or an honest "I don't have
  that". (3131ce35)

- [x] **P37-6 Shell-history grounding (B3 — "what was that command?", OPT-IN +
  secret-redacted).** `muse ask --shell` now grounds on the user's shell history
  — a question only their own history can answer. OPT-IN (default OFF, because
  history is sensitive), LOCAL + read-only, and every injected command is
  `redactSecretsInText`-scrubbed before it reaches the model (history holds
  `export TOKEN=…` lines). Matched by query-token overlap (newest-first,
  deduped); cited as `[command: …]` under a new `commands` class in the citation
  gate. `parseShellHistory` handles zsh-extended + plain formats; source is
  `$MUSE_SHELL_HISTORY_FILE` / `$HISTFILE` / `~/.zsh_history`. Proven by unit
  tests (`shell-history.ts`: parse extended/plain/continuation; match overlap,
  empty→[], dedup, cap; citation gate keeps a real command, strips an invented
  one in agent-core) + a LIVE `muse ask --shell` on qwen3:8b (mock history,
  HOME-isolated, empty notes, never real ~/.muse): "docker command to run
  nginx?" → cited "[command: docker run -p 8080:80 --name web nginx:latest]";
  "kubectl scale command?" → honest refusal; the API-key line → grounding
  REDACTED to `[redacted-openai-key]` (real `sk-proj-…` never appeared); NO
  `--shell` → 0 shell lines (opt-in respected). agent-core 1240 / cli 1647 tests
  + `pnpm lint` 0/0. A user can now opt in to ask Muse "what was that command?"
  and get a cited answer (secrets stripped) or an honest refusal. (fc0f3fe1)

- [x] **P37-7 Ad-hoc `--file` grounding (B3 — ask about a file without ingesting
  it).** `muse ask --file <path>` now grounds an answer on a specific file that
  is NOT in the notes corpus — "what's the monthly rent in this lease?" — read
  once, never indexed. Reuses the NOTES citation class: the file's passages are
  lexically ranked against the question (strongest kept up to a char budget so a
  big file can't blow the small model's context) and injected as note-class
  context cited `[from <path>]` under the same code gate (cite token +
  allowedNotes normalise the path identically, so it survives). Works even with
  an empty/no notes index. New exported `selectFilePassages` helper. Proven by
  unit tests (small file → all passages in order; big file → relevant passage in
  + char-budget respected; empty → none) + a LIVE `muse ask --file` on qwen3:8b
  (mock lease file, HOME-isolated, empty notes, never real ~/.muse): "monthly
  rent and when due?" → "$4,200 … 1st of each month [from ../lease-agreement.md]"
  (cited); "landlord's phone number?" → honest refusal, no fabrication. cli 1650
  tests + `pnpm lint` 0/0. (Refusal's trailing `cite as:` parrot is the known
  chat-only streaming limitation — stripped on buffered paths.) A user can now
  ask Muse about ANY file on the fly, cited, without growing their corpus.
  (95dbfd72)

- [x] **P37-8 Contact birthdays are groundable (B3 — coverage gap fix).** A
  contact's stored `birthday` (already used to drive birthday reminders) was NOT
  in the `muse ask` contacts grounding block — so "when is X's birthday?" failed
  even though the data was there. The block now injects a readable birthday
  (`formatContactBirthday`: `MM-DD`/`YYYY-MM-DD` → "March 14"[, year];
  malformed/absent → omitted, never a fabricated date), cited as `[contact:
  name]` under the same gate. Proven by unit tests (`formatContactBirthday`:
  MM-DD, year-present, absent/malformed/out-of-range → undefined) + a LIVE
  `muse ask` on qwen3:8b (mock contacts.json with a birthday, HOME-isolated,
  empty notes, never real ~/.muse): "When is Sarah's birthday?" → "Sarah's
  birthday is March 14 [contact: Sarah Chen]" (cited, + the P35-7 receipt); "When
  is Daniel's birthday?" → honest refusal (and the gate stripped a spurious
  `[feed: …]` the model tried to add). cli 1658 tests + `pnpm lint` 0/0. A user
  can now ask Muse when someone's birthday is and get it cited from their own
  contacts. (5f6d39fd)

- [x] **P37-9 Action-log grounding — "did you send that? / what have you done?"
  (B3 transparency, gate a new surface).** `muse ask` now grounds on Muse's OWN
  audit log of acts taken on the user's behalf (sends, refusals) — the
  transparency surface for an agent that acts, tying the ACT side (email /
  messaging actuators that write the log) to the READ side. Matched by
  query-token overlap on each entry's `what` (newest-first, capped), injected
  with result + detail, cited `[action: …]` under a new `actions` class in the
  citation gate (+ a "🤖 from your action log" P35-7 receipt). Default-on
  (`--no-actions` opts out); it's the user's own local record. Proven by unit
  tests (`selectGroundingActions`: overlap match newest-first, empty→[], cap;
  citation gate keeps a real logged action, strips an invented one in
  agent-core) + a LIVE `muse ask` on qwen3:8b (mock action-log.json,
  HOME-isolated, empty notes, never real ~/.muse): "Did you email Sarah about
  the Q3 budget?" → "Yes, I emailed Sarah … — performed (sent) [action: email to
  sarah@foundry.io: Q3 budget review …]" (cited); "Did you call the bank?" →
  honest "I did not call the bank" (and the gate stripped the model's spurious
  `[reminder: none]/[task: none]`). agent-core 1241 / cli 1661 tests +
  `pnpm lint` 0/0. A user can now ask Muse what it has done on their behalf and
  get a cited answer from the real audit log, or an honest "no". (192db737)

- [x] **P37-10 Omit empty grounding sections from the `muse ask` prompt (HARDEN
  the edge).** With ~10 grounding sources now injected, every turn carried an
  empty "(no pending reminders)" / "(no matching contacts)" block for each
  source the user had nothing in — bloating the small model's context
  (worsening lost-in-the-middle) AND inviting it to parrot a spurious
  "[reminder: none]"-style citation (which the gate then strips, but which still
  flashes on the streaming path). New `groundingSectionLines` includes each
  OPTIONAL source section only when it has content this turn; the NOTES section
  stays always-present (the primary surface). Proven by unit tests (present
  section emitted as header/body/footer/blank; empty omitted entirely; all-empty
  → []; order preserved) + a LIVE `muse ask` on qwen3:8b (mock corpus,
  HOME-isolated, never real ~/.muse): WireGuard MTU still cited "[from
  …vpn-wireguard.md]" (no recall regression); "sister's birthday?" → honest
  refusal with ZERO spurious `[x: none]` citation (the omitted empty sections no
  longer trigger the parrot). cli 1664 tests + `pnpm lint` 0/0. The grounding
  prompt is now tighter for the small model and the spurious-citation surface is
  cut at the source. (this commit)

**P38 — Grounding edge: measure → catch → repair (delivered 2026-06-02,
conversational session — NOT a loop fire).** The edge gained an instrument,
closed its deepest hole, and became constructive. Each verified live on
qwen3:8b and added to `eval:self-improving`.

- [x] **P38-1 `muse doctor --grounding` — scored faithfulness + false-refusal.**
  Turns the `fabrication=0` claim into two numbers a user reads on their own box:
  a bundled held-out corpus (12 answerable / 8 must-refuse / 7 drift) scored
  through the real recall + RGV stack prints faithfulness + false-refusal; the
  same `scoreGroundingEval` (agent-core, rank/verify injected, unit-tested) is the
  `verify-faithfulness-rate` battery (regression gate). false-refusal is loop-v2's
  GUARD-THE-EDGE metric, previously unmeasured. Baseline 0.93 / 0.08 on nomic +
  qwen3:8b; floor 0.84 / 0.25 (one miss below). RAGAS arXiv:2309.15217. (92ed90b5)

- [x] **P38-2 Claim-level value grounding — catch the wrong-value answer.** A
  confident, high-coverage, fully-cited answer asserting a WRONG NUMBER ("MTU
  9000" where the note says 1380) read `grounded` — its single wrong token barely
  dents whole-answer coverage, so the judge never fired (the deepest documented
  hole). `verifyGroundingWithReverify` now escalates a `grounded` answer asserting
  a number absent from the evidence to one judge pass (fail-OPEN; the recall wedge
  inherits it). The faithfulness corpus gained 2 wrong-value cases that WITHOUT
  this drop faithfulness to 0.80 < the 0.84 floor — so the metric now GUARDS the
  fix. `verify-claim-grounding` battery. Self-RAG arXiv:2310.11511 / Chain-of-Note
  arXiv:2311.09210. (ace7db9b)

- [x] **P38-3 `muse ask --repair` — attributed self-repair (constructive).** The
  edge only WARNED on an ungrounded answer; `--repair` rewrites it constrained to
  the retrieved evidence and shows it as "Corrected from your notes" ONLY if the
  rewrite re-verifies grounded through the same gate (so a wrong value can't
  survive into the fix). Fail-closed — a refusing / ungrounded / no-evidence
  rewrite leaves the honest refusal standing; a fix is never fabricated. Pure
  `repairToEvidence` (agent-core, 8 unit tests) + `--repair` flag +
  `verify-attributed-repair` battery (live: "MTU 9000" → "MTU 1380",
  off-corpus → refused). RARR arXiv:2210.08726. (e83e506f)

- [x] **P38-4 Adaptive confidence calibration — margin-aware retrieval gate.** A
  single absolute cosine bar is fragile near nomic's compressed floor: an
  out-of-corpus query ("how much did I spend on groceries last month?") clipped a
  near-miss note at 0.563 > 0.55 and the gate said `confident` — inviting a
  false-confident answer. `classifyRetrievalConfidence` now demotes a `confident`
  top that is BOTH borderline (within 0.05 of the floor) AND flat (top−runner-up
  < 0.08) to `ambiguous` — the off-corpus near-miss signature — while a clearly-
  high top or a clear lead stays confident, so genuine single-note matches are
  untouched. Calibrated from the live margins (only the flat near-miss flips; the
  lowest confident answerable sits at 0.627 with a 0.18 gap, far from the band).
  Proof: 4 margin unit tests in `knowledge-recall-agent.test.ts` + the LIVE
  `verify-faithfulness-rate` battery, where the groceries case is now caught and
  faithfulness rose 0.93 → 1.00 (15/15) with false-refusal UNCHANGED at 0.08, and
  cited-recall / rubric-gate / proactive-recall-gate all still green (no genuine
  match demoted). CRAG arXiv:2401.15884. (15396269)

- [x] **P38-5 Claim-level value grounding extends to NAMED ENTITIES.** P38-2 caught
  a wrong NUMBER ("MTU 9000" vs 1380); a wrong NAME ("your landlord is Mr. Lee"
  where the note says "Mr. Park") slipped — same hole, no digit. The value
  escalation now also flags a capitalized named entity (≥3 letters, month/day
  names + stopwords excluded) absent from the evidence and escalates that
  `grounded` answer to one judge pass — FAIL-OPEN like P38-2, so a false flag only
  costs a judge pass that upholds a correct answer, never a refusal. Proof: 3 new
  unit tests in `knowledge-recall-reverify.test.ts` (wrong name → demoted; correct
  name → no escalation; a month name in a correct date answer → not escalated) +
  the LIVE `verify-claim-grounding` battery (the real qwen judge rejects "Mr. Lee",
  upholds "Mr. Park") and `verify-faithfulness-rate`, where a wrong-name drift case
  is now caught (faithfulness 1.00, 16/16) with false-refusal UNCHANGED at 0.08 (no
  answerable falsely escalated). Self-RAG arXiv:2310.11511. (80797e75)

- [x] **P38-6 Kill the false "treat as unverified" warning on a CORRECT cited
  answer (GUARD-THE-EDGE fix).** A real on-disk note resolves to an ABSOLUTE
  path, but the model is shown — and cites — the relative name ("q3.md"). The
  citation gate relativized its allow-list, so the citation survived; but the
  grounding VERDICT validated the answer against the RAW absolute path, so
  `citationValidity` failed and a perfectly correct cited answer ("Jin owns the
  deck, Mina owns pricing [from q3.md]") got "⚠️ treat as unverified". A false
  refusal makes honest into useless. The test corpora all use short relative
  source names, so the batteries never hit it — it only bit REAL users with
  notes on disk. New single source of truth `relativizeNoteSource` now feeds the
  gate, the verdict, AND the receipt the same form. Proof: 3 unit tests
  (`commands-ask-verdict-source.test.ts`: absolute → relative basename; nested →
  relative subpath; already-relative untouched; never returns absolute) + a LIVE
  before/after `muse ask` over a real on-disk corpus (the multi-fact Q3 answer
  loses the spurious warning, keeps its 📎 receipt) + `verify-cited-recall` still
  green. cli 1689 + `pnpm lint` 0/0. (4fda415d)

- [x] **P38-7 Unbreak `muse ask --with-tools` — Muse's own prompt no longer
  self-trips the injection guard.** The agent path ran the injection-input-guard
  over the WHOLE composed prompt (system role included), and Muse's own citation
  instruction — "copy an existing `cite as:` token, or a name shown in a marker"
  — matched the `credential_extraction` pattern ("token … shown"), so EVERY
  grounded `--with-tools` query died with "(error: Input guard detected injection
  patterns: credential_extraction)". A benign "what MTU for the office VPN?" was
  blocked by Muse guarding against Muse. Fixed by extracting the citation lines
  to `CITATION_INSTRUCTION_LINES` and saying "tag", never "token" — no credential
  word in the prompt, no security pattern touched. Proof: 2 unit tests (the lines
  carry no credential word; still instruct verbatim citation) + a LIVE
  before/after `muse ask --with-tools "what MTU for the office VPN?"` (was the
  injection error, now a cited answer + 📎 receipt). cli 1691 + `pnpm lint` 0/0.
  FOLLOW-UP (deferred, security-reviewed): the guard scanning the user's OWN
  trusted notes/system-prompt for injection still false-positives on a note that
  legitimately mentions credentials — needs a trusted/untrusted-content split.
  (this commit)

**P39 — Felt: a social prompt gets an instant clean reply (loop-v2 PART A1 +
tool-calling.md).** Edge hygiene meets felt responsiveness.

- [x] **P39-1 `muse ask "hi"` no longer runs the grounding machinery on a
  greeting.** A bare "hi" / "thanks" / "bye" produced the empty-corpus on-ramp
  (4 lines), a model-fabricated `[action: greeted user]` citation the gate then
  stripped (flashing a "Removed 1 citation" warning), AND a "⚠️ Grounding check:
  treat as unverified" warning — on the word "Hello!". A new precision-first
  `classifyCasualPrompt` (agent-core, EN+KO, anchored so "hi, what's my rent?"
  never matches) short-circuits a PURE social prompt to one clean conversational
  line — no retrieval, no on-ramp, no citation gate, no verdict warning, no model
  call (the fastest path in the CLI). Proof: 6 classifier unit tests
  (`casual-prompt.test.ts`: greetings/thanks/farewells EN+KO match; a real
  question that opens with a social word does NOT; the 30-char content guard) + 2
  cli response-map guards (no citation token can re-enter) + a LIVE `muse ask
  "hi"` (one clean line; "hi, what is my MTU?" still flows through the grounded
  path). agent-core 1349 / cli 1685 + `pnpm lint` 0/0. tool-calling.md ("don't
  invoke the retrieval machinery on a greeting"). (19aefb91)

- [x] **P39-2 `muse ask "what can you do?"` answers honestly about MUSE, not a
  hallucinated over-claim.** A meta/capability question ran retrieval and made
  the local model free-compose an aspirational answer ("I can manage your
  schedule, set reminders, handle tasks…" — things Muse does NOT autonomously
  do) that then got a "treat as unverified" grounding warning — Muse lying about
  its OWN capabilities, the same honesty failure the edge forbids about recall.
  A new anchored `classifyMetaPrompt` (agent-core, EN+KO; "what can you do about
  my taxes?" / "who are the attendees" never match) short-circuits a
  self-referential question to a fixed ACCURATE description — cited recall,
  honest "I'm not sure", local-only, how to add notes — no model freelancing.
  Proof: 2 classifier unit tests (capability/identity/usage EN+KO match; a notes
  question containing a meta word does NOT) + a cli guard that META_RESPONSE
  states the real value prop and never says "manage your schedule" + a LIVE
  `muse ask "what can you do?"` / `"넌 뭐야?"` (accurate line, no warning) while
  `"what can you do about my taxes?"` still flows to the grounded path.
  agent-core 1351 / cli 1686 + `pnpm lint` 0/0. (fe6a4f4c)

**P36 — Background self-learning, brake-and-proof-first (loop-v2 PART A2 /
B1).** The headline's "grows-with-you" core: Muse learns from corrections
while idle, on its own, without straining the laptop. Built brake-FIRST — the
resource gates land before any unattended LLM writer. Verified by the rung-4
proof shape (unit / 2-session / eval:self-improving), NOT cited-answer+refusal.

- [x] **P36-1 Real OS-idle brake (B1 Slice 0 prerequisite).** The consolidate
  daemon gated only on Muse-/api activity (`lastActivityMs`), which reports
  idle exactly when the laptop is busy in another app. New `os-idle.ts` reads
  the real system-wide HID idle (`ioreg` `HIDIdleTime`), fail-closed; the LLM
  merge now ALSO requires the MACHINE idle ≥ threshold (opt-in seam, wired in
  the daemon) so it never strains the laptop while the user works elsewhere.
  Proven by unit tests (parse / fail-closed / brake predicate / tick gate:
  OS-busy or unknown → no merge; both idle → merge) + a LIVE probe on this
  macOS box (osIdleMs ≈ 10632s from real ioreg); api 756 tests + `pnpm lint`
  0/0. Brake-first INFRA — felt payoff lands with the writer slice (Slice 1).
  (770beaf1)

- [x] **P36-2 Model-resident brake (B1 Slice 0, 2nd prerequisite).** The
  daemon must never COLD-load the multi-GB model in the background. New
  `model-resident.ts` reads Ollama `/api/ps`; the LLM merge now runs only when
  the model is already loaded (fail-closed: Ollama-down/absent → defer), wired
  via an opt-in seam + the daemon. So learning fires only when OS-idle AND
  model-warm. Proven by unit tests (parse / prefix+tag match / fail-closed
  live probe) + consolidate-tick gate (not resident → no merge; resident +
  idle → merge) + a LIVE `/api/ps` probe on this box (correctly returns false
  → defers when nothing loaded); api 774 tests + `pnpm lint` 0/0. Brake-first
  INFRA. Remaining Slice-0 brake: the cross-process Ollama lease. (81d29264)

- [x] **P36-3 AC-power brake (B1 Slice 0, 3rd brake).** A heavy LLM merge must
  not drain the battery. New `power-state.ts` reads `pmset -g batt`; the merge
  now runs only on confirmed AC (battery/unknown ⇒ skip, fail-closed), wired
  via an opt-in seam + the daemon. Net gate: OS-idle AND model-warm AND on-AC.
  Proven by unit tests (parse / fail-closed / AC-only predicate) +
  consolidate-tick gate (battery or unknown → no merge; idle + AC → merge) +
  a LIVE `pmset` probe on this box (reads 'AC Power' → true). api 791 tests +
  `pnpm lint` 0/0. Brake-first INFRA. Remaining Slice-0 brake: the
  cross-process Ollama lease (cross-package). (71473fba)

- [x] **P36-4 Cross-process Ollama lease — COMPLETES B1 Slice 0.** Foreground
  chat/ask and the daemon no longer contend for the local model. New shared
  `ollama-lease.ts` (pid+heartbeat, fail-safe, dead-pid/stale auto-release);
  `muse ask` holds it while streaming, the daemon defers its merge while a
  live foreground lease is held. Net gate: OS-idle AND model-warm AND on-AC
  AND no-foreground-contention. Proven by unit tests (held-by-other/self/
  dead/stale; owner-only release) + consolidate-tick gate + a LIVE lease
  round-trip AND a live `muse ask` (cited "MTU 1380" + receipt, honest
  refusal — recall intact under the lease). mcp 1211 / api 801 / cli 1605
  tests + `pnpm lint` 0/0. Slice 0 (brakes) DONE → the idle-distillation
  writer (Slice 1, felt payoff) is unblocked. (7e9ac3e6)

- [x] **P36-5 Learn-queue signal substrate (B1 Slice 1, part 1).** Episodes
  keep only summaries, so the raw correction exchange must be captured when it
  happens and consumed on idle. New shared `learn-queue.ts` (append-only
  `~/.muse/learn-queue.jsonl`: enqueue / readPending oldest-first / markDone
  atomic-remove + cap; corrupt-line-safe). Proven by unit tests + a LIVE
  round-trip (enqueue → read → markDone → empty). mcp 1216 tests + `pnpm lint`
  0/0. SUBSTRATE only — remaining Slice-1 parts: the idle distill-consumer tick
  (distill behind the brakes → probation strategy), the chat producer (enqueue
  on correction), and `muse learned` visibility. (85e87e0e)

- [x] **P36-6 Idle distill-consumer (B1 Slice 1, part 2 — felt mechanism).**
  `distillQueuedCorrections` reads the learn-queue, distills ONE correction per
  tick via the existing distiller, records a strategy to the playbook, and
  marks events done — wired as an idle REM phase behind ALL the brakes. Grounding
  fence: empty correction / distiller-returns-nothing → zero strategies (still
  drained). Proven by unit tests (distill+record+drain; ≤1/tick; fence; gate
  wiring) + a LIVE round-trip on qwen3:8b: enqueued "give me bullet points, not
  prose" → playbook gained "when asked for a summary, present information in
  bullet points rather than prose", queue drained. mcp 1216 / api 809 tests +
  `pnpm lint` 0/0. Felt MECHANISM done; remaining Slice-1: chat producer
  (auto-enqueue), probation (record-but-don't-inject), `muse learned`
  visibility, then the 2-session proof. (3fe8876b)

- [x] **P36-7 Chat producer — the idle self-learning loop closes end-to-end.**
  At REPL exit, `enqueueSessionCorrections` enqueues this session's detected
  corrections onto the learn-queue (gated by `MUSE_IDLE_LEARNING_ENABLED`,
  mutually exclusive with the exit-distill → no double-distill; fail-soft). The
  idle daemon distills them behind the brakes. Proven by unit tests (detect→
  enqueue; no-correction→0; read-error→0) + a LIVE FULL-CHAIN on qwen3:8b: a
  session correction → producer enqueued → idle consumer distilled → next
  session the playbook holds the learned strategy, no manual step — effectively
  the B1 2-session proof, live. cli 1608 / api 809 tests + `pnpm lint` 0/0. The
  felt LOOP works; remaining polish = probation (record-but-don't-inject) +
  `muse learned` visibility of idle-distilled strategies. (93d32a9b)

- [x] **P36-8 Probation — unattended learning can't silently steer the agent.**
  An idle-distilled strategy is recorded + visible but NEVER injected until a
  real reinforce graduates it (the self-confirmation safety gate, B1 §5).
  `PlaybookStrategy`/`PlaybookEntry` gain `probation`; `rankPlaybookStrategies`
  excludes it from injection; `adjustPlaybookReward` clears it on net-positive
  reward; the idle consumer records `probation:true`. Proven by unit tests
  (excluded while on probation / injected once graduated; persistence +
  graduation) + a LIVE gate on qwen3:8b (distilled → injected 0 on probation →
  +1 reinforce → injected 1), with cited-answer+refusal unaffected (no recall
  regression). agent-core 1234 / mcp 1218 / api 815 tests + `pnpm lint` 0/0.
  Idle self-learning is now SAFE to enable; remaining polish = `muse learned`
  shows the probation flag. (a666476c)

- [x] **P36-9 `muse learned` shows idle/probation learning (visible + felt).**
  Idle-distilled strategies now render under "Learning while idle (on probation
  — recorded, NOT yet applied until you reinforce it)", excluded from
  trusted/avoided; a graduated one moves to Trusted. So the user SEES the
  unattended learning + that it's held back (legibility precondition to
  trusting it). Proven by unit tests (probation section; not double-listed;
  renders alone) + a LIVE full chain on qwen3:8b (correction → idle distill →
  `muse learned` prints the ⟨probation⟩ strategy), cited-answer+refusal
  unaffected. cli 1610 tests + `pnpm lint` 0/0. The idle self-learning loop is
  now FELT + VISIBLE end-to-end (correction → idle distill → probation → seen
  in `muse learned` → reinforce to graduate). (c569bcc2)

- [x] **P36-10 Session-start "you FEEL it next session" notice.** On opening a
  continuing chat, Muse leads with "💡 I learned N things while you were away
  (on probation) — review with `muse learned`." when the idle daemon distilled
  corrections since last time. Deterministic (counts real probation entries,
  no model call), fail-soft, silent when nothing. Proven by unit tests
  (singular/plural/0; counts only probation) + a LIVE full chain on qwen3:8b
  (correction → idle distill → the exact opener notice string),
  cited-answer+refusal unaffected. cli 1613 tests + `pnpm lint` 0/0. The
  grows-with-you loop is now FELT at the moment of return. (a7fcf36b)

- [x] **P36-11 Disuse-decay — learned strategies FADE when you stop reinforcing
  them (B1 Slice 2).** A one-off thumbs-up could steer the agent forever; now a
  positive-reward strategy left unreinforced past 30 days loses reward toward
  NEUTRAL 0 on the idle daemon (clamped at 0 — disuse fades trust, never
  punishes; only a real correction drives a strategy negative), so it sinks out
  of the injected `[Learned Strategies]` block on its own. `muse learned` shows
  the trajectory ("↓ fading (last reinforced Nd ago)") a few days BEFORE the
  reward actually drops, so the user SEES it losing trust. `adjustPlaybookReward`
  now stamps `lastReinforcedAt` on a positive reinforce only; new
  `decayStalePlaybookRewards` (mcp) runs as an idle RL phase in the consolidate
  tick behind ALL the brakes (cheap + local, no LLM). Proven by unit tests
  (decay one step toward 0, clamps at neutral, fresh/neutral/negative/probation
  untouched, createdAt fallback; lastReinforcedAt stamped on reinforce not on
  penalty; tick fires decay only when idle/unbraked) + a LIVE end-to-end run on
  this box: a stale +2 strategy decayed +2→+1→0 across ticks (a fresh +3 left
  untouched; a 2nd tick at 0 decayed nothing) and LEFT the `muse learned`
  Trusted list, while the fresh one stayed. mcp 1222 / api 816 / cli 1615 tests
  + `pnpm lint` 0/0. The grows-with-you loop now self-corrects in BOTH
  directions — it learns AND it forgets stale trust. (45db000f)

- [x] **P36-12 Reward-/recency-weighted eviction — a reinforced strategy isn't
  forgotten just for being old (B1 Slice 3).** When the playbook overflows its
  100-entry cap, eviction was blind FIFO: it dropped the OLDEST regardless of
  value, so a strategy you reinforced ten times could be evicted while a
  never-used newer one survived — exactly backwards. New `retainPlaybookEntries`
  keeps the highest-value entries (value = reward, then recency): a high-reward
  OLD strategy beats a low-reward NEW one, ties break toward the newer, and
  negative/avoided entries are evicted first; survivors keep their insertion
  order (the recency proxy ranking relies on). Proven by unit tests (at/under cap
  unchanged; high-reward-old kept over low-reward-new; reward-tie→recency;
  avoided evicted first; record-path overflow keeps a champion) + a LIVE
  end-to-end run (HOME-isolated, never real ~/.muse): a `+5` champion recorded
  FIRST then buried under 120 newer neutral records survived the cap, and
  `muse playbook list` shows `[champion] ⟨reward +5⟩` still present (count capped
  at 100). mcp 1227 tests + `pnpm lint` 0/0. The bank now keeps what you've
  proven matters. (37cf8509)

- [x] **P36-13 Provenance — `muse learned` shows the WHY behind each strategy
  (B1 Slice 4).** A learned strategy was just a sentence; now each carries its
  ORIGIN (`grounded` = distilled from a real correction, `reflected` = synthetic,
  `manual`) + the `source` correction that taught it, so `muse learned` shows
  "↳ learned from your correction: '<the exact thing you said>'" under trusted
  AND probation strategies — the legibility precondition to trusting unattended
  learning. Both correction-distill writers (idle daemon + chat-exit) stamp
  `origin: "grounded"` + the correction; a small ranking tie-break makes a
  `reflected` strategy never outrank an otherwise-equal grounded one (evidence >
  synthesis at a dead heat). Proven by unit tests (origin/source round-trip +
  validation in mcp; grounded outranks equal reflected, penalty is tie-break-only
  in agent-core; digest renders the why for grounded, flags reflected synthetic,
  truncates long source, omits the line for legacy/manual in cli) + a LIVE full
  chain on qwen3:8b (HOME-isolated, never real ~/.muse): enqueue "no, that is not
  what I meant — give me bullet points, not prose" → idle distill → `muse learned`
  prints the probation strategy WITH "↳ learned from your correction: '<that
  correction>'". agent-core 1238 / mcp 1229 / api 817 / cli 1618 tests +
  `pnpm lint` 0/0. The user can now SEE why Muse believes each thing. (74f32db4)

- [x] **P36-14 Undo that TEACHES — `muse playbook undo` makes Muse forget AND
  not re-learn it (B1 Slice 5, undo half; `--pause` deferred).** Plain `remove`
  just deletes a strategy — the idle distiller happily re-learns it the next
  time you give a similar correction. New `muse playbook undo <id>` removes the
  strategy AND records a suppressed-lesson veto keyed on its SOURCE correction
  (provenance from P36-13), so the idle distiller skips that signal BEFORE the
  LLM call and bumps the veto's blocked counter. Matching the stable correction
  (not the LLM's run-to-run paraphrase) is what makes it actually stick — a flaw
  the live test caught and drove the redesign. New `suppressed-lessons.json`
  store (mcp) + `resolveSuppressedLessonsFile` (autoconfigure); the idle
  distiller (api) consults it. Proven by unit tests (store round-trip incl.
  source + cap + blocked-counter in mcp; distiller skips a matching correction
  before distilling, bumps the counter, a different correction still distills,
  no-source can't block, back-compat without the file in api; `undo` removes +
  records the veto with source in cli) + a LIVE full chain on qwen3:8b
  (HOME-isolated, never real ~/.muse): correction → distilled → `undo` → SAME
  correction re-enqueued distilled **0** (blockedCount 1) while a DIFFERENT
  correction still learned. mcp 1234 / api 823 / cli 1619 tests + `pnpm lint`
  0/0. The user is now in control of what Muse keeps learning. (0a623383)

- [x] **P36-15 Pause switch — `muse playbook pause` stops ALL background
  learning (B1 Slice 5 complete, the kill-switch half).** A persisted pause flag
  (not an env var, so a running daemon honors it without restart): when paused,
  the idle distiller writes ZERO strategies AND the session producer enqueues
  ZERO corrections — a TRUE pause that doesn't even accumulate to learn later;
  the queue already present is left intact so a later `resume` catches up.
  `muse learned` shows a "⏸ Background learning is PAUSED" banner so the state is
  legible. New `learning-pause-store.ts` (mcp, fail-OPEN on corrupt so it can't
  silently wedge learning off) + `resolveLearningPauseFile` (autoconfigure);
  consumer (`distill-queue.ts`) + producer (`chat-enqueue-corrections.ts`) both
  honor it. Proven by unit tests (round-trip paused+since / resume / fail-open on
  corrupt / non-true value in mcp; distiller PAUSED ⇒ 0 writes + queue intact +
  resume catches up in api; pause persists / resume clears in cli; `muse learned`
  PAUSED banner incl. empty corpus) + a LIVE chain on qwen3:8b (HOME-isolated,
  never real ~/.muse): `pause` → enqueue + idle distill = **0 distilled, queue
  pending 1**, `muse learned` shows the ⏸ banner → `resume` → distill = 1, queue
  drained. mcp 1238 / api 824 / cli 1621 tests + `pnpm lint` 0/0. Slice 5 is now
  complete (undo + pause); the user can fully stop and steer learning. (ebaeb566)

- [x] **P36-16 Autonomy is verifiable — `muse doctor` reports the learning state
  (B1 Slice 7).** Background learning was invisible: a user couldn't tell whether
  it was actually running. `muse doctor` now reports a `self-learning` check that
  resolves and explains the real state — OFF (default, with how to enable) / ON
  but daemon-not-installed (warn → `muse daemon --install`) / ON + installed
  ("will run while idle") / PAUSED (warn → `muse playbook resume`). The
  LaunchAgent plist now also sets `ProcessType=Background` so macOS throttles the
  resident daemon under contention — the OS-level complement to the brake-first
  idle gates (StartInterval intentionally omitted: it conflicts with the
  KeepAlive-resident model). Proven by unit tests (`selfLearningCheck` all four
  states in cli; plist contains `ProcessType`/`Background` + still plutil-valid)
  + a LIVE `muse doctor --local` (HOME-isolated, never real ~/.muse) showing each
  state's exact line: OFF default ✓, ON-not-installed → `muse daemon --install`,
  ON+installed "will run while idle", paused → `muse playbook resume`. cli 1625
  tests + `pnpm lint` 0/0. The user can now VERIFY whether Muse is set up to learn
  while idle. (3922b411)

**P35 — Felt experience: make Muse FEEL like the SF confidant (loop-v2 PART
B2).** The front door (P34) is delivered + proven; the headline's other half
is the *felt* quality — recall that reads like a memory, honest refusals that
offer a hand, growth you can sense — built ONLY under the B2 guardrails
(honesty never traded for feel; felt framing is deterministic code, never a
second model call). Verified live on local Qwen via the same cited-answer +
honest-refusal mock-corpus check where applicable.

- [x] **P35-1 Citation-as-voice (B2 S1, build-first).** `muse ask` renders
  each cited note as a memory — "📎 From your notes … • from your note of
  <date> — '<verbatim snippet>'" + the openable path — instead of a bare
  filename, by pure deterministic code (`formatSourceReceipts`: date from the
  filename + a verbatim chunk excerpt, no second model call, gate untouched,
  post-gate so a refusal renders no receipt). Proven LIVE on qwen3:8b: the
  WireGuard answer shows the dated memory receipt + path; the sister's-birthday
  refusal shows none; `commands-ask-receipts.test.ts` + `pnpm lint` 0/0.
  (c7297ad3)

- [x] **P35-2 Citation-as-voice quotes content, never a heading.** P35-1's
  receipt excerpted the chunk's opening, which on a `# Heading`-led note read
  robotically. `relevantSnippet` now drops markdown headings and picks the
  highest query-overlap content line (reusing the recall lexical primitives),
  so the receipt quotes a sentence the user actually wrote. Proven LIVE on
  qwen3:8b: the WireGuard answer's receipt quotes a content sentence (not "#
  WireGuard VPN setup"); the refusal shows none; `commands-ask-receipts.test.ts`
  + `pnpm lint` 0/0. (8d23b182)

- [x] **P35-3 Narrate the wait (B2 S3).** On a 10–40s local model the
  pre-answer gap reads as a hang. `muse ask` now emits two REAL stage deltas —
  "🔎 searching your notes…" and "💭 generating your answer on the local
  model…" — bracketing the existing grounded banner, suppressed under --json,
  inventing no step (latency-honest). Answer/gate/receipt/refusal untouched.
  Proven LIVE on qwen3:8b: both deltas appear before the cited "MTU 1380"
  answer and before the honest sister's-birthday refusal; cli suite green (no
  regression) + `pnpm lint` 0/0. (5d9eef98)

- [x] **P35-4 Warm honesty (B2 S2).** An honest refusal now closes with one
  on-brand deterministic line "(I'd rather tell you that than guess — add a
  note on this and I'll have it next time.)" when the user HAS notes (empty
  corpus → on-ramp hint instead; cited answer → nothing). No note pointer, so
  no P34-11 regression; `shouldWarmClose` (refusal AND notes>0) is pure +
  tested. Proven LIVE on qwen3:8b: the sister's-birthday + car must-refuses get
  the warm close, the MTU answer does not; `commands-ask-refusal.test.ts` +
  `pnpm lint` 0/0. (a58a1712)

- [x] **P35-5 "I learned this about you" beat (B2 S6).** When `muse ask` injects
  a learned playbook strategy that is genuinely RELEVANT to the question (token
  overlap — a recency-floor pick never triggers it) and the answer is NOT a
  refusal, it now closes with a deterministic grounded beat: `💡 Applied a
  preference you taught me: "<strategy>". (Not right? \`muse playbook undo\`.)` —
  so the user FEELS Muse growing with them, and the beat is wired to the P36-14
  reversal. Honesty-safe per B2: no second model call (fixed template over the
  strategy already injected), grounded in the user's OWN taught preference,
  suppressed on a refusal (which applied nothing) and when the top strategy
  doesn't overlap the question. Converges with `muse learned`. Proven by unit
  tests (`topAppliedStrategy`: top injectable for a relevant Q, matches the head
  of the injected block, undefined for empty/probation/avoided) + a LIVE
  `muse ask` on qwen3:8b (mock corpus + a seeded wireguard preference,
  HOME-isolated, never real ~/.muse): the WireGuard MTU answer is cited "[from
  2026-03-03-vpn-wireguard.md]" AND shows the beat naming the preference; the
  sister's-birthday must-refuse honestly refuses with NO beat. cli 1633 tests +
  `pnpm lint` 0/0. (6f77e33a)

- [x] **P35-6 "What you've been focused on" beat (B2 S7, pull surface).** `muse
  today` now surfaces the note FAMILY the user has been editing most this week —
  "🔭 You've been focused on <family> lately — N notes edited in the last week."
  — a grounded felt "Muse noticed" moment. The ONLY signal is note *mtime*
  (writes), never opens/reads, so it's honest ("edited", not "looked at"); a
  quiet week yields NO line. Done as a PULL surface (in `muse today`, which the
  user asked for) so it needs no proactive-interrupt budget — the clean tracer
  of the push-notice S7. New pure `selectNoteFocus`/`formatNoteFocusSection`
  (`note-focus.ts`); `muse today` gathers mtimes via the existing notes walk,
  fail-soft + `--json`-skipped, composed alongside the existing revisit/stale-
  task/connection sections. Proven by unit tests (most-edited family wins; quiet
  week → silent; out-of-window/future/NaN mtimes ignored; count-tie → most-recent;
  root notes → "your notes"; honest "edited" wording, never "looked at") + a LIVE
  `muse today --local` (HOME-isolated, generated cluster, never real ~/.muse): 4
  recent edits in projects/ → "🔭 You've been focused on projects lately — 4
  notes edited in the last week"; a lone note → silent. cli 1641 tests +
  `pnpm lint` 0/0. A user opening `muse today` now sees what they've been
  working on, grounded in real edits. (88e61d20)

- [x] **P35-7 "Shows its work" receipts for the NON-note sources (B2 S1
  completion).** The felt source receipt (P35-1: "📎 From your notes … from your
  note of <date> — '<quote>'") covered only NOTE citations; a cited calendar
  event / task / reminder / contact / shell command got the inline `[event: …]`
  marker but no followable receipt. New `formatNonNoteReceipts` parses the
  POST-gate answer's `[event|task|reminder|contact|command: …]` markers and
  renders a grouped "📎 Also grounded on:" block (📅 calendar / ✅ tasks / ⏰
  reminders / 👤 contacts / ⌨️ shell), so EVERY cited source is followable, not
  just notes. Deterministic (no model call), skips a source type that wasn't
  grounded this turn, and renders nothing on a refusal (citations already
  stripped). Proven by unit tests (one line per cited non-note source grouped;
  shell receipt; skip-when-unconfigured; none on a refusal; dedup) + a LIVE
  `muse ask` on qwen3:8b (mock contacts, HOME-isolated, never real ~/.muse):
  "Sarah's email?" → cited "[contact: Sarah Chen]" AND "📎 Also grounded on: 👤
  from your contacts: Sarah Chen"; an unknown-person must-refuse → 0 receipt
  lines. cli 1655 tests + `pnpm lint` 0/0. "Shows its work" is now FELT uniformly
  across every grounding source, not just notes. (30346851)

**P34 — The front door (loop-v2 headline: the moat is invisible without
the door).** Per loop-v2 B0 §3, a privacy-bound first-time user must be able
to SEE Muse's edge — a cited answer AND an honest refusal — in seconds, with
zero dev toolchain and no notes ingested yet, BEFORE they invest in getting
their real corpus in. The first rung is a bundled-corpus demo; later rungs are
one-command install (detect/pull Ollama + model), one real ingest format, and
continuous folder-watch ingest. Direction: loop-v2 locked headline (front door
FIRST, then felt self-learning).

- [x] **P34-1 `muse demo` — the zero-setup cited-answer + honest-refusal
  demo.** `muse demo` runs the REAL `muse ask` recall path against a bundled
  sample corpus (shipped in the cli package) inside a throwaway HOME — a
  HOME/USERPROFILE override + the new `MUSE_NOTES_INDEX_FILE` resolver isolate
  every `~/.muse/*` default so the user's real data is never touched — and
  shows ONE answerable question (cited "MTU 1380" + openable 📎 Sources) and
  ONE must-refuse question (honest "I'm not sure", no fabrication). `--top 12`
  injects the whole tiny corpus so the answerable note is never ranked out.
  Proven LIVE on qwen3:8b via the built CLI + `commands-demo.test.ts` +
  autoconfigure tests; `pnpm lint` 0/0. (c325f420)

- [x] **P34-2 Corpus ingest shows progress + tolerates a bad file VISIBLY.**
  The engine already walked `.pdf`/`.txt` and had partial-failure tolerance,
  but the headline `muse ask` path SWALLOWED it: a first ingest was a silent
  hang and a corrupt file was skipped with zero feedback. Now `muse ask`'s
  auto-reindex streams per-file progress (`+ <file> (n chunks embedded)`) and
  the extract-failure path emits `✗ <file> (could not read — skipped:
  <reason>)`, so a beachhead user sees life during a slow first ingest and a
  corrupt/unreadable file is visibly skipped, not fatal. Proven LIVE on
  qwen3:8b against a `.muse-dev` mock corpus (seed notes + a corrupt `.pdf`):
  streamed progress + the ✗ skip line, then a cited "MTU 1380" answer + 📎
  Sources AND an honest refusal; `commands-notes-rag.test.ts` + `pnpm lint`
  0/0. (6652986c)

- [x] **P34-3 Kill the false refusal — hybrid recall on the headline path.**
  At default top-3 `muse ask` false-refused an answerable question because the
  chat-only path ranked notes by PURE embedding cosine, so a query with strong
  keywords ("WireGuard", "MTU") ranked the answer note ~5th and it fell out of
  the top-K (the GUARD-THE-EDGE failure: a false refusal makes "honest" into
  "useless"). The headline path now fuses cosine + lexical keyword ranks via
  RRF (the same hybrid the `knowledge_search` path already used, P23), reusing
  agent-core's lexical primitives, no re-embedding, absolute cosine preserved
  for the confidence framing. Proven LIVE on qwen3:8b at DEFAULT top-3 against
  a `.muse-dev` mock corpus: the WireGuard + rent questions now return cited
  answers (vpn note ranked FIRST) while the sister's-birthday question still
  honestly refuses; `commands-ask-mmr.test.ts` + `pnpm lint` 0/0. (faa905b4)

- [x] **P34-4 No false LOW-confidence caution on a correct cited answer.**
  The CRAG framing flagged a correctly-grounded answer "⚠ LOW confidence —
  verify, may not be in your notes" whenever the top match's absolute cosine
  sat below threshold (nomic compresses cosine), undercutting trust in an
  answer that IS grounded — a soft false-refusal. The framing now considers
  lexical strength: a strong keyword match (≥2 distinct query content tokens
  in a grounded chunk) upgrades an ambiguous-cosine verdict to confident,
  while a must-refuse question (no shared tokens) stays LOW and the citation
  gate remains the hard backstop (fabrication=0 preserved). Proven LIVE on
  qwen3:8b at default top-3: the WireGuard answer now shows a clean grounding
  line + cited "MTU 1380", while the sister's-birthday question still shows
  LOW confidence and refuses; `commands-ask-crag.test.ts` + `pnpm lint` 0/0.
  (a2dedb48)

- [x] **P34-5 Bulk folder ingest — get a real corpus in, in one command.**
  `muse read <dir> --save-to-notes <prefix>` now ingests every supported
  document (pdf/txt/md/markdown/log/csv) under a directory (recursively) into
  the notes corpus as `.md` notes under the prefix, so a beachhead user with a
  pile of downloads/exports gets them all searchable in ONE command instead of
  one `muse read` per file. Per-file progress + partial-failure tolerance (a
  corrupt file is skipped VISIBLY, not fatal). Bug found+fixed live: notes were
  first saved without a `.md` extension so the index walker skipped them and
  `muse ask` couldn't cite them — the save now appends `.md`. Proven LIVE on
  qwen3:8b against a `.muse-dev` docs folder (a .txt, a nested .md, a corrupt
  .pdf, isolated HOME): "ingested 2, skipped 1", then `muse ask` cited both
  ingested facts (warranty.md, manuals/trip.md) + 📎 Sources and honestly
  refused an uncovered question; `commands-read.test.ts` + `pnpm lint` 0/0.
  (8f142b61)

- [x] **P34-6 Single-file `--save-to-notes` is actually searchable.** The
  single-file `muse read <file> --save-to-notes <id>` path told the user "now
  searchable" but saved a bare extensionless note the notes-index walker
  skipped, so `muse ask` answered "I don't have access" on a just-ingested
  fact (the single-file sibling of P34-5's bug). A shared
  `ensureNoteMarkdownExtension` now guarantees an indexable `.md`/`.markdown`/
  `.txt` extension on both the single-file and bulk paths. Proven LIVE on
  qwen3:8b (isolated HOME): `muse read garage.txt --save-to-notes garage` →
  `garage.md`, and `muse ask` cited "7731 [from garage.md]" (was "I don't have
  access"), while an uncovered question still honestly refused;
  `commands-read.test.ts` + `pnpm lint` 0/0. (c8441e84)

- [x] **P34-7 Continuous folder-watch corpus ingest — the corpus stays live.**
  `muse watch-folder --ingest` now folds each newly-dropped document INTO the
  notes corpus as a citable `.md` note (searchable via `muse ask`) instead of
  firing a proactive notice — the day-2 "stays live without re-running ingest"
  habit, with no manual step. Reuses the `muse read` extract/save contract, so
  a corrupt drop is skipped (✗) without crashing the watcher; the original is
  archived. Proven LIVE on qwen3:8b (isolated HOME): dropped `pool.txt` + a
  corrupt `.pdf` into a watched inbox → ingested `pool.txt → inbox/pool.md`,
  skipped the corrupt one, then `muse ask` cited "4417 [from inbox/pool.md]"
  and honestly refused an uncovered question; `commands-watch-folder.test.ts`
  + `pnpm lint` 0/0. (500e4112)

- [x] **P34-8 Empty-corpus first-run on-ramp.** A brand-new user who runs
  `muse ask` with no notes yet got an honest refusal but no guidance — a
  dead-end. `muse ask` now prints a one-time on-ramp hint (naming `muse demo`,
  `muse read --save-to-notes`, `muse watch-folder --ingest`) ONLY when the
  corpus is empty, and still answers honestly (the refusal is unchanged; the
  hint never fires once any note exists). Proven LIVE on qwen3:8b (isolated
  HOME): empty corpus → hint + honest refusal; populated corpus → no hint, a
  cited "MTU 1380" answer + Sources, and an honest refusal on a must-refuse;
  `commands-ask-onboarding.test.ts` + `pnpm lint` 0/0. (1c5ad06d)

- [x] **P34-9 The on-ramp hint never lies to a user whose embedding is down.**
  P34-8's hint was gated on indexed chunks, so when Ollama was unreachable
  (0 chunks embedded) a user WITH notes was wrongly told "your corpus is
  empty". It now counts note FILES on disk (`notesCorpusFileCount`),
  independent of embedding — so the hint fires only for a truly empty corpus,
  and a populated-but-unindexed corpus gets the "notes search unavailable —
  ollama pull" guidance instead. Proven LIVE on qwen3:8b: Ollama-down + a
  6-note corpus → no false "empty" line; Ollama-up + empty dir → hint fires;
  Ollama-up + populated → cited "MTU 1380" + Sources and an honest refusal;
  `commands-ask-onboarding.test.ts` + `pnpm lint` 0/0. (6df3d076)

- [x] **P34-10 Richer demo payoff + full-oracle edge sweep.** `muse demo` now
  shows TWO answerable questions citing DIFFERENT notes (MTU + rent) before the
  must-refuse, so the zero-setup payoff proves cited recall is real across the
  corpus, not one lucky hit. This fire also ran a full live regression sweep of
  the EXPECTED.md oracle at default top-3: all 6 answerable cited correctly, all
  4 must-refuse honestly refused — the recall edge is green end-to-end. Proven
  LIVE on qwen3:8b; `commands-demo.test.ts` + `pnpm lint` 0/0.
  NOTE: the front-door rungs verifiable under the cited-answer+refusal mandate
  are now exhausted (demo, single/bulk/watch ingest, hybrid recall, confidence
  calibration, empty-corpus on-ramp, model-readiness error UX — all done +
  proven). The only undone front-door rung is (b) a real one-command installer,
  whose proof is a clean-room container/CI test, not live recall. Next fire
  should either scope (b) to a container proof or advance to rung 4 (felt
  self-learning, 2-session proof). (e5404f5e)

- [x] **P34-11 A refusal cites nothing (cross-lingual fabrication=0 fix).** A
  Korean must-refuse (which the English oracle sweep missed) honestly refused
  but the local model appended a spurious `cite as: [from preferences.md]`,
  which the gate kept (real source) and the Sources footer surfaced as "open
  to verify" — a citation on an answer that asserts nothing. A precision-first
  `answerIsRefusal` (EN+KO) now drops all citations from a refusal: the Sources
  footer is suppressed on every path and the inline `[from …]` is stripped on
  the buffered `--with-tools`/`--json` paths (chat-only streams live, so the
  inline marker can still flash — the known streaming limitation; the
  followable footer is gone everywhere). Proven LIVE on qwen3:8b: the Korean
  sister's-birthday refusal → no Sources footer; the Korean WireGuard
  answerable → still cited + footer (no regression); `commands-ask-refusal.test.ts`
  + `pnpm lint` 0/0. (this commit)

**P33 — Reinforcement learning over Muse's memory (the model is fixed,
so RL lives in the MEMORY, not the weights).** Close the self-improvement
loop: today Muse only LEARNS new strategies (ReasoningBank distillation,
skill authoring); it doesn't yet learn which learned things actually WORK.
Give each learned strategy a real outcome reward — reinforce the ones used
cleanly, decay the ones that keep getting corrected/undone/vetoed — and let
reward shape what gets injected, so the playbook self-reinforces toward what
helps this user (ACE arXiv:2510.04618 + the sibling veto store; reward-shaped).
Direction set 2026-05-31 by 진안 ("강화학습이 중요해").

- [x] **P33-1 Reward-weighted playbook (reinforce/decay + selection).** A
  clamped `reward` on each strategy that reward-weighted `rankPlaybookStrategies`
  blends into selection (proven first; a repeatedly-corrected one decays out of
  the injected top-K); `adjustPlaybookReward` persists the update; the signal is
  AUTOMATIC — at session end the strategy a correction implicates is docked,
  alongside ReasoningBank distillation. Flows through BOTH injection paths
  (`buildPlaybookProvider` runtime + `selectPlaybookSection` chat-only `muse ask`).
  `muse playbook` shows each strategy's reward; `muse playbook distill` reports
  what it decayed. Verified: agent-core reward-rank + clamp tests, mcp
  adjust/clamp/back-compat tests, the distill decay test, `pnpm check` green, and
  LIVE through the built CLI (`playbook list` renders ⟨reward⟩; a −4 strategy is
  deranked below an equally-relevant peer).
- [x] **P33-2 Bidirectional reward — reinforce on explicit approval.** The
  positive half of the loop: `detectApprovals` (agent-core, precision-first
  EN+KO mirror of `detectCorrections` — fires on "perfect"/"exactly right"/
  "완벽해"/"딱 좋아", never bare "ok"/"thanks"/"좋아"/"고마워") feeds a session-end
  REINFORCE that credit-assigns each approval to the most-similar existing
  strategy and lifts its reward (+1), the mirror of correction-decay and once
  per strategy per session. So the bank learns from "you got it right" too, not
  just absence-of-negative. `muse playbook distill` reports both ↑ reinforced and
  ↓ decayed. Verified: detectApprovals detector tests (13 endorsements fire, 9
  bare-acknowledgements don't) + the cli reinforce test (an approval lifts the
  applied strategy to +1, unrelated untouched); agent-core 1068 / cli 1548 green,
  lint 0/0.
- [x] **P33-3 Learned avoidance — retire a repeatedly-corrected strategy from
  injection.** The extinction endpoint: a strategy decayed to the floor
  (reward ≤ `PLAYBOOK_AVOID_BELOW` = −4) is EXCLUDED from injection entirely by
  `rankPlaybookStrategies`, even in a small bank (≤ topK) where ranking would
  otherwise return everything — so a consistently-corrected strategy stops being
  applied, not just sinks. Soft + reversible (the veto-store parallel): it stays
  in the bank, marked "· avoided (not injected)" in `muse playbook`, and an
  approval can lift it back. Verified: rank-exclusion tests (dropped even at bank
  ≤ topK; −3 still injects; all-avoided → empty) + `isAvoidedStrategy` boundary,
  and LIVE through the built CLI (the avoided marker + the −4 strategy excluded
  from a 2-strategy bank). agent-core 1072 / cli 1548 green, lint 0/0.
- [x] **P33-4 Extend the reward loop to authored skills.** RL now spans a
  SECOND memory type: a skill the user keeps correcting stops being applied,
  one they approve earns standing. A sidecar `skill-rewards.json` (name→reward,
  kept out of each SKILL.md so a decay never rewrites the body) + `adjustSkillReward`
  (clamped, mutation-queued); at session end `applySkillRewardsFromSession`
  credit-assigns each correction/approval to the authored skill the live prompt
  WOULD apply — via the SAME `selectRelevantSkills` — and decays/reinforces it;
  `buildSkillsPrompt` drops an avoided skill (reward ≤ −4) from the per-turn
  prompt entirely; `muse skills authored` shows reward + "· avoided". Verified:
  store + selection-avoidance + decay/reinforce tests, and LIVE through the
  built CLI (the avoided marker + a −4 skill excluded from a matching prompt).
  mcp 1112 / cli 1553 green, lint 0/0.
- [x] **P33-5 Manual reward control — the user steers the RL.**
  `muse playbook reward <id> [amount] [--down]` and `muse skills reward
  <name> [amount] [--down]` let the user reinforce or penalise a learned
  strategy/skill by hand (clamped via the SAME adjust functions the auto-signal
  uses). So a wrongly-penalised one can be RESCUED back above the avoid line and
  a known-good one PRE-TRUSTED — the reversibility + control that makes the
  (default-off) auto-RL safe to enable. Verified by command tests (reinforce /
  --down penalise / clamp / prefix-id / unknown refused-and-not-written) and
  LIVE through the built CLI (reward +3, then --down 8 clamps to −5 and the
  strategy shows "· avoided"). cli 1556 green, lint 0/0.
- [x] **P33-6 Make the learning visible & trustworthy — `muse learned`.**
  One honest view composing the playbook + authored-skill + skill-reward +
  reflection stores (no model call): the strategies/skills Muse now TRUSTS
  (reward ≥ +1), the ones it learned to AVOID (reward ≤ −4, no longer applied),
  and its grounded reflections — so the default-off RL learning is legible
  enough to trust and turn on (the empty state explains how to enable it).
  This is the "shows its work" edge turned on Muse's OWN self-improvement.
  Verified by `renderLearnedDigest` tests + LIVE through the built CLI (trusted
  +3/+2, avoided −5, dated reflection). cli 1560 green, lint 0/0.
- [x] **P33-7 Reward-weighted skill ordering — skill-RL reaches playbook
  parity.** Among equally-relevant authored skills competing for the limited
  per-turn body slots, the reinforced (higher-reward) one is now selected
  first, not just the avoided ones excluded — `selectRelevantSkills` blends
  `SKILL_REWARD_RANK_WEIGHT × reward` into the rank AFTER the relevance gate
  (reward orders relevant skills, never makes an irrelevant one relevant).
  So skill-RL mirrors the playbook end-to-end: decay · reinforce · avoid ·
  RANK. Verified by chat-skills tests (higher-reward wins the slot over the
  name tie-break; a +5 zero-overlap skill still excluded). cli 1562 green,
  lint 0/0. (Remaining P33 idea: injection-tracking for precise credit
  instead of the selection heuristic.)

**P32 — Grounded "dreaming" (idle memory consolidation that can't make
things up).** Adopt the offline reflection competitors lean on (OpenClaw's
"dreaming"; Generative Agents reflection, arXiv:2304.03442) in Muse's honest,
local key: while idle, synthesise recent episodes/notes into a few higher-level
insights about the user — and keep ONLY insights GROUNDED in real sources (each
cites the episode/note ids it came from; an invented source is stripped, an
under-supported insight dropped). Muse dreams about your life; every insight
points back to where it came from — the identity ("can't make things up") made
true for self-knowledge, which no cloud "dreaming" can match.

- [x] **P32-1 Grounded reflection synthesis (core + honesty guard).**
  `synthesizeReflections` (agent-core) turns recent `{id,text}` items into
  reflections via the LOCAL model; `parseReflections` deterministically strips
  any cited source id that isn't a real input and drops a reflection below
  `minSupport` distinct sources — the model cannot ground an insight in a source
  the user doesn't have. 11 unit tests (strips invented ids, minSupport, dedupe,
  junk-tolerant JSON) + a LIVE qwen3:8b battery (`verify-reflection-synthesis`,
  in `eval:self-improving`): a recurring networking theme across 3 episodes is
  synthesised and grounded in the right real ids, and the grounding invariant
  holds for every reflection.
- [x] **P32-2 Persist + surface grounded reflections.** `reflections-store`
  (atomic, dedup on the normalised insight) + `muse reflections [refresh]`:
  `refresh` runs `synthesizeReflections` over recent episodes and stores the
  grounded ones; `muse reflections` lists each insight WITH the real episode ids
  it came from. Verified live: 5 seeded episodes → 2 grounded reflections (the 3
  networking episodes grouped + cited as ep-101/102/103; the 2 admin ones as
  ep-104/105). 4 store + 3 cli tests.
- [x] **P32-3 Auto-dream during daemon idle.** `muse daemon` runs a throttled
  background `reflectionTick` (off by default, `MUSE_REFLECTION_ENABLED`; slow
  cadence, `MUSE_REFLECTION_INTERVAL_MS` default 6h) that synthesises grounded
  reflections from recent episodes with NO user action and persists only the
  ones cited to real episodes — so insights accrue while Muse sits resident.
  Also fixed: the tick now writes via `resolveReflectionsFile(e)` (the daemon's
  injected env), not a global `process.env` path. Verified by a contract-faithful
  daemon test — enabled + 3 episodes → exactly one grounded reflection persisted
  citing only e1/e2/e3 and a `reflections: +1` line; flag unset → nothing written
  (the gate is real). Closes the P32 dreaming epic (synth → surface → idle auto-run).

## Delivered — P31 (Muse acts on the world, gated draft-first)

Closed the perceive→propose→confirm→act loop: an autonomous trigger PROPOSES a
state-changing action; nothing leaves until the user confirms it. The JARVIS
frontier — "acting" — done strictly per `outbound-safety.md`.

- [x] **P31-1 Proposed-action confirm-to-execute (engine + `muse
  propose`).** A `proposed-action` store + `proposeMessageAction`
  (persists `pending`, sends NOTHING) + `confirmProposedAction`
  (executes once, replay-guarded on status, logs `performed`) +
  `declineProposedAction` (`declined` + logs `refused`), surfaced as
  `muse propose list | approve <id> | decline <id>`. A send failure
  leaves it `pending` (retryable, logged `failed`). Proven by
  contract-faithful smokes: `packages/mcp/test/proposed-action.test.ts`
  (propose→pending+no send; approve→1 send+executed+performed log;
  re-approve→no double-send; decline→no send+refused; failure→pending)
  and `apps/cli/src/commands-propose.test.ts` (list/approve/decline
  surface). No autonomous send anywhere.
- [x] **P31-2 Producer: the daemon proposes.** A draft-first objective
  actuator (`createProposingObjectiveActuator`) makes a met standing
  objective PROPOSE its message instead of sending it; the daemon uses
  it when `MUSE_OBJECTIVES_PROPOSE` is set (default off → unchanged
  auto-send). Proven: `muse daemon --once` with propose-mode + a met
  objective creates a pending proposed action and sends NOTHING —
  `apps/cli/src/commands-daemon.test.ts`. **The full
  perceive→propose→confirm→act loop, with no autonomous send.**
- [x] **P31-3 Proposals expire (timeout → no send).** Each proposal
  carries an `expiresAt` (default 24h); past it it's inert —
  `isProposalActionable` is false, `muse propose list` omits it, and
  `confirm` refuses `"expired"` without sending. Closes
  outbound-safety's "approval times out → the action does not happen"
  for the propose flow — `packages/mcp/test/proposed-action.test.ts`.

## Delivered — P30 (make the daemon debuggable)

`muse daemon --status` reports resolved source paths + launchd
autostart state. Audited PASS (README ledger, `P30 audit`).

- [x] **P30-1 `muse daemon --status` shows the resolved source paths.**
  Beyond the per-tick enabled/disabled lines, `--status` now prints the
  resolved config/tasks/reminders/followups/objectives file paths — the
  first thing to check when a tick reads a different file than the user
  thinks. Proven: `--status` output contains the resolved task /
  reminder / objective paths — see `apps/cli/src/commands-daemon.test.ts`.
- [x] **P30-2 `--status` reports launchd autostart state.** It now also
  reports whether the LaunchAgent plist (P22-6) is installed — i.e.
  whether the daemon will come back after a reboot — with the path or a
  `run muse daemon --install` hint. Proven: no plist → "not installed",
  plist present → "installed" — see `apps/cli/src/commands-daemon.test.ts`.

## Delivered — P29 (watch the resident daemon work)

`muse daemon --print` echoes every delivered notice to stdout for
foreground observability. Audited PASS (README ledger, `P29 audit`).

- [x] **P29-1 `muse daemon --print` echoes deliveries to stdout.** A
  send-also-prints Proxy over the messaging registry echoes every
  delivered notice (from ANY tick) to stdout while still delivering to
  the channel, so the foreground daemon is observable inline. Proven:
  with `--print` the delivered notice text appears in stdout, without
  it only the tick summary, channel delivery unaffected — see
  `apps/cli/src/commands-daemon.test.ts`.

## Delivered — P28 (position retrieved context for the local model)

knowledge_search edge-loads the top-K (Lost in the Middle) so the most
relevant passages sit at the context edges. Audited PASS (README
ledger, `P28 audit`).

- [x] **P28-1 Edge-load knowledge_search results (Lost in the Middle).**
  Both `knowledge_search` surfaces reorder the top-K via
  `edgeLoadByRelevance` so the most relevant passages sit at the
  context edges (first + last) and the weakest in the middle, because
  models attend best to the start/end of context (Liu et al. 2023,
  "Lost in the Middle", arXiv 2307.03172). The top match stays first so
  citation is unaffected. Proven: best-first `[a,b,c,d,e]` →
  `[a,c,e,d,b]` — `packages/agent-core/test/knowledge-recall-agent.test.ts`.
  Deterministic, no dep, local.

## Delivered — P27 (the daily briefing runs in the resident daemon)

`muse daemon` (opt-in) delivers the situational brief: objective
status + imminent tasks & calendar + birthdays + a related note.
Audited PASS (README ledger, `P27 audit`).

- [x] **P27-1 Briefing tick in the launcher.** `muse daemon` runs the
  situational briefing (opt-in `MUSE_BRIEFING_ENABLED`), composing
  `runDueSituationalBriefing` over objectives + tasks-derived imminent
  (`deriveBriefingImminent`) + the shared knowledge enricher, self-
  deduped by its sidecar (default 4h window). Proven by a
  contract-faithful CLI smoke (an imminent task ⇒ a brief delivered;
  skipped without the flag) and surfaced in `--status` — see
  `apps/cli/src/commands-daemon.test.ts`. No model required — the brief
  composes deterministically from structured data.
- [x] **P27-2 Briefing names upcoming birthdays.** The daemon brief now
  passes a `birthdayLine` from the user's contacts
  (`queryContacts` → `resolveUpcomingBirthdays` → `formatBirthdayBriefLine`).
  Proven: a contact whose birthday is today appears in the delivered
  brief — `apps/cli/src/commands-daemon.test.ts`.
- [x] **P27-3 Briefing covers calendar events.** The daemon brief now
  merges `deriveCalendarBriefingImminent` over the calendar registry's
  `listEvents` into its imminent set, so an imminent calendar event
  appears in the brief alongside tasks. Proven: an event 5 min out is
  surfaced in the delivered brief — `apps/cli/src/commands-daemon.test.ts`.
  **P27 complete: the resident daemon's brief covers objectives,
  imminent tasks + calendar, birthdays, and a related note.**

## Delivered — P26 (widen the daemon's perception reach)

Brought home-watch (HA entity states, read-only) + the due-reminders
tick into `muse daemon` — 7 ticks in one process. Audited PASS
(README ledger, `P26 audit`).

- [x] **P26-1 Home Assistant entity-state watch in the launcher.** The
  daemon runs a read-only home-watch tick (HA entity states via
  `homeWatchesFromConfig`, same `createWebWatchRunner` + sink), active
  with `MUSE_HOME_WATCH_CONFIG` + HA creds. A watched entity reaching a
  rule state (e.g. door "unlocked") fires a notice; never acts on the
  home (outbound-safety). Proven by a contract-faithful CLI smoke (a HA
  `/api/states` snapshot fires the notice; skipped without config) and
  surfaced in `--status` — `apps/cli/src/commands-daemon.test.ts`.
- [x] **P26-2 Due-reminders tick in the launcher.** The daemon fires
  due reminders (`runDueReminders`, always-on like proactive — no model
  needed) so the resident process covers the full proactive set
  (proactive · reminders · followup · ambient · web-watch · objectives ·
  home-watch = 7 ticks). Proven: a due pending reminder is delivered to
  a contract-faithful sink, a future one isn't; reported by `--status`
  — `apps/cli/src/commands-daemon.test.ts`.

## Delivered — P25 (ambient context fusion: Perception × Knowledge)

Ambient notices carry a "Related:" line from the user's real notes
about the active window. Audited PASS (README ledger, `P25 audit`).

- [x] **P25-1 Ambient notices carry a "Related:" line.** The daemon's
  ambient runner accepts a knowledge enricher; a fired ambient notice
  is enriched with a `— Related: …` line keyed on the active
  window/app. Proven by a contract-faithful CLI smoke: an injected
  enricher's line rides the delivered ambient notice; absent → plain
  notice — `apps/cli/src/commands-daemon.test.ts`.
- [x] **P25-2 Real enricher from the user's corpus.** The daemon builds
  the ambient enricher best-effort at startup from
  `createKnowledgeEnricher` (notes dir + local Ollama embed,
  hybrid+MMR) when `MUSE_BRIEFING_RELATED_KNOWLEDGE_ENABLED`; fail-soft
  to plain notices otherwise. Live-verified: over a temp notes dir,
  `enrich("Q3 budget memo")` returned the real `notes/q3-budget.md`
  line (not the parking decoy) — the daemon's exact builder. Seam +
  default-off tested in `apps/cli/src/commands-daemon.test.ts`.

## Delivered — P24 (Knowledge grounding quality: MMR)

Diversified knowledge_search top-K with MMR (best-effort on real
paraphrases; deterministic on exact duplicates). Audited PASS
(README ledger, `P24 audit`).

- [x] **P24-1 MMR diversification.** `rankKnowledgeChunks` gains an
  opt-in `diversify` path applying Maximal Marginal Relevance
  (Carbonell & Goldstein, SIGIR 1998) over the ranked candidates —
  `λ·relevance − (1−λ)·max-similarity-to-picked` — so a near-duplicate
  passage doesn't crowd out a distinct relevant one. Both
  `knowledge_search` surfaces use it. Proven: plain top-2 returns two
  near-duplicates; MMR returns one duplicate + the distinct passage —
  `packages/agent-core/test/knowledge-recall-agent.test.ts`. No dep,
  deterministic, local.
- [x] **P24-2 Tune/verify MMR on the real corpus (live).** Live
  nomic-embed measurement on a real near-duplicate corpus: λ=0.7 never
  dropped a paraphrase (both surfaced), so the default is lowered to
  **0.5**. Honest finding: even at 0.5 the dedup of real paraphrases is
  marginal — embedding jitter flips the thin MMR margin run-to-run — so
  MMR is kept as a best-effort diversity NUDGE, deterministically
  proven only on exact duplicates (`knowledge-recall-agent.test.ts`),
  not a guaranteed live paraphrase-dedup. No over-claim.

## Delivered — P23 (deepen Knowledge retrieval: hybrid RRF)

Cosine RAG fused with lexical keyword overlap via RRF across the
agent tool + corpus-search surfaces, recalling exact rare tokens the
embedding misses. Audited PASS (README ledger, `P23 audit`).

- [x] **P23-1 Hybrid (RRF) knowledge retrieval.** `rankKnowledgeChunks`
  gains an opt-in `hybrid` path fusing the cosine ranking with a
  lexical keyword-overlap ranking via Reciprocal Rank Fusion (Cormack,
  Clarke & Büttcher, SIGIR 2009); `knowledge_search` now uses it, so an
  exact rare token the embedding misses is still recalled. Proven: a
  corpus whose exact-keyword chunk has zero cosine is dropped by pure
  cosine but recalled by hybrid — `packages/agent-core/test/knowledge-recall-agent.test.ts`.
  No new dep, deterministic, local.
- [x] **P23-2 Hybrid in the corpus-search callers.** The
  `knowledge-corpus.ts` search paths — the situational-briefing
  `createKnowledgeEnricher` and the `createNotesKnowledgeSearchTool`
  corpus search — now rank via the hybrid path too. A zero-cosine
  exact-keyword chunk is recalled by the corpus-search tool; the
  lexical scorer drops stopwords so a decoy sharing only "my"/"is" is
  NOT falsely recalled — `packages/autoconfigure/test/knowledge-recall-sources.test.ts`.

## Delivered — P22 (the daemon runs for real on this Mac)

Composed the proven-once pieces into one launchable, observable
process and proved startup→delivery end-to-end. Audited PASS
(README ledger, `P22 audit`).

- [x] **P22-1a `muse daemon --once` proactive seam.** A user-facing
  CLI command launches the proactive tick in one process and returns
  after a single tick (the testable launcher seam, no infinite loop).
  Delivered + verified by a contract-faithful CLI smoke: an imminent
  task is delivered to a capturing messaging sink, a quiet tick sends
  nothing, an unknown provider fails closed (no send) — see
  `apps/cli/src/commands-daemon.test.ts`.
- [x] **P22-1b followup tick folded into the launcher.** `muse daemon
  --once` now runs the proactive AND followup ticks in one process; a
  DUE followup is synthesized + delivered to a contract-faithful sink
  (proactive-only cases stay hermetic; followups skip cleanly when no
  model resolves) — see `apps/cli/src/commands-daemon.test.ts`.
- [x] **P22-1c ambient tick folded into the launcher.** `muse daemon
  --once` now also runs the rule-based ambient perception tick; a
  matching ambient rule delivers a notice to a contract-faithful sink
  (skipped cleanly when no `MUSE_AMBIENT_RULES` configured) — see
  `apps/cli/src/commands-daemon.test.ts`.
- [x] **P22-1d web-watch tick folded into the launcher.** `muse daemon
  --once` now also runs read-only web-watch polling; an "appears"
  trigger over an injected fetch delivers a notice to a
  contract-faithful sink (skipped cleanly when no
  `MUSE_WEB_WATCH_CONFIG`) — see `apps/cli/src/commands-daemon.test.ts`.
- [x] **P22-1e objectives tick folded into the launcher.** `muse daemon
  --once` now also re-evaluates standing objectives and notifies on
  "met" — all FIVE ticks (proactive + followup + ambient + web-watch +
  objectives) run in one process. A MET objective notifies via a
  contract-faithful sink (skipped cleanly when no model) — see
  `apps/cli/src/commands-daemon.test.ts`.
- [x] **P22-1f SIGINT clean-shutdown smoke.** The `muse daemon`
  foreground loop now stops cleanly on SIGINT/SIGTERM via
  `DaemonStopSignal` (interruptible sleep — ctrl-c exits at once, no
  waiting out the interval; survives a throwing tick; no `process.exit`)
  — `runDaemonLoop` suite in `apps/cli/src/commands-daemon.test.ts`.
  **P22-1 (the launcher) is complete: all five ticks + clean shutdown.**
- [x] **P22-2 macOS active-window perception feeds the running
  daemon.** `muse daemon` now selects `MacOsActiveWindowSource` for
  its ambient tick when `MUSE_AMBIENT_SOURCE=macos` (darwin, or
  whenever a test injects the osascript runner). A contract-faithful
  osascript signal (`"Slack\ngeneral"`) drives exactly one notice on a
  matching rule through the real sink — see
  `apps/cli/src/commands-daemon.test.ts`.
- [x] **P22-3a chrome-source web-watch threading.** `muse daemon`
  threads a `ChromeSnapshotConnection` into `webWatchesFromConfig`, so
  a `source:"chrome"` watch reuses it and edge-fires; with NO
  connection the chrome watch is skipped fail-soft and the daemon
  stays up. Proven by a contract-faithful fake connection — see
  `apps/cli/src/commands-daemon.test.ts`.
- [x] **P22-3b real Chrome connection at daemon startup.** When
  `MUSE_CHROME_DEVTOOLS_ENABLED`, `muse daemon` builds the connection
  from the runtime assembly's `McpManager` (connect chrome-devtools →
  adapt `toMuseTools()` into a `ChromeSnapshotConnection` via
  `chromeSnapshotConnectionFromTools`), best-effort + fail-soft
  (disabled / connect-refused → `undefined` → chrome watches skip,
  daemon stays up). The adapter is contract-faithfully tested
  (adapts tools → drives a daemon chrome-watch edge-fire e2e); the
  literal browser handshake is verified manually, not in CI — see
  `apps/cli/src/commands-daemon.test.ts`.
- [x] **P22-4a `muse daemon --status` readiness report.** Prints which
  of the five ticks are enabled for the current config (proactive
  always; followup/objectives on a resolved model; ambient on
  `MUSE_AMBIENT_RULES`; web-watch on `MUSE_WEB_WATCH_CONFIG`) and
  exits without ticking — see `apps/cli/src/commands-daemon.test.ts`.
- [x] **P22-4b `muse daemon --init` config file.** Writes the resolved
  provider + destination to `~/.config/muse/daemon.json`
  (`MUSE_DAEMON_CONFIG_FILE` override); the launcher loads it with
  precedence flag > env > config > default, so the user persists them
  once instead of exporting env vars. Round-tripped by a CLI smoke
  (init writes → a later run with no flag/env reads + delivers) — see
  `apps/cli/src/commands-daemon.test.ts`. (Ambient-rules/watches in the
  config file remain a follow-on; provider/destination are the core.)
- [x] **P22-5 Full startup→delivery e2e gate.** A CLI smoke runs the
  full daemon with ALL five ticks enabled in one `--once` and proves
  each delivers to a contract-faithful sink (5 sends); a separate
  smoke proves a denied / timed-out provider send yields ZERO delivery
  (not marked fired — sidecar unpoisoned, history "failed"), the
  daemon stays up, no phantom send (`outbound-safety.md`) — see
  `apps/cli/src/commands-daemon.test.ts`.
- [x] **P22-6 launchd survival.** `muse daemon --install` writes a
  macOS LaunchAgent plist (`~/Library/LaunchAgents/com.muse.daemon.plist`,
  `MUSE_DAEMON_PLIST_FILE` override) with `RunAtLoad` + `KeepAlive` so
  the daemon survives logout/reboot, and prints the `launchctl load -w`
  line. The generated plist passes `plutil -lint` (the OS's own
  validator) — see `apps/cli/src/commands-daemon.test.ts`.

<!-- IMMUTABLE-CORE:BEGIN -->
## Immutable core (the loop must NEVER edit — honesty machinery)

Direction is the loop's to choose. These are NOT, and exist so
autonomy can't decay into busywork:

- the north-star definition (proactive + instantly-responsive
  personal assistant; the loop never weakens it),
- the falsifiable-outward test, the banned-shapes list,
- the `CAPABILITIES.md` rules + the requirement that every goal
  ship a green surface-level (not unit-only) automated check,
- the cross-iteration falsification + 10-iter regression sweep,
- never stop / never ask a human / never complete.

A commit-msg hook (`scripts/guard-immutable.mjs`) rejects any
change to lines in this block without `[core-change: human]`.
Changing the immutable core is a human-only action.
<!-- IMMUTABLE-CORE:END -->

The loop's enforced freedom: extend/reorder targets and bullets,
never the lines between the IMMUTABLE-CORE markers.
