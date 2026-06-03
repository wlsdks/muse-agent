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

- [x] **P37-11 Git perception — `muse ask --git "what did I work on?"` (B3, a NEW
  read-only source).** The one perception source loop-v2 A3 names but Muse lacked.
  A user can now ground an answer on their RECENT GIT COMMITS in the current repo —
  "what have I been working on?", "what was that payments commit?" — cited like any
  other source. Read FILE-side from `.git/logs/HEAD` (the HEAD reflog), NOT a `git`
  spawn, so it stays the low-risk perception class (same as the shell-history
  source), never the runner's execution path. New `parseGitReflog` (keeps
  commit/commit(initial)/commit(amend), drops checkout/merge/rebase/reset noise) +
  `selectGitCommits` (query-overlap ranked, recency-fills so the generic "what did I
  work on?" — zero token overlap — still surfaces the most recent commits). OPT-IN
  via `--git` (mirrors `--shell`; default off, `$MUSE_GIT_REFLOG_FILE` overrides),
  cited `[commit: <subject>]` through the SAME deterministic gate (new `commits`
  citation class in `enforceAnswerCitations`), with a "🔧 from your git commits"
  receipt and inclusion in the rubric-verdict evidence. Proof: 7 unit tests
  (parse keeps/drops the right reflog kinds, never throws; select ranks overlap
  first, recency-fills, dedups) + a new `commits`-gate test (real subject kept,
  invented "delete production database" stripped) + LIVE `muse ask --git`: "what
  have I been working on?" → cites 3 real commits with the 🔧 receipt and ZERO false
  "unverified"; specific "what was the payments commit?" → cites exactly the Stripe
  commit; WITHOUT `--git` no git is injected (opt-in); negative "bank account
  number?" --git → refuses, no fabrication from commits; `verify-claim-grounding`
  4/4 (gate intact). cli 164 files / 1717 tests + `pnpm lint` 0/0. (7abd6f43)

- [x] **P37-12 Opt-in perception sources are DISCOVERABLE — a refusal points to
  `--git` / `--shell`.** `--git` (P37-11) and `--shell` are opt-in and therefore
  INVISIBLE: a user who asks "what did I commit?" / "what was that docker command?"
  just gets "not in your notes" and never learns Muse could answer it. Now, when
  Muse REFUSES and the question is unmistakably about git or shell history, it
  appends a one-line tip ("add --git to also ground on your recent git commits") —
  mirroring the sanctioned `--repair` discoverability nudge (P38-8). New
  precision-first `suggestOptInSource` classifier (git-specific tokens
  commit/git/branch/rebase/repo/codebase/pull-request; shell tokens
  command/terminal/shell/bash/zsh/docker/kubectl), fired ONLY on a refusal and ONLY
  when the matching flag isn't already on — so a normal refusal ("what's my rent?")
  is never cluttered. Proof: 9 unit tests (suggests --git for 5 git phrasings,
  --shell for 3 command phrasings, SILENT on 4 non-matching refusals, no re-suggest
  when the flag is on) + LIVE: "what did I commit last week?" (no --git) → refusal +
  "(tip: add --git …)"; "what was that docker command?" → "(tip: add --shell …)";
  "what is my car insurance number?" → NO tip; "what did I commit?" --git → NO
  re-tip. cli 164 files / 1721 tests + `pnpm lint` 0/0. (b4b33c3c)

- [x] **P37-13 `muse ask --file` cites a clean basename, not an ugly `../../` path.**
  Probing the ad-hoc `--file` perception source: `muse ask --file ~/work/RUNBOOK.md`
  grounded + cited correctly but the citation read `[from ../../../work/RUNBOOK.md]`
  (the file sits outside the notes dir, so `relativizeNoteSource` produced an escape
  path). Now an absolute source that ESCAPES the notes dir cites by basename
  (`[from RUNBOOK.md]`), while an in-corpus nested note KEEPS its disambiguating
  relative path (`projects/vpn.md` — P38-9's intent preserved). Openability is NOT
  lost: the 📎 receipt now derives its "open to verify" path from the matched
  chunk's REAL absolute file, so `[from RUNBOOK.md]` still opens the real
  `~/work/RUNBOOK.md` (not a wrong `notesDir/RUNBOOK.md` join). Proof: 2 new unit
  tests (escaping abs path → basename, in-corpus nested path unchanged; receipt opens
  the real abs path, not the notesDir join) + the existing 13 receipt/verdict-source
  tests green + a LIVE `muse ask --file <abs>/RUNBOOK.md` → cites `[from RUNBOOK.md]`
  with the receipt pointing at the real `/var/folders/.../RUNBOOK.md`. Also ran the
  ~10th-feat-iter regression sweep (claim-grounding 4/4, cited-recall 6/6, proactive
  4/4 — no grounding regression across the session's accumulation). cli 164 files /
  1729 tests + `pnpm lint` 0/0. (this commit)

- [x] **P37-14 `muse ask --file` refuses a BINARY file instead of hallucinating
  content from its garbled bytes (the edge meets perception).** Probing the ad-hoc
  `--file` source with a real-shaped binary: `muse ask --file resume.pdf "what is
  this person's job title?"` read the PDF's raw bytes as UTF-8 (the handler did
  `readFile(path, "utf8")`), fed the garbage to the model as note-class grounding,
  and the model HALLUCINATED a plausible answer — "The resume file mentions 'Senior
  Software Engineer' [from resume.pdf]" — citing a value that appears NOWHERE in the
  file (it was pure binary). A confident, sourced fabrication on the perception
  surface — exactly what the edge forbids. Fixed in apps/cli/src/commands-ask.ts: a
  new pure, exported `looksLikeBinaryContent(bytes)` (deterministic, no deps — a NUL
  byte is the canonical binary signal; failing that, a >10% U+FFFD ratio from a lossy
  UTF-8 decode of the first 8 KB) classifies the `--file` payload BEFORE grounding;
  a binary file is NOT injected and the user gets a clear "looks like a binary file …
  extract the text first" message, so the answer honestly refuses instead of
  fabricating. A real text file still grounds normally. Proof: 6 new unit tests
  (NUL byte / PDF magic+stream / invalid-UTF-8 run → binary; ASCII, valid UTF-8
  Korean+emoji, empty → text) + LIVE on qwen3:8b: the same binary-PDF probe now
  prints the refusal message and answers "I don't have enough information …" (the
  fabricated job title is GONE), while `--file resume.txt` still cites
  `[from resume.txt]`. cli 166 files / 1767 tests + `pnpm lint` 0/0. (d9332d2a)

- [x] **P37-15 `muse ask --file <pdf>` now READS the PDF and answers from its real
  text — a user can ask about a PDF directly.** P37-14 made a binary `--file`
  refuse; this turns the refusal into a capability for the common case: a PDF. The
  `--file` handler now detects a PDF (`isPdfDocument` — `.pdf` ext or `%PDF-` magic)
  and extracts its text via `pdf-parse` (the SAME MIT reader `muse read` already
  uses — no new dependency, lazily imported), then grounds + cites it `[from
  <file>.pdf]`. A non-PDF binary (image/archive) still hits the P37-14 refusal; a
  scanned/empty-text PDF and a malformed PDF refuse honestly (no fabrication from
  garbage); a text file is unchanged. To avoid an import cycle (`commands-read`
  already imports from `commands-ask`), the shared extractor moved to a new leaf
  module `apps/cli/src/document-reader.ts` (`parsePdfBuffer` / `isPdfDocument` /
  `isLikelyBinary` / `extractDocumentText`), re-exported from `commands-read` so its
  consumers (notes-rag, watch-folder, tests) are unchanged. Proof: a new
  `document-reader.test.ts` with 6 tests including a REAL pdf-parse extraction of a
  generated valid PDF (coverage the old tests lacked), the existing read/notes-rag/
  watch-folder suites green (the move is behaviour-preserving) + LIVE on qwen3:8b:
  `muse ask --file resume.pdf "what is this person's job title?"` → "Staff Data
  Scientist at Acme Corp [from resume.pdf]" (extracted from the PDF), an off-topic
  "phone number?" honestly refuses, a malformed PDF / a PNG / a scanned PDF all
  refuse, and a `.txt` file still grounds. cli 167 files / 1773 tests + `pnpm lint`
  0/0. (02c3f412)

- [x] **P37-16 `muse ask --file <dir>` grounds on a FOLDER of documents (cited
  per-file) instead of erroring + fabricating.** Probing `--file` with a directory:
  `muse ask --file ~/docs "…"` leaked a raw Node error ("could not read --file … —
  EISDIR: illegal operation on a directory, read") AND then fell through to a
  general-knowledge GUESS ("The Q3 budget has not been finalized yet …") with a
  stripped citation — a confident fabrication on a path the user explicitly pointed
  at their own docs. Now `--file <dir>` extracts every supported doc under the folder
  (.txt/.md/.markdown/.pdf/.log/.csv, recursive, dotfiles skipped, binaries skipped),
  ranks passages across ALL files by query overlap, keeps the strongest within a
  budget, and cites each `[from <file>]` — so a user can ask about a whole folder
  without ingesting it; an off-topic question finds no overlapping passage and
  refuses honestly. Reuses P37-15's `extractDocumentText` (PDF + text) — the walk +
  per-file extract moved into the leaf `document-reader.ts` as exported
  `walkDocuments` / `extractDirectoryDocuments` (so `commands-read` and `commands-ask`
  share one implementation, no cycle). Proof: 3 new `document-reader` unit tests
  (walks only supported exts recursively, skips dotfiles/unsupported; extracts each
  readable doc and SKIPS a binary; honours the maxFiles cap) + the existing
  read/notes-rag suites green (the move is behaviour-preserving) + LIVE on qwen3:8b:
  `--file <dir>` answered "Q3 budget?" → "$42,000 [from budget.txt]" AND "product
  launch?" → "August 14, 2026 [from launch.md]" (two different files in the folder,
  each cited correctly), while an off-topic "bank account number?" refused with no
  fabrication. cli 167 files / 1776 tests + `pnpm lint` 0/0. (498fbf90)

- [x] **P37-17 An HTML file is grounded on its readable TEXT, not raw tag-soup —
  and its entities are decoded (no more mangled `jane&#64;globex.com`).** Probing
  `--file` with an `.html` file: `muse ask --file resume.html "what is the email?"`
  returned "jane&#64;globex.com" — the HTML entity `&#64;` (= `@`) was never
  decoded, so the user got a MANGLED email, and the 📎 receipt showed raw
  `<html><head><style>…<script>…` tag-soup. Root: every non-PDF `--file`/ingest path
  read the bytes as UTF-8 verbatim, markup and all. Fixed in
  apps/cli/src/document-reader.ts: a new `htmlToText(html)` (regex, no DOM
  dependency) drops `<script>`/`<style>` blocks + comments, strips tags, decodes the
  entities that mangle values (numeric `&#64;`, hex `&#x26;`, and the common named
  ones), and collapses whitespace; `extractDocumentText` routes `.html`/`.htm`
  through it, `.html`/`.htm` join `SUPPORTED_DOC_EXT` (so `muse read <dir>` /
  `--file <dir>` / `watch-folder` pick them up), and the single-`--file` path in
  commands-ask got the same branch (after the robust binary-refusal). Proof: 4 new
  `document-reader` unit tests (isHtmlDocument; tags + script/style stripped &
  whitespace collapsed; numeric/hex/named entities decoded; extractDocumentText
  reads an .html buffer decoded) + LIVE on qwen3:8b: `--file resume.html "email?"`
  now → "jane@globex.com" with a CLEAN text receipt ("Jane Doe Email:
  jane@globex.com Job title: Principal Engineer at Globex & Co."), `muse read
  article.html --save-to-notes` saves clean text (no tags), and `--file <dir>` with
  an HTML file grounds on it. cli 167 files / 1782 tests + `pnpm lint` 0/0.
  (52f20d2a)

- [x] **P37-18 `muse ask --url <url>` — ask about a public web page (Reach growth).**
  A NEW capability (not another fix), the web counterpart of `--file`: `muse ask
  --url https://example.com "what is this domain for?"` fetches the page, extracts
  its READABLE text, grounds on it cited `[from <host>]`, and an off-topic question
  honestly refuses. Reuses the SSRF-guarded `fetchReadableUrl` (`@muse/mcp`) that
  `notes ingest --url` already uses — public hosts only, re-checked after redirects,
  15s timeout, readable-text extraction — so no new fetch/egress machinery and the
  posture is unchanged (reading a user-requested public page is allowed per
  `outbound-safety.md`; the local-only gate is about LLM egress, not web reads).
  Implemented in apps/cli/src/commands-ask.ts: a `--url` option + a branch that
  fetches, narrates "🌐 fetching <url>…", grounds the page's passages via the same
  `selectFilePassages` ranking as `--file`, and cites the host (new pure
  `urlGroundingSource` strips `www.`); a fetch failure prints a clear error and is
  never silently grounded-on. Proof: 2 new unit tests (`urlGroundingSource` →
  host, `www.` stripped, raw-string fallback) + LIVE on qwen3:8b against a REAL URL:
  `muse ask --url https://example.com "what is this domain used for?"` → "used for
  documentation examples without needing permission [from example.com]" with the
  receipt, an off-topic "CEO's phone number?" refuses, and an unresolvable host
  prints "could not fetch --url … (host did not resolve …) — I won't ground on it".
  cli 167 files / 1784 tests + `pnpm lint` 0/0. (b80a3f83)

- [x] **P37-19 `muse ask --clipboard` — ask about whatever you just copied
  (Perception growth, the ephemeral sibling of `--file`/`--url`).** A NEW
  read-only local source: you copy an article / error message / snippet / email,
  then `muse ask --clipboard "<question>"` grounds the answer on the clipboard
  text cited `[from clipboard]`, and an off-topic question honestly refuses — no
  file to save first. Routes through the SAME cited-recall + grounding gate as
  `--file`/`--url` (the clipboard passages enter `scored` → `selectFilePassages`
  ranking → `enforceAnswerCitations` + the grounding verdict), so it's a NEW
  surface gated by construction, not a bypass. New leaf module
  apps/cli/src/clipboard-reader.ts: a pure `clipboardCommand(platform)` mapping
  (darwin→`pbpaste`, win32→PowerShell `Get-Clipboard`, linux→`xclip`, else
  undefined) + a `readClipboardText` shim that shells out read-only and locally
  (never leaves the box); an empty clipboard or read failure is reported, never
  grounded-on-nothing; `queryHasAdHocGrounding` now counts `--clipboard` so the
  empty-notes on-ramp stays silent. Proof: 6 unit tests (the platform mapping for
  all four cases + fail-loud on an unsupported platform + the on-ramp wiring) +
  the full cli suite green (168 files / 1804 tests) + LIVE on qwen3:8b: copying
  "The WireGuard handshake fails until you lower the MTU to 1380 on wg0…" then
  `muse ask --clipboard "what MTU and which interface?"` answers "MTU of 1380 on
  the wg0 interface [from clipboard]" with its receipt, and a copied grocery list
  asked "what is the capital of France?" honestly refuses ("I don't have that
  information… [from no relevant source]" — no invented Paris). cli 168 files /
  1804 tests + `pnpm lint` 0/0. (this commit)

**P40 — Actuation usability: Muse understands natural-language dates.** The
"do" side is only as good as the words a user actually types.

- [x] **P40-1 "remind me NEXT MONTH / next week / next year" now works.** The
  shared relative-time resolver (`muse.reminders.add` / `muse.tasks.add` /
  `muse.calendar.add`) handled "in 1 month" and "next monday" but NOT "next
  week" / "next month" / "next year" — the weekday `next <day>` branch read
  "month"/"week" as a weekday, found none, and returned UNRESOLVED, so
  `muse ask "remind me next month to renew my passport" --with-tools` died with
  "next month is not a supported relative phrase". Added period offsets (week →
  +7d; month/year → calendar +1mo/+12mo at 09:00, time-of-day parsed too) plus KO
  parity (다음 주 / 다음 달 / 내년). Precision kept: "next mango" / "next thing"
  still UNRESOLVED, "next monday" still a Monday. Proof: 7 unit tests in
  `packages/mcp/test/relative-time-period.test.ts` (future dates; ~7d / ~1y
  offsets; KO == EN; time-of-day; weekday unbroken; non-period rejected) + a LIVE
  `muse ask "remind me next month to renew my passport" --with-tools` → "I've set
  a reminder … for July 3, 2026" (was an error). mcp 1310 + `pnpm lint` 0/0.
  (5def3510)

- [x] **P40-2 "remind me THIS WEEKEND / end of the month" now works.** Probing the
  resolver after P40-1 found more everyday phrases UNRESOLVED: "this weekend",
  "next weekend", "end of the month" / "end of month" / "end of this month".
  Added them (weekend → this/next ISO-week Saturday at 09:00; month-end → the last
  calendar day) with time-of-day ("this weekend at 8am") and KO parity (이번 주말 /
  다음 주말 / 월말 / 이달 말). The deliberately-vague "in a couple of days" / "in a
  few days" are left OUT, respecting the existing design note. Proof: 4 new tz-robust
  unit tests (weekend → Saturday a week apart; month-end → June 30; "8am"; KO == EN)
  + a LIVE `muse ask "remind me this weekend to call home" --with-tools` → "I've set
  a reminder for this Saturday (June 6, 2026)". mcp 1314 + `pnpm lint` 0/0. (a1fdb36a)

- [x] **P40-3 `muse remind` works server-less — every subcommand falls back to the
  local store (daily-reliability).** Probing the actuator exposed a real local-first
  defect: `muse remind add "tomorrow 9am" "call dentist"` HARD-ERRORED with "API not
  reachable" on the default (no-server) setup, while `muse remind list` quietly fell
  back to the local store — only `list` had the grace. So the most common write
  ("add a reminder") failed on exactly the machine Muse is built for. Extracted a DRY
  `withLocalFallback(io, useLocal, local, api)` and applied it to add / snooze / fire
  / clear / history (mirroring `list`): when the API is unreachable, transparently use
  `~/.muse/reminders.json` with a one-line note — `--local` still skips the API, and a
  REAL 4xx/5xx still throws (the fallback only catches connection-refused, never masks
  a server error). Proof: 3 new tests (unreachable add → persisted locally; a 500 STILL
  throws + nothing written; unreachable clear → removed locally) + a LIVE server-less
  run of add → list → snooze → fire → history → clear, all succeeding with the
  fallback note. cli 164 files / 1724 tests + `pnpm lint` 0/0. (2ac9372d)

- [x] **P40-4 `muse tasks` works server-less too — same fix, shared helper.** Probing
  after P40-3 found the IDENTICAL defect on the other write actuator: `muse tasks add
  "review the deck"` hard-errored "API not reachable" server-less while `muse tasks
  list` fell back. Promoted the local-fallback to a shared `withApiLocalFallback`
  (in `program-helpers.ts`, alongside `isApiUnreachable`) and applied it to tasks
  add / complete / edit / delete (remind now uses the same helper too — DRY). Same
  safety: `--local` skips the API, a real 4xx/5xx still throws, only
  connection-refused degrades. Proof: 3 new tests (unreachable add → persisted
  locally; a 500 STILL throws + nothing written; unreachable complete → marked done
  locally) + the existing 15 tasks + 16 remind tests still green + a LIVE server-less
  run of tasks add → list → edit → complete → delete, all succeeding, and remind
  add still works after the refactor. cli 164 files / 1727 tests + `pnpm lint` 0/0.
  (1a397be7)

- [x] **P40-5 `muse calendar` reads work server-less — you can LIST what you added.**
  Probing the calendar surface found the inverse asymmetry of P40-3/4: `calendar add`
  is LOCAL-by-design (writes the local calendar, works server-less, has no --local
  flag), but every READ — `events`, `tomorrow`/day-shortcuts, `free`, `conflicts`,
  `providers`, `export` — DEFAULTED to the API and HARD-ERRORED "API not reachable"
  server-less. So a user could `muse calendar add "Dentist" --at "tomorrow 3pm"` and
  then NOT see it with `muse calendar events` unless they knew to pass --local. Wrapped
  all six read subcommands in the shared `withApiLocalFallback` (from P40-4) so they
  fall back to the local calendar file when the API is down — same safety (`--local`
  skips the API, a real 4xx/5xx still throws). Proof: 2 new tests (unreachable `events`
  → lists the locally-added event; a 500 still throws) + the existing 33 calendar tests
  green + a LIVE server-less `calendar add` → `events`/`tomorrow`/`free`/`conflicts`/
  `providers` all now succeed against the local store. cli 164 files / 1733 tests +
  `pnpm lint` 0/0. (e223fb46)

- [x] **P40-6 `muse remind add` warns on a PAST due time (catch the date typo).**
  Probing the actuator: `muse remind add "2020-01-01T09:00:00Z" "old"` SILENTLY
  created a reminder due in 2020 — but a reminder fires AT its dueAt, so a past
  time is almost always a typo (a wrong year, or "at 8am" when it's already 9am)
  and the reminder is immediately overdue / fires on the next `remind run`, not
  when the user meant. Now it prints a one-line heads-up ("… is in the PAST; this
  reminder is already overdue …; if that's a typo, `muse remind clear <id>` and
  re-add a future time") and STILL creates it (warn, don't block — the user may
  have meant it). Proof: 3 new tests (past → warns + still Added; future → no
  warn; `--json` → no prose warning) + LIVE: past ISO → the PAST heads-up,
  `tomorrow at 9am` → clean. cli 165 files / 1750 tests + `pnpm lint` 0/0.
  (49417141)

- [x] **P40-7 `muse tasks complete` is idempotent — re-completing keeps the original
  completion time.** Probing the actuator: `muse tasks complete <id>` on an
  ALREADY-done task SILENTLY rewrote its `completedAt` to now (losing "when it was
  actually done") and misleadingly reported "Completed …". Now a done task keeps its
  original `completedAt` (no write) and reports "… was already done (completed
  <date>) — no change." The open→done path is unchanged. Proof: 1 new test (re-
  completing a done task preserves the original `completedAt`, not rewritten to now)
  + the existing 18 tasks tests + LIVE (already-done → "was already done (completed
  2026-01-15 …) — no change" with the timestamp intact; an open task → normal
  "Completed"). cli 165 files / 1751 tests + `pnpm lint` 0/0. (this commit)

- [x] **P40-8 `muse remind`/`tasks`/`calendar` understand colloquial Korean times
  (아침/저녁/밤/새벽), not just the formal 오전/오후.** Probing the natural-language
  date parser in 진안's native language: `muse remind add "내일 아침 8시"` /
  `"오늘 저녁 7시"` / `"밤 10시"` all FAILED with "dueAt must be an ISO-8601 timestamp
  or a supported relative phrase" — everyday phrasings rejected — while the formal
  `"내일 오후 3시"` worked. Root: `parseKoreanTimeOfDay` (the shared parser behind
  `parseTaskDueAt` → reminders/tasks/calendar/followups) only matched the meridiem
  `오전|오후`, so a colloquial time-of-day word never parsed. Fixed in
  packages/mcp/src/loopback-relative-time.ts: the meridiem now also accepts
  새벽/아침 (→ AM) and 오후/저녁/밤 (→ PM), plus 점심 → noon, with the night edge case
  handled (밤 12시 = 00:00 midnight, vs 오후/저녁 12시 = noon) and 반 (half-past)
  preserved. Proof: 6 new parser unit tests (아침→AM incl. the +1-day check for 내일;
  저녁→PM; 밤 PM with the 밤 12시 midnight special-case; 새벽→AM; 저녁 6시 반 → 18:30;
  점심→noon AND 오후/오전 unregressed) + the full mcp suite green (1320) + LIVE: the
  five failing phrasings now `Added` at the right local time (오늘 저녁 7시 → 19:00,
  내일 아침 8시 → next-day 08:00, 밤 10시 → 22:00, 새벽 5시 → 05:00, 내일 저녁 6시 반 →
  18:30) and 오후 3시 still → 15:00. mcp 167 files / 1320 tests + cli remind/tasks/
  calendar 73 + `pnpm lint` 0/0. (66b10f17)

- [x] **P40-9 A day-part word + a specific hour parses in English too ("tonight at
  8", "tomorrow morning at 9").** The English counterpart of P40-8: a colloquial
  day-part word combined with an explicit hour was REJECTED — `muse remind add
  "tonight at 8"`, `"this evening at 7"`, `"tomorrow morning at 9"`, `"tomorrow
  evening at 6"`, `"tomorrow night at 10"`, `"this morning at 8"` ALL failed with
  "dueAt must be … a supported relative phrase", though the bare `"tomorrow morning"`
  worked. Root: the standalone path only matched a bare day-part ("tonight" alone),
  the dayPattern mis-routed "tonight at 8" into the weekday branch, and
  `parseTimeOfDay` had no case for "morning at 9". Fixed in
  packages/mcp/src/loopback-relative-time.ts: a new `dayPartBiasedTime(part, spec)`
  lets the day-part supply AM/PM for a bare 1-12 hour (morning → AM;
  afternoon/evening/night → PM; "tonight at 12" → midnight), wired through a new
  `standaloneDayPartTime` (today, e.g. "this morning at 8" → 08:00) and a new
  day-part branch in `parseTimeOfDay` (day-headed, e.g. "tomorrow evening at 6"). An
  EXPLICIT am/pm or HH:MM is still honoured over the bias. Proof: 6 new parser unit
  tests (tonight/evening → PM; this morning → AM; tomorrow morning/evening/night +
  the +1-day check; weekday + day-part + hour; explicit 8pm honoured + "tonight at
  12" = midnight; bare day-part unregressed) + the full mcp suite green (1326) + cli
  remind/tasks/calendar 73 + LIVE: 11 phrasings resolve to the right local time
  ("tonight at 8" → 20:00, "tomorrow morning at 9" → next-day 09:00, "tonight at
  8pm" → 20:00, "tonight at 12" → 00:00) with "at 5pm" / "tomorrow morning"
  unregressed. mcp 167 files / 1326 tests + `pnpm lint` 0/0. (00b2ce04)

- [x] **P40-10 A BARE duration ("2 hours", "30 minutes", "2h", "a week") parses as
  an offset from now — "in" is now optional.** Probing the actuators: `muse remind
  snooze <id> --in "2 hours"`, `muse remind add "30 minutes" "…"`, `muse tasks add
  "review" --due "3 days"` ALL failed with "dueAt must be … a supported relative
  phrase" — every bare duration was rejected; ONLY "in 2 hours" (with the literal
  "in") parsed. Especially awkward for `--in "2 hours"`, where the word "in" is
  already in the flag name. Root: the two duration handlers in
  packages/mcp/src/loopback-relative-time.ts (full-word "in N <unit>" and compact
  "in Nh/Nm") both required a leading `in\s+`. Fixed by making that prefix optional
  (`(?:in\s+)?`) in both regexes, so a bare "2 hours" / "30 minutes" / "3 days" /
  "a week" / "2h" / "90m" / "2w" reads as that offset from now — additive, since a
  bare duration was previously unrecognised. A bare number with NO unit ("5") still
  means a 24h clock hour (today 05:00), and an unknown unit ("3 horses") still
  rejects — no false positives. Proof: 4 new parser unit tests (bare full-word +
  compact durations equal their explicit "in …" form; "5" stays a clock hour;
  "3 horses" rejected) + the one mcp assertion that codified the OLD "bare 1h is
  rejected" behavior updated to the new (intended) parse + the full @muse/mcp suite
  green (1330) + cli remind/tasks (38) + LIVE: `remind snooze --in "2 hours"` →
  +2h, `remind add "30 minutes"` → +30m, `tasks add --due "3 days"` → +3d, while
  "in 2 hours" still works. mcp 167 files / 1330 tests + `pnpm lint` 0/0.
  (b4939e6b)

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
  (90543ed1)

- [x] **P38-8 Make the constructive `--repair` discoverable at the moment it
  helps.** P38-3 shipped `muse ask --repair` (rewrite an ungrounded answer from
  the evidence), but it is opt-in and a user never learns it exists. Now, when an
  answer trips the grounding check AND there IS retrieved evidence to rewrite
  from (so the repair could actually succeed, not just refuse), `muse ask` prints
  one tip — "(Re-run with --repair and I'll rewrite this using only your notes —
  shown only if it then checks out.)". Suppressed when `--repair` was already
  used, under `--json`, or with no evidence. Proof: 5 unit tests
  (`shouldSuggestRepair`: fires on ungrounded-with-evidence; silent on a clean
  answer / repair-already-set / --json / no-evidence) + a LIVE `muse ask "what
  cipher does the office VPN use?"` over a note that doesn't say (the answer trips
  the verdict and the --repair tip appears). cli 1704 + `pnpm lint` 0/0. (0acf121c)

- [x] **P38-9 The 📎 receipt shows the SAME relative path the answer cited (not
  the basename).** After P38-6 made citations relative (`[from projects/vpn.md]`),
  the "open to verify" receipt still labelled the source by basename ("from
  vpn.md") for a non-dated note — so a user with `a/notes.md` AND `b/notes.md`
  couldn't tell which "from notes.md" receipt was which. The receipt now prints
  the cited relative path, matching the citation. Proof: the `commands-ask-receipts`
  test updated to assert "from tasks/finances.md" (not "from finances.md") + a LIVE
  `muse ask` over a nested note (`projects/vpn.md`): answer cites
  `[from projects/vpn.md]` AND the receipt reads "from projects/vpn.md". cli 1704 +
  `pnpm lint` 0/0. (Investigated this iter + recorded in the Rejected ledger: `muse
  chat` lacks the citation gate, but that is BY DESIGN — chat is conversational,
  not one of the edge's grounded surfaces; do not "fix" it.) (43079e8c)

- [x] **P38-10 Kill the false "treat as unverified" warning on a CORRECT
  contact answer.** Probing the contacts perception surface: `muse ask "what is
  Mina's email/phone?"` retrieved the contact and answered correctly
  (`mina@foundry.io`, `+1 415 555 0148`) — but BOTH grounding warnings fired
  spuriously. (a) The local model cites a contact with the NOTE verb / by slot or
  id (`[from contact 1]`, `[from contact: mina]`) because the `<<contact N — id>>`
  wrapper mirrors the `<<note N — file>>` → `[from file]` pattern, so the
  exact-match note gate false-stripped it → "Removed 1 citation… treat as
  unverified". (b) The rubric verdict scored coverage against note chunks ONLY, so
  a contact-sourced fact looked "not backed by your notes" → a second "treat as
  unverified". Fixed BOTH by code: a new deterministic `normalizeContactCitations`
  rewrites the model's `[from contact N]`/`[contact: id]` mis-forms to the
  canonical `[contact: <name>]` (resolve-or-leave — never touches a real
  `[from contacts.md]`), and the verdict's evidence now includes the matched
  contacts (high-precision structured exact match) so an address-book answer
  verifies grounded. The unknown-person case still refuses ("I don't have access
  to Bob Quagmire's…"), no fabrication. Proof: 9 new `normalizeContactCitations`
  unit tests (slot/id/partial/unresolvable/note-safe/idempotent) + a LIVE
  `muse ask "what is Mina Park's email address?"` → cites the contact, receipt
  "👤 from your contacts: Mina Park", and ZERO "unverified"/"Removed citation"
  warnings; negative `muse ask "what is Bob Quagmire's email?"` still refuses.
  agent-core 1366 + cli 1710 + `pnpm lint` 0/0. (c139e922)

- [x] **P38-11 Kill the false "treat as unverified" on EVERY non-note grounded
  answer (tasks / reminders / events / …).** P38-10 fixed contacts; probing the
  deferred follow-up confirmed the SAME self-contradiction on the actuator-recall
  surfaces — `muse ask "what tasks do I have?"` listed the real open tasks yet
  fired BOTH a citation strip ("Removed 2 citations t1, t2 — treat as unverified")
  AND the rubric verdict ("not backed by your notes"). Two root causes, fixed by
  code: (a) the task/event/reminder wrappers exposed an id/provider in the marker
  with NO citation hint (unlike the note wrapper's embedded `[from src]`), so the
  local model cited the id (`[task: t1]`) which the title-matching gate stripped —
  now each wrapper embeds the canonical `[task|event|reminder: <title/text>]` hint,
  so the model cites the title the gate accepts; (b) the verdict scored coverage
  against note chunks ONLY — now `scoredMatches` includes EVERY grounded source
  shown (tasks, events, reminders, sessions, actions, commands, feeds, contacts),
  and the verdict-answer expands content-citations inline (a LIST answer whose
  titles live only inside `[task: …]` markers would otherwise score ~zero coverage
  after marker-stripping). Fabrication still caught: evidence is ONLY the real
  retrieved sources, and a wrong value is still rejected (claim-grounding 4/4) — so
  a claim in no source stays uncovered → ungrounded. Proof: LIVE `muse ask "what
  tasks do I have?"` → cites `[task: Review the Q3 pricing deck]`, "✅ from your
  tasks" receipts, ZERO warnings; `"what reminders do I have?"` clean; negative
  `"what is my bank account number?"` still refuses; `verify-claim-grounding` 4/4
  (wrong number/name still rejected) + `verify-cited-recall` 6/6 (note recall +
  out-of-corpus refusal intact). cli 1710 + `pnpm lint` 0/0. (b844cf4c)

- [x] **P38-12 Events recall: REPAIR the piece P38-11 claimed but didn't live-prove
  — clean verdict AND the correct weekday.** Falsifying P38-11 with a real
  `calendar.json` event exposed events still RED: `muse ask "what's on my schedule?"`
  cited the event fine but STILL fired "not backed by your notes", AND the model told
  the user the WRONG day ("Saturday" for a Thursday). Root cause: the event wrapper
  fed the model only ISO timestamps, so it (a) mis-derived the weekday and (b) its
  reformatted-date prose ("Saturday, June 4th, 8 PM") + true framing ("no other
  events this week") missed the note-only-style evidence → coverage 0.43 < 0.5 floor.
  Fix (both in `commands-ask.ts`, no core change): the event wrapper now hands the
  model a HUMAN-readable local date (`toLocaleString` weekday/month/day/time, ISO
  kept for precision) so it echoes the CORRECT day, and the verdict evidence for
  every date-bearing source (events/tasks/reminders) carries the same human date
  rendering so the derived date tokens are covered. Fabrication still caught
  (claim-grounding 4/4). Proof: LIVE `muse ask "what's on my calendar this week?"`
  ×3 → all clean (ZERO warnings) and the day is now correct ("Friday, June 5, 2026");
  tasks/reminders stay clean; negative "bank account number" still refuses;
  `verify-claim-grounding` 4/4. cli 1710 + `pnpm lint` 0/0. (44c87f3a)

- [x] **P38-13 Proactive surface "shows its work" PRECISELY — the nudge quotes the
  RELEVANT line, not the chunk opening.** Hardening the one grounded surface I
  hadn't touched (the proactive `📎 Related in your notes` finding). It quoted the
  matched chunk's OPENING (first 160 chars), but a chunk matches the triggering
  item as a whole — so when the relevant sentence sits later, the nudge surfaced a
  non-sequitur and truncated the actual reason away (probed: a 308-char journal
  chunk for item "Mom birthday" showed "Project kickoff… budget… timeline…" and CUT
  OFF "Mom's birthday is June 12th"). `decideProactiveRecall` now takes the item
  title as `query` and centres the snippet on the sentence with the most query
  overlap (`selectRelevantExcerpt`); no lexical signal (purely semantic match) or a
  short chunk ⇒ unchanged opening fallback, so it's never worse than before. The
  proactive gate's confidence decision is untouched (precision of the QUOTE, not
  of whether to surface). Proof: 4 new unit tests (relevant-line centred /
  no-overlap falls back to opening / short chunk quoted whole / over-long chosen
  sentence truncated) + the LIVE `verify-proactive-recall-gate.mjs` 4/4 (in-corpus
  surfaces a cited relevant finding, off-topic stays silent). agent-core 1370 +
  `pnpm lint` 0/0. (4bfc1ad1)

- [x] **P38-14 `muse recall` + `muse today --connect` preview the RELEVANT line, not
  the chunk opening.** P38-13 fixed the proactive-recall GATE, but the recall RANKER
  (`rankRecallCandidates`, shared by `muse recall` search AND `muse today --connect`'s
  "💡 Related in your brain") still previewed `chunk.text.slice(0, 200)` — the opening.
  So a multi-line note whose match sits further down surfaced a non-sequitur (a "# Q3
  board deck" heading + standup chatter instead of the line that matched). The ranker
  already computes the query tokens; now the snippet is the LINE with the most query
  overlap, markdown headings skipped — and falls back to the opening when no query /
  single line (never worse). `findTodayConnections` now passes `queryText` so the
  connection snippet is relevant too. Proof: 2 new unit tests (multi-line chunk →
  the matching line, heading + opening excluded; no-query → opening fallback) + LIVE
  `muse today --connect` with a 4-line note → "💡 Related in your brain: [notes] log.md
  — The Q3 board deck must cover revenue up 22% and the new pricing tiers" (the match,
  not "# Meeting log General standup…") and `muse recall "Q3 board deck pricing"` →
  previews the same relevant line. cli 164 files / 1731 tests + `pnpm lint` 0/0.
  (7d44da27)

- [x] **P38-15 Remembered facts are a CITED grounding source — no more
  misattribution to a random note.** Probing the user-memory surface found a real
  fabrication bug: `muse remember "I am allergic to penicillin"` then `muse ask
  "what am I allergic to?"` answered correctly but cited `[from n.md]` (a note that
  never mentioned penicillin) — because the remembered fact was injected into the
  PERSONA (so the model knew it) but was NOT a citable grounding source, so the
  model misattributed it to the only note + the verdict false-flagged a TRUE answer.
  Made `muse remember` facts a first-class cited source (the P38-10 contacts
  pattern): new `[memory: <topic>]` citation class in `enforceAnswerCitations`, a
  "🧠 from what you told me" receipt, the matched facts in the rubric-verdict
  evidence, and a `renderMemoryFact` that turns a machine-keyed fact
  (`allergy_penicillin: yes`) into a natural phrase for the model + judge. The gate
  validates against ALL the user's facts (the persona exposes all), so a cited fact
  is never wrongly stripped. Proof: 6 new helper tests + a `memories`-gate test
  (real fact kept, invented "bank_pin" stripped) + LIVE: `muse ask "what is my
  favorite color / apartment number?"` → cited `[memory: favorite_color]` /
  `[memory: apartment_number]` with the 🧠 receipt and ZERO warnings; an unremembered
  fact still refuses; `verify-claim-grounding` 4/4. cli 165 files / 1744 tests +
  `pnpm lint` 0/0. (Known edge — recorded in the Rejected ledger: a query adjective
  that doesn't token-match its noun-keyed fact, "allergic" vs `allergy_penicillin`,
  still trips the answerability→judge path; the fact is now correctly cited to
  memory regardless. Proper fix is natural-language fact storage in `muse remember`.)
  (6aa1a69b)

- [x] **P38-16 Cross-lingual recall no longer false-flags a CORRECT answer (Korean
  query / English notes).** Probing for 진안's real usage: `muse ask "내 와이파이
  비밀번호가 뭐야?"` against an English note grounded + answered correctly ("…hunter2-blue
  [from net.md]") but the verdict fired "treat as unverified" — the LEXICAL rubric
  scores answerability≈0 (Korean query tokens never match English evidence) → the
  weak band → and the small judge, told to answer NO when "unsure", defaults to NO on
  the language gap. Fixed by hardening the SHARED `REVERIFY_SYSTEM_PROMPT`: the judge
  is now told the QUESTION/ANSWER/EVIDENCE may be in DIFFERENT languages and to judge
  whether the underlying FACTS/VALUES match (a literal value in the evidence supports
  the same fact in a translated answer), while a value the evidence does NOT contain
  stays unsupported in ANY language. This does NOT relax or bypass the gate (unlike
  the reverted P38-15-edge attempt) — the judge still rejects a wrong value. Proof: 2
  new permanent cases in `verify-claim-grounding` (CROSS-LINGUAL correct KR→EN
  upholds GROUNDED; CROSS-LINGUAL wrong value 'dragon99-red' → UNGROUNDED) passing
  6/6 twice, the 4 same-language cases still 4/4 (no regression), + LIVE `muse ask`
  in Korean 5/5 clean and a Korean must-refuse still refuses. agent-core 1373 +
  `pnpm lint` 0/0. (9938855d)

- [x] **P38-17 A Korean memory recall cites `[memory: …]`, not a false `[from <key>]`.**
  Probing 진안's core "knows you" flow: `muse remember "내 차 번호판은 12가 3456이야"` →
  `muse ask "내 차 번호판 뭐야?"` answered correctly ("…12가 3456") but cited it
  `[from car_license_plate]` (the NOTE verb + the memory KEY), which the exact-match
  note gate then stripped + warned "Removed citation". Root: the Korean query doesn't
  lexically match the ENGLISH fact key, so the `[memory: …]`-hint grounding block
  isn't injected — the persona still gives the model the fact, so it falls back to
  the note verb. Same class as the P38-10 contact fix, for memory: new
  `normalizeMemoryCitations` rewrites a `[from <X>]` whose `<X>` EXACTLY matches a
  known memory key (separator/case-insensitive) to `[memory: <X>]` BEFORE the gate;
  a real `[from note.md]` is never touched (a note is never mistaken for a memory).
  Proof: 4 new unit tests (rewrite on exact key match incl. spacing variant; leave a
  real note alone; the rewritten form passes the gate clean; no-op with no keys) +
  LIVE: `muse ask "내 차 번호판 뭐야?"` ×3 → ZERO "Removed citation" warning and the
  "🧠 from what you told me: car_license_plate" receipt shows; a real WiFi note query
  still cites `[from home.md]` (not rewritten). agent-core 1377 + cli 1755 +
  `pnpm lint` 0/0. (7a77e50a)

- [x] **P38-18 A Korean task/reminder/event recall is no longer false-stripped —
  the lexical gate tokenizes Unicode, and a coverage-only miss routes to the judge.**
  Probing 진안's Korean actuation→recall loop: `muse remind add … "치과 예약 가기"` +
  `muse tasks add "분기 보고서 작성하기"` then `muse ask "내가 해야 할 일이 뭐가 있어?"`
  answered correctly and cited `[task: 분기 보고서 작성하기]` / `[reminder: 치과 예약 가기]`
  (the EXACT Korean titles) — yet the citation gate STRIPPED them ("Removed 2
  citations") and the verdict false-flagged. Root: `lexicalTokens` (the overlap basis
  for the resolvesByOverlap citation classes — tasks/reminders/events/sessions/…)
  split on `/[^a-z0-9]+/` (ASCII only), so "분기 보고서 작성하기" tokenized to `[]` →
  zero overlap → a valid Korean citation looked unresolvable. Two coordinated fixes in
  `packages/agent-core/src/knowledge-recall.ts`: (1) `lexicalTokens` now splits on
  Unicode `/[^\p{L}\p{N}]+/u` and keeps single-character CJK tokens (which carry
  meaning) while still dropping 1-char Latin — English tokenization is unchanged;
  (2) because Unicode coverage of a cross-lingual answer can dip below the coverage
  floor (Korean prose over English evidence), `verifyGroundingWithReverify` now
  ESCALATES a confident, validly-cited coverage-only failure to the re-verification
  judge instead of hard-failing it — the judge stays in the loop, so a WRONG value is
  still rejected (fail-close on a judge error). Proof: 6 new agent-core unit tests
  (lexicalTokens tokenizes "분기 보고서 작성하기" + keeps single-char CJK / drops 1-char
  Latin; coverage-escalation upholds a correct cross-lingual answer, rejects a wrong
  value, fail-closes on judge error, and does NOT escalate an INVALID-citation miss) +
  the verify-claim-grounding battery still 6/6 on two consecutive runs (the cross-
  lingual correct/wrong cases route through the new branch) + LIVE on qwen3:8b: the
  Korean task/reminder recall above is now clean (no "Removed citation", no unverified
  warning), the cross-lingual WiFi recall (P38-16) is unregressed, and a Korean
  absent-fact ("내 여권 번호 뭐야?") still refuses with no fabrication. agent-core
  112 files / 1383 tests + cli 165 files / 1755 tests + `pnpm lint` 0/0. (3529a8c5)

- [x] **P38-19 The grounding DRIFT verdict now runs under `muse ask --with-tools`
  too — one gate under EVERY recall surface, no false-flag.** The recall edge's
  post-hoc rubric verdict (`groundingVerdictNotice` + the weak-band MaTTS reverify
  judge + the `--repair` offer) was gated `!options.withTools`, so the agent
  (tool-using) recall path printed a confident answer with NO drift signal — the
  one surface where "shows its work" was silent. It was skipped because the
  verdict's note evidence is the CLI's pre-retrieval top-K (`scored`), and the
  agent can pull a chunk via `knowledge_search` (often on a REFORMULATED query)
  the top-K missed → scoring against `scored` alone would false-flag a correct
  agent answer. Fixed in apps/cli/src/commands-ask.ts: the guard drops to
  `!options.json` (verdict runs on both paths) and a new pure
  `augmentNoteEvidenceWithCited(baseNotes, citedSources, liveNotes)` adds the FULL
  text of every note the answer actually cites (each already gate-validated against
  the live corpus) to the evidence — ADDITIVE ONLY, so it can prevent a false
  "ungrounded" but never cause a false "grounded" (a drifted value in no cited note
  stays uncovered). Proof: 6 new unit tests (pulls a cited out-of-top-K note's full
  chunks; ignores an uncited note; no chunk dupes; no-op when nothing/invalid is
  cited; additive-only invariant) + the existing verdict/relativize tests green +
  LIVE on qwen3:8b: `muse ask --with-tools` asserting "WireGuard default MTU is 1420
  [from net.md]" against a note that never states it now fires "⚠️ Grounding check:
  … treat as unverified (low coverage rejected by re-verification)" + the --repair
  offer (it was SILENT before); grounded `--with-tools` answers (garage code, wifi
  password) do NOT false-flag; chat-only is byte-for-byte unchanged. cli 166 files /
  1761 tests + `pnpm lint` 0/0. (e735ca68)

- [x] **P38-20 `muse ask` no longer auto-authors durable memory from the model's
  own answer — closing a provenance fabrication ("from what you told me" for a
  fact you never stated).** DISCOVERED live last iteration and CONFIRMED this one:
  a `muse ask --with-tools` general-knowledge answer ("WireGuard default MTU is
  1420") was persisted to `user-memory.json` as `wireguard_default_mtu: "1420"`,
  and the NEXT recall cited it `[memory: wireguard_default_mtu]` with the receipt
  "🧠 from what you told me" — Muse asserting the USER stated a fact the MODEL made
  up. Root: the shared user-memory auto-extract HOOK (`afterComplete`) mines the
  ASSISTANT output too, and it ran on every agent run incl. one-shot recall — so a
  Q&A turn distilled the model's assertion as a user fact (a second latent vector:
  the `remember_fact` write tool, also exposed on the recall agent). Fixed by making
  recall read-only for memory: `muse ask` sets `metadata.skipUserMemoryAutoExtract`
  (a new per-run opt-out the hook honors via the exported `readSkipAutoExtract`, in
  packages/memory) AND `metadata.forbiddenToolNames: ["remember_fact"]` (defense in
  depth). Durable memory authoring stays with the explicit `muse remember` command
  and the conversational chat surface (whose auto-extract is unchanged). Proof: 3
  new memory unit tests (skip flag true only when set; the hook writes NOTHING on an
  opted-out recall turn even with a fact-bearing extractor stub; a normal/chat turn
  STILL extracts — the skip is the only behavior change) + LIVE on qwen3:8b: the same
  `--with-tools` WireGuard probe that wrote `wireguard_default_mtu` before now leaves
  NO memory file across two runs, while the P38-19 drift verdict still fires. memory
  30 files / 312 tests + autoconfigure 484 + cli 166 files / 1761 tests + `pnpm lint`
  0/0. (c2d37ad8)

- [x] **P38-21 Chat auto-memory drops a fact the MODEL asserted but the USER never
  said — the provenance gate now covers the conversational surface, not just
  `muse ask`.** P38-20 made one-shot recall skip extraction; the residual it flagged
  was that the SAME leak lives on `muse chat`, via a SEPARATE extractor
  (`extractMemoryFromTurn`, apps/cli/chat-auto-memory.ts) that also mines the
  assistant reply — so a user who ASKS "what's WireGuard's default MTU?" and gets
  "1420" would have `wireguard_default_mtu: 1420` stored as their own fact, later
  cited "🧠 from what you told me". Fixed with a deterministic provenance gate (the
  same code-not-prompt shape as the citation gate): new pure, exported
  `dropModelAssertedValues(record, userTurn, assistantOutput)` in packages/memory
  drops a fact/preference iff its DISTINCTIVE value tokens all appear in the
  assistant's reply and NONE appear in the user's turn — i.e. the value was the
  model's assertion, not the user's words. A user-stated value (its token is in the
  user turn) survives; an inferred boolean ("allergy: yes" — "yes" carries no
  distinctive token) survives (fail-open, can't attribute → keep). Applied in BOTH
  extraction paths: the chat `extractMemoryFromTurn` AND the agent-runtime
  auto-extract hook (a malformed array-shaped payload is left for the existing
  sanitizer). Proof: 8 new memory unit tests (drops the WireGuard/Paris answer-value;
  keeps a user-stated Seoul/Mina; keeps an inferred boolean; keeps a terse-reply
  payload; hook end-to-end persists nothing on a model-asserted fact, persists a
  user-stated one) + the live `verify-auto-memory` battery EXTENDED with 2 provenance
  cases and run on qwen3:8b → 11/11 (the WireGuard + capital-of-France answers store
  NOTHING, while Busan/Jinan/서울 user facts and the prefs still extract — no
  over-drop, negatives still clean). memory 31 files / 320 tests + autoconfigure 484 +
  cli 166 files / 1761 tests + `pnpm lint` 0/0. (17090f9e)

- [x] **P38-22 A contact recall is no longer false-flagged "unverified" when the
  model cites the raw `contact_<uuid>` id.** Probing the contacts grounding source
  (P37-5, 진안's address book): `muse ask "what is Mina's email?"` answered correctly
  ("mina@acme.com") but cited it `[from contact_<uuid>]` — the NOTE verb + the raw
  internal contact id the grounding marker shows (`<<contact N — contact_<uuid>>>`)
  — and the gate then STRIPPED it with "⚠️ Removed 1 citation … treat those claims as
  unverified" on a TRUE recall. Root: `normalizeContactCitations`'s repair regex is
  anchored on the literal word "contact" + a separator, but the id is
  `contact_<uuid>` (the `_` is not a separator), so `[from contact_<uuid>]` never
  matched and fell through to the note gate. Same class as P38-10 (contacts) /
  P38-17 (memory), now for the raw-id form. Fixed in
  packages/agent-core/src/knowledge-recall.ts: a second pass rewrites a bare
  `[from <X>]` whose `<X>` EXACTLY matches a known contact id OR full name
  (separator/case-insensitive, NEVER a fuzzy token overlap) to `[contact: <name>]`;
  a real `[from note.md]` — even one resembling a contact (`mina-park-resume.md`) —
  is left untouched. Proof: 5 new agent-core unit tests (raw `[from contact_<uuid>]`
  → `[contact: <name>]`; `[from <Full Name>]` → canonical; the rewrite flows through
  the gate with zero strips; a contact-resembling note is NOT rewritten) + the
  existing contact/gate tests green + LIVE on qwen3:8b: `muse ask "what is Mina's
  email?"` now shows the "👤 from your contacts: Mina Park" receipt with NO "Removed
  citation / treat as unverified" warning (before: stripped + warned). agent-core 112
  files / 1387 tests + cli 167 files / 1773 tests + `pnpm lint` 0/0. (207c211a)

- [x] **P38-23 A `[from <class>: …]` structured citation is no longer false-stripped
  — the model's "from "-prefixed commit/task/event/… citation now survives the
  gate.** Probing the git-perception source (P37-11): `muse ask --git "what have I
  been working on?"` grounded on real commits and answered correctly, citing `[from
  commit: feat(perception): muse ask grounds on the action log …]` — but the gate
  STRIPPED it with "⚠️ Removed 1 citation … treat those claims as unverified" on a
  TRUE recall. Root: the model prepends the note verb "from " to a STRUCTURED
  citation, but the gate's class regexes anchor on `[commit:` / `[task:` (no "from "),
  and the note regex `[from <X>]` runs FIRST and mis-catches `[from commit: …]` as a
  non-existent note → strips it. Same class as P38-22 (contacts) / P38-17 (memory),
  now GENERAL. Fixed with a new exported `normalizeFromPrefixedCitations` (agent-core)
  that drops the redundant "from " before any known class keyword (task / event /
  reminder / session / feed / contact / command / commit / memory / action), applied
  in the ask flow before the contact/memory passes; a real `[from note.md]` (no class
  keyword + ":") is untouched. Proof: 4 new agent-core unit tests (`[from commit: …]`
  → `[commit: …]`; every class rewritten; a real note / a `commit-log.md` note left
  alone; the rewritten commit citation survives `enforceAnswerCitations` with zero
  strips) + the existing contact/gate suite green + LIVE on qwen3:8b: `muse ask --git
  "what have I been working on?"` now cites two `[commit: …]` with NO "Removed
  citation / unverified" warning (before: stripped + warned). agent-core 112 files /
  1391 tests + cli 167 files / 1782 tests + `pnpm lint` 0/0. (7440e57f)

- [x] **P38-24 A past-SESSION recall cited by SLOT number is no longer
  false-stripped — `[from session 1]` survives the gate.** Probing the
  continuous-companion core (episode/session grounding) by seeding two past
  sessions: `muse ask "what did we decide about the VPN MTU?"` correctly grounded on
  the episode and answered "…MTU 1380 [from session 1]", but the gate STRIPPED it
  with "⚠️ Removed 1 citation … treat those claims as unverified" on a TRUE recall.
  Root: the grounding markers are slot-numbered (`<<session N — id>>`), so the model
  cites a structured source by SLOT (`[from session 1]`, even `[from session 1 —
  ep_001]` echoing the id) rather than the title — and only CONTACTS had slot-number
  normalization (P38-10); sessions/events/etc. fell through to the note regex and
  were stripped. The sibling of P38-23 (the `[from <class>: …]` colon form), now for
  the `[from <class> N]` slot form. Fixed with a new exported `normalizeSlotCitations`
  (agent-core) that rewrites `[from <class> N]` → `[<class>: <slot N's content>]`
  using the SAME ordered lists the markers were built from (ignoring a trailing
  "— <id>"); an out-of-range slot or unknown class is left untouched. Wired into the
  ask flow for session/event/task/reminder/contact/feed/command/commit/action. Proof:
  5 new agent-core unit tests (`[from session 1]` → canonical; the `— ep_001` suffix
  ignored; right slot mapped; out-of-range / non-class left alone; rewritten session
  survives the gate) + LIVE on qwen3:8b with seeded episodes: two past-session recalls
  (VPN MTU 1380, Q3 budget $42,000) now answer with NO "Removed citation / unverified"
  warning (before: stripped + warned). agent-core 112 files / 1396 tests + cli 167
  files / 1782 tests + `pnpm lint` 0/0. (3f9d9935)

- [x] **P38-25 A feed/structured citation by BARE slot ("[feed 1]", no "from")
  resolves to its canonical form — completing the slot-citation handling.** Probing
  the FEED grounding (a fresh surface): `muse ask "what are the latest headlines from
  HN?"` grounded on the real RSS headlines and answered correctly, but cited them
  `[feed 1]` / `[feed 2]` — the model cites the slot-numbered marker (`<<feed N —
  name>>`) WITHOUT the "from" prefix. P38-24's `normalizeSlotCitations` only matched
  `[from <class> N]`, so the bare `[feed 1]` fell through: it was left verbatim (an
  ugly slot reference, not the feed name) and the "📰 from your feeds" receipt —
  which parses `[feed: <name>]` — never showed. Fixed by making the "from " prefix
  OPTIONAL in normalizeSlotCitations' regex, so the bare `[feed 1]` / `[session 1]` /
  `[event 2]` rewrite to `[feed: HN]` / `[session: <summary>]` etc. just like the
  "from" form (an out-of-range or unknown-class slot is still left untouched).
  Proof: 1 new agent-core unit test (bare `[feed 1]`→`[feed: HN]`, `[feed 2]`→
  `[feed: Lobsters]`, bare `[session 2]`→canonical) + the existing slot/gate suite
  green (the "from" form unregressed) + LIVE on qwen3:8b with a real RSS feed:
  `muse ask "latest HN headlines?"` now cites `[feed: HN]` (was `[feed 1]`).
  agent-core 112 files / 1397 tests + cli 167 files / 1787 tests + `pnpm lint` 0/0.
  (cfcd0987)

- [x] **P38-26 The feed answer now carries its "📰 from your feeds" receipt — the
  user-observable half P38-25 claimed but didn't deliver.** Falsifying P38-25
  surfaced that its claim ("the feed answer carries its source receipt") was RED:
  `formatNonNoteReceipts` (the "📎 Also grounded on:" renderer) grabbed events /
  tasks / reminders / contacts / commands / commits / memories / actions — but NOT
  feeds — so a `[feed: HN]` citation produced no receipt and P38-25's normalization
  had no visible effect (the streamed inline still shows the raw `[feed 1]`). Per the
  procedure, repairing the falsified claim is the iteration. Fixed in
  apps/cli/src/commands-ask.ts: a `feeds?` field + a
  `grab("📰 from your feeds:", /\[feed: …\]/, sources.feeds)` line in
  `formatNonNoteReceipts`, and the call site now passes
  `feeds: feedHeadlines.map(h => h.feedName)`. Proof: 1 new unit test (a `[feed: HN]`
  answer renders "📰 from your feeds: HN") + the existing receipt suite green + LIVE
  on qwen3:8b with a real RSS feed: `muse ask "what are the latest headlines from
  HN?"` now prints "📰 from your feeds: HN" (before: no receipt, no warning — the
  citation was kept but invisible as a source). cli 167 files / 1788 tests +
  `pnpm lint` 0/0. (6d9ea4b7)

- [x] **P38-27 A past-SESSION recall now shows its "💬 from a past session" receipt
  — completing receipt coverage for EVERY citation class, locked by a parity test.**
  P38-26 revealed that the receipt renderer (`formatNonNoteReceipts`) and the
  citation gate had drifted apart; falsifying it for the SESSION surface confirmed
  the same gap: `muse ask "what did we decide about the VPN MTU?"` answers from the
  episode and cites `[session: …]`, but no receipt showed — the continuous-companion
  core ("what did we discuss?") had no source attribution. Fixed in
  apps/cli/src/commands-ask.ts: a `sessions?` field + a `grab("💬 from a past
  session:", /\[session: …\]/, sources.sessions)` and the call site passes
  `sessions: episodeHits.map(e => e.summary)`. With feeds (P38-26) + sessions, ALL
  TEN non-note citation classes (task/event/reminder/session/feed/contact/command/
  commit/memory/action) now render a receipt. To stop this drift recurring, added a
  PARITY test that loops over all ten classes and asserts each renders a receipt —
  it would have caught the feed gap. Proof: 11 new unit tests (the session receipt +
  the 10-class parity guard) + LIVE on qwen3:8b with a seeded episode: `muse ask
  "what did we decide about the VPN MTU?"` now prints "💬 from a past session: We set
  up the office VPN … MTU 1380 …". cli 167 files / 1799 tests + `pnpm lint` 0/0.
  (87e61400)

- [x] **P38-28 The feed/contact grounding markers now embed the canonical
  `[feed: …]` / `[contact: …]` citation — fixing the ROOT CAUSE the P38-22 / P38-25
  normalizers patched post-hoc (and cleaning the STREAMED inline citation).** Tracing
  why the model kept citing feeds/contacts by slot or raw id (`[feed 1]`, `[from
  contact_<uuid>]`): the task / event / reminder / memory / commit grounding markers
  all embed the exact canonical citation inline (`…\n[event: <title>]\n<<end>>`) so
  the local model copies it, but the FEED and CONTACT markers did NOT — they showed
  only `<<feed N — name>>` / `<<contact N — id>>`, so the model improvised the slot /
  id form, which the chat-only path then STREAMS verbatim (the post-hoc normalizers
  only fix the buffered copy used for the gate + receipt, never the inline text the
  user already saw). Fixed in apps/cli/src/commands-ask.ts by adding
  `[feed: ${h.feedName}]` to the feed marker and `[contact: ${c.name}]` to the
  contact marker — matching the five markers that already do this. The post-hoc
  normalizers stay as a safety net. Proof: the full cli suite green (1799, no
  regression) + a real-LLM round-trip on qwen3:8b: `muse ask "latest HN headlines?"`
  now cites `[feed: HN]` INLINE (was `[feed 1]`) and `muse ask "what is Mina's
  email?"` cites `[contact: Mina Park]` INLINE (was `[from contact_<uuid>]`), each
  with its receipt — so the STREAMED answer is clean, not just the gated copy. cli
  167 files / 1799 tests + `pnpm lint` 0/0. (9a20b66b)

- [x] **P38-29 The wrong-value gate now catches a drifted EMAIL ADDRESS, not just
  a wrong number / named entity — the most dangerous contact-data drift.** P38-2
  escalates a `grounded` answer that asserts a NUMBER or capitalized NAMED ENTITY
  absent from the evidence to one judge pass (claim-level grounding). But an EMAIL
  fell through BOTH checks: `jane@acme.com` tokenizes to lowercase parts
  (jane/acme/com), so a drifted DOMAIN ("acme" for the note's "globex") is neither a
  pure digit nor a capitalized entity — a confident, high-coverage, cited answer
  asserting a WRONG email read `grounded` (verified: base verdict grounded @1.00
  ungated). For a contact / outbound surface that is the most dangerous drift: Muse
  confidently hands you a wrong address. Fixed in
  packages/agent-core/src/knowledge-recall.ts: `answerAssertsUnsupportedValue` now
  also extracts whole email addresses from the answer and flags any not present
  VERBATIM in the raw evidence text (case-insensitive), so a drifted email escalates
  to the same fail-OPEN judge pass that demotes it to "I'm not sure" on an unsupported
  verdict; a correct email (present in evidence) triggers NO extra pass, so there is
  zero latency/UX cost on the common path. Proof: 2 new unit tests in
  packages/agent-core/test/knowledge-recall-reverify.test.ts (a wrong-domain email
  demotes to ungrounded with the "value the evidence does not support" reason; a
  verbatim-matching email never escalates — uses the `never` reverifier) + the full
  @muse/agent-core suite green (112 files / 1401 tests) + a real-LLM round-trip on
  qwen3:8b: `muse ask "what is Jane Park's email?"` over a note holding
  `jane@globex.com` answers `jane@globex.com [from contacts.md]` cited, grounded, no
  spurious warning (the correct path is unbroken). agent-core 112 files / 1401 tests +
  `pnpm lint` 0/0. (ad74ce75)

- [x] **P38-30 The "shows its work" receipt is suppressed when the answer FAILS
  the grounding verdict — the edge no longer vouches for a fabrication.** Falsifying
  P37-19 surfaced a general edge-integrity hole: on the chat-only path the
  source receipt ("📎 From your notes (open to verify): • from clipboard — …") was
  printed UNCONDITIONALLY, BEFORE the grounding verdict ran — so an off-topic
  question answered from the model's own knowledge and cited to the grounded source
  ("The 2018 World Cup was won by France [from clipboard]") got BOTH a receipt
  vouching for it AND a contradictory "treat as unverified" warning below. A receipt
  is the edge's flagship "shows its work" artifact; showing it on an answer that
  failed its OWN grounding check lends false authority to exactly the fabrication the
  edge promises to drop. Fixed in apps/cli/src/commands-ask.ts by moving the receipt
  render to AFTER the verdict and gating it on `!verdictNotice`: a receipt now prints
  ONLY when `groundingVerdictNotice` stays silent (the answer passed). An ungrounded
  answer shows the warning alone; a refusal (no citation) renders nothing as before;
  a genuinely grounded answer keeps its full receipt. Affects EVERY grounding source
  (notes / --file / --url / --clipboard / contacts / tasks / …), not just the one
  that surfaced it. Proof: 2 new tests in commands-ask-grounding-verdict.test.ts (an
  ungrounded answer fires the verdict AND would render a receipt without the gate —
  so suppression does real work; a grounded answer stays silent AND renders its
  receipt) + the full cli suite green (168 files / 1806 tests) + LIVE on qwen3:8b: an
  off-topic clipboard question now shows the "treat as unverified" warning with NO
  "📎 From your notes" receipt, while an on-topic question keeps its cited receipt.
  cli 168 files / 1806 tests + `pnpm lint` 0/0. (this commit)

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

- [x] **P39-3 No more "cite as:" leaking into the answer (front-door polish).**
  The note marker handed qwen3:8b a copy-ready `cite as: [from FILE]` token; the
  small model often copied the WHOLE line, leaking the label — "You set the MTU
  to 1380. **cite as:** [from …vpn.md]" — right on `muse demo`, the first thing a
  new user sees. Root fix: the marker now prints just `[from FILE]` (no "cite as:"
  to copy) + the citation instructions reference the `[from …]` tag; plus a
  deterministic `stripEchoedCiteAs` safety net for the buffered paths. Proof: 4
  unit tests (`commands-ask-cite-as.test.ts`: strips an echoed label before a
  real citation across classes; leaves a clean citation and ordinary "cite as"
  prose untouched) + a LIVE `muse demo` (the MTU answer now reads "…WireGuard VPN
  [from 2026-03-03-vpn-wireguard.md]" — label gone, the RIGHT source still cited,
  citation reliability preserved) + `--with-tools` still cites cleanly. cli 1695 +
  `pnpm lint` 0/0. (2fcdcda4)

- [x] **P39-4 `muse today` stops crying "API not reachable" at the local-first
  user.** The morning briefing tried the API daemon first and, on the expected
  ECONNREFUSED (the default user runs no daemon — local-first is the identity),
  printed "muse: API not reachable — falling back to local briefing." on EVERY
  run — an error-shaped line on the working happy path. Now it warns ONLY when
  the user EXPLICITLY pointed Muse at an API (`--api-url` / `MUSE_API_URL`, i.e.
  they expect a remote and would want to know it's down); the default CLI user
  silently gets the on-disk briefing. Proof: 4 unit tests (`apiWasExplicitlyConfigured`:
  false for unset/blank/whitespace, true for flag or env) + a LIVE `muse today`
  (0 warnings by default; 1 warning when `MUSE_API_URL` is set and unreachable).
  cli 1699 + `pnpm lint` 0/0. (6614a642)

- [x] **P39-5 `muse ask "what's in my notes?"` lists the corpus instead of
  refusing.** A whole-corpus OVERVIEW request ("what's in my notes?", "summarize
  my notes", "list my notes", "what notes do I have") isn't a top-K recall —
  every note matches weakly, so the gate refused and the warm-close told a user
  WHO HAS NOTES to "add a note on this and I'll have it next time" (nonsensical).
  A new precision-first `classifyCorpusOverview` (agent-core, EN+KO, anchored so
  "what's in my notes about the VPN?" / "summarize my VPN notes" do NOT match)
  short-circuits it to a deterministic inventory — "You have N notes: …" with the
  relative paths — no model call, no fabrication. Proof: classifier unit tests
  (overview EN+KO match; a specific question ending in its topic does not) +
  `listNoteFiles` / `formatCorpusOverview` unit tests + a LIVE `muse ask "what's
  in my notes?"` (lists `lease.md` + `projects/vpn.md`, the user can now SEE
  their corpus) while `muse ask "what is my rent?"` still recalls + cites.
  agent-core 1353 / cli 1709 + `pnpm lint` 0/0. (c0644ab4)

- [x] **P39-6 No more false promise of action on the chat-only path.** Ask `muse
  ask "remind me to call the dentist tomorrow"` WITHOUT `--with-tools` and the
  model said "I'll remind you to call the dentist tomorrow" — a FALSE PROMISE
  (the no-tools path can't act, so nothing was set; it even fabricated a
  `[reminder: …]` citation the gate then stripped). A new precision-first
  `classifyActionRequest` (agent-core, anchored on the imperative action verb so
  "what reminders do I have?" / "how do I set a reminder" do NOT match) now, on
  the chat-only path, replies honestly: "That's something to DO… re-run with
  `--with-tools` and I'll actually do it (I ask before any outbound send)."
  `--with-tools` is untouched — it really sets the reminder (`muse.reminders.add`).
  Proof: classifier unit tests (imperatives EN match incl. polite leads;
  questions about actions don't) + an ACTION_GUIDE guard (mentions --with-tools +
  ask-first, never claims it acted) + a LIVE before/after (default → the honest
  guide, no false promise; `--with-tools` → "I've set a reminder…"; "what
  reminders do I have?" → still recalls). agent-core 1355 / cli 1710 +
  `pnpm lint` 0/0. (76a298d5)

- [x] **P39-7 A `--with-tools` ACTION confirmation reads clean — no recall noise.**
  `muse ask "set a reminder to submit taxes friday" --with-tools` set the reminder
  but led with "(grounded on 1 note chunk(s) — lease.md ⚠ LOW confidence)" — a
  recall banner about an unrelated note — and warned "Removed 1 citation … (muse.reminders.add)
  — treat as unverified" when the model cited the tool name. Both are noise on a
  successful ACTION (the user wanted Muse to DO something, not recall). Now, when
  `classifyActionRequest` matches, the recall grounding banner is suppressed and the
  stripped-citation WARNING is silenced (the text is still cleaned — the spurious
  tool-name token never reaches the user). RECALL is untouched (still banners +
  cites). Proof: a LIVE before/after `muse ask "add a reminder …" --with-tools`
  (now just "(tools used: muse.reminders.add)" + the confirmation, no banner / no
  warning) while `muse ask "what is my rent?"` still shows "(grounded on … lease.md)"
  + cites "1,250,000 KRW [from lease.md]". cli 1710 + `pnpm lint` 0/0. (316ec2d7)

- [x] **P39-8 Honesty backstop: no false action promise even in a MIXED request.**
  P39-6 short-circuits a PURE imperative ("remind me to…"), but a MIXED "what is my
  rent AND remind me to pay it tomorrow" (starts with a question) flowed through —
  Muse answered the rent (cited) then added "I will remind you to pay it tomorrow",
  a false promise on the no-tools path. A new `answerPromisesAction` (agent-core)
  keyed off the ANSWER (not the query) — it matches an action-TOOL claim ("I'll
  remind you / set a reminder / add a task / schedule / email", "I've set/added/
  scheduled") but not conversational "I'll explain" or a recall "you have a
  reminder" — so on the chat-only path Muse appends an honest correction: "(Heads
  up: I can't actually set reminders, tasks, or events on this path — re-run with
  `--with-tools` to do that.)". --with-tools is untouched (the claim is TRUE there).
  Proof: detector unit tests (claims match incl. mixed; cited answer / "I'll
  explain" / "you have a reminder" don't) + a LIVE mixed `muse ask "what is my rent
  and remind me to pay it tomorrow"` → the rent answer THEN the honest correction.
  agent-core 1357 / cli 1710 + `pnpm lint` 0/0. (this commit)

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

- [x] **P35-11 Muse now notices the most common way you voice a commitment —
  "I'll …" / "I will …" / "I'm going to …" — not just "I need/have to".** The
  SF-confidant "anticipates" quality runs on `detectUserCommitments` (the
  deterministic rule engine behind `muse commitments scan` + `muse checkins scan`,
  which read recent chat for things you said you'd do and offer to track them). It
  caught "I need to" / "I have to" / "I should" + Korean, but MISSED the single most
  common English phrasing — a stated intent: `muse commitments scan` over a chat
  with "I'll call the dentist tomorrow" / "I'm going to review the PR" found NOTHING.
  Fixed in packages/agent-core/src/commitment-detector.ts: two new rules (`I'll` /
  `I will` and `I'm going to` / `gonna`) → a new `"will"` kind, with a small
  stative-starter guard ("I'll be late", "I'll see", "I'll bet/say" are remarks, not
  tasks) and the existing question filter ("Will I make it?" stays a non-commitment).
  Proof: 2 new unit tests (the four intent forms detected as kind `will`; the stative
  / question forms NOT) + the full agent-core suite green (1399) + the cli build
  green (the new kind breaks no consumer) + LIVE end-to-end: seeding
  `~/.muse/last-chat.jsonl` with "I'll call the dentist tomorrow about the
  appointment" and running `muse commitments scan` now surfaces "• call the dentist
  tomorrow about the appointment" (before: "No open commitments detected"). agent-core
  112 files / 1399 tests + `pnpm lint` 0/0. (this commit)

- [x] **P35-12 A commitment's follow-up check-in now fires AFTER the timeframe
  you stated, not always tomorrow.** P35-11 made Muse NOTICE a spoken commitment;
  this makes the follow-up land at a sensible time. `muse checkins scan` schedules a
  warm "how did it go?" nudge for each detected commitment — but every check-in was
  hardcoded to fire TOMORROW at 10:00 regardless of what you said: "submit the tax
  forms THIS WEEK" got nagged the very next morning, days before you'd plausibly have
  done it. Fixed in packages/mcp/src/commitment-checkin.ts with a new pure exported
  `followupDayOffset(commitment)` that reads the timeframe the user voiced (EN + KO)
  and pushes the check-in past it: "next week" / "다음 주" → +8 days, "this week" /
  "이번 주" / "by friday" → +5, "tomorrow" / "내일" / "next thursday" → +2, and a
  same-day or timeframe-less commitment → next day (the old default, unchanged); the
  per-commitment due is now computed inside the schedule loop instead of once up front.
  Proof: 2 new unit tests in packages/mcp/test/commitment-checkin.test.ts
  (`followupDayOffset` reads each EN+KO timeframe and defaults to 1; `scheduleCheckins`
  gives a "later today" / "this week" / "next week" batch three DISTINCT due dates) +
  the full @muse/mcp suite green (167 files / 1332 tests) + LIVE on the loop PC
  (today 2026-06-03): seeding `~/.muse/last-chat.jsonl` with those three commitments
  and running `muse checkins scan` schedules them for 2026-06-04 / 06-08 / 06-11
  respectively (before this fix all three were 2026-06-04 10:00). mcp 167 files / 1332
  tests + `pnpm lint` 0/0 — a user who says "I'll do X this week" is followed up at the
  end of the week, not nagged tomorrow. (this commit)

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

- [x] **P35-8 `muse brief` greets you by your REAL name or none — never an invented
  one (fabrication=0 on the felt surface).** Probing the morning briefing: with no
  name on file `muse brief` opened "Good morning, Alex." — the small model filled
  the "Good morning, ___" slot with an INVENTED name (consistent across runs, even
  for `--user bob`). On a "tell it everything, it knows you" assistant, being
  greeted by a name that isn't yours is a fabricated fact AND a trust-puncturing
  felt miss. Fixed: a `resolveUserName(facts)` helper reads the user's actual name
  from a `name` / `first_name` / `nickname` / … fact, and the greeting instruction
  is now conditional — "Address the user as '<name>'" when known, else "No name is
  on file — open with a plain time-of-day greeting and do NOT invent/guess one."
  The briefing CONTENT was already faithful (it accurately stated a real task +
  reminder); this closes the one fabricated slot. Proof: 3 new `resolveUserName`
  unit tests (name variants resolved; no-name → undefined so the greeting stays
  generic; blank ignored) + LIVE: no name → "Good morning" ×3 (no "Alex"); after
  `muse remember "my name is Jinan"` → "Good morning, Jinan". cli 165 files / 1747
  tests + `pnpm lint` 0/0. (this commit)

- [x] **P35-9 The "empty notes" on-ramp no longer contradicts itself for a user who
  has OTHER personal data.** Probing the felt experience: a user with a contact (or
  a task, or a remembered fact) but no NOTES asked `muse ask "what is Mina's email?"`
  — Muse answered correctly from the contact, yet ALSO printed the first-run on-ramp
  "(your notes corpus is empty — Muse only answers from notes you've added · try
  `muse demo` …)" on the SAME turn. Both wrong: it nags to add notes, and the claim
  "Muse only answers from notes" is false (it just answered from the address book) —
  and it fires on EVERY ask for such a user. Fixed in apps/cli/src/commands-ask.ts:
  `corpusOnboardingHint(noteFileCount, hasOtherPersonalData)` now suppresses the
  hint when the user has any non-note personal data, and a new
  `userHasOtherPersonalData(userId, env)` checks the remembered-facts file +
  contacts + tasks + reminders (best-effort, short-circuiting) — probed ONLY when
  notes are empty, so a notes-having user pays no extra reads. A genuinely empty
  Muse still gets the on-ramp. Proof: 2 new unit tests (suppressed when
  hasOtherPersonalData; still shown for a truly-empty Muse) + LIVE on qwen3:8b: with
  a contact and no notes the on-ramp is GONE and the answer + "👤 from your contacts"
  receipt show; with only a remembered fact (`muse remember "my name is Jinan"`) the
  on-ramp is GONE and "what is my name?" answers from memory; a brand-new empty HOME
  still shows the on-ramp. cli 167 files / 1778 tests + `pnpm lint` 0/0. (a4aba92b)

- [x] **P35-10 The "empty notes" on-ramp also stays silent when the query SUPPLIES
  its own grounding (`--file`/`--url`/`--git`/`--shell`) or the user has past
  sessions.** Observed while falsifying P37-18: `muse ask --url https://example.com
  "…"` answered correctly FROM the page yet still printed "(your notes corpus is
  empty — Muse only answers from notes you've added …)" — nagging a user who told
  Muse EXACTLY what to ground on, and falsely (the answer came from the URL). Same
  felt-honesty class as P35-9, which only checked the persistent stores
  (memory/contacts/tasks/reminders) and missed (a) a per-query ad-hoc source and (b)
  a continuous-companion user with episodes. Fixed in apps/cli/src/commands-ask.ts:
  a new exported `queryHasAdHocGrounding(options)` (true for a non-blank
  `--file`/`--url` or `--git`/`--shell`) suppresses the on-ramp for this query, and
  `userHasOtherPersonalData` now also counts past sessions (episodes for the user).
  A genuinely empty Muse with a plain query still gets the on-ramp. Proof: 3 new
  unit tests (queryHasAdHocGrounding true for each flag, false for a plain/blank
  query, and it suppresses corpusOnboardingHint) + LIVE on qwen3:8b: `--url
  example.com` and `--file doc.txt` (no notes) answer with NO on-ramp; an
  episodes-only user's "what did we discuss?" has NO on-ramp; a plain off-corpus
  query on an empty HOME still shows it. cli 167 files / 1787 tests + `pnpm lint`
  0/0. (cfa25822)

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

- [x] **P34-12 `muse doctor` tells the TRUTH about the local-only model (the moat
  must be visible AND believable).** Under `MUSE_LOCAL_ONLY` (default-ON), the
  runtime IGNORES any ambient cloud key and runs the local `qwen3:8b` — but `muse
  doctor` reported "model env: inferred from GEMINI_API_KEY" (a WARN) on any box that
  merely carried a Gemini key. So a privacy-bound user running the doctor to CONFIRM
  nothing leaves their machine was told their model is Gemini — the doctor undercut
  the exact guarantee local-only exists to give. Extracted a pure `modelEnvCheck(env)`
  that mirrors `resolveDefaultModel`: under local-only it reports "ollama/qwen3:8b
  (local-only default — ambient cloud keys ignored)" (ok); the cloud-credential
  inference (warn) appears ONLY under an explicit `MUSE_LOCAL_ONLY=false`. Bonus: the
  doctor's "ollama model pulled" check now uses the RESOLVED model, so under
  local-only it verifies qwen3:8b is actually pulled (it was silently skipped before,
  since no MUSE_MODEL was set). Proof: 5 new `modelEnvCheck` unit tests (local-only +
  GEMINI key → local model not "inferred from GEMINI"; default env; explicit opt-out →
  warn inferred; explicit MUSE_MODEL verbatim; opt-out + no key → fail) + 2 existing
  program tests corrected to opt out for the cloud path + a LIVE `muse doctor` in all
  three scenarios. cli 164 files / 1738 tests + `pnpm lint` 0/0. (dad5ddaf)

- [x] **P34-13 A refusal reads CLEAN — no self-contradicting "treat those claims as
  unverified" warning.** P34-11 made a refusal cite nothing; this kills the OTHER
  refusal noise. When the small model tacks a spurious citation onto a refusal
  ("저는 …정보를 가지고 있지 않습니다 [from n.md]"), the gate strips it — but then
  printed "Removed 1 citation … treat those claims as unverified", which is
  nonsensical on an answer that asserts NO claim (and especially jarring for a
  Korean user, where the small model fabricates a citation on a refusal more often).
  Extracted `shouldWarnStrippedCitations` and gated the notice on `!isRefusal` (it
  already skips action requests); the spurious citation is still stripped from the
  text — only the user-facing warning is suppressed on a refusal. Proof: 4 new unit
  tests (fires on a claim-bearing answer; SILENT on a refusal / action request /
  nothing-stripped / --json) + LIVE: a Korean must-refuse ("내 혈액형이 뭐야?") and an
  English one both show the warm "add a note" nudge with ZERO "Removed citation"
  warning; a non-refusal with a fabricated citation still warns. cli 165 files /
  1755 tests + `pnpm lint` 0/0. (this commit)

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
