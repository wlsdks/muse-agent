# Catalog 03 — Personal-assistant domain data + daily-life surfaces

Repo: /Users/jinan/side-project/Muse · Date: 2026-06-14 · CLI dist verified present.
Verification base: `node apps/cli/dist/index.js <cmd> --help </dev/null` + live read-only runs.
Status legend: ✅ ran live · 🧪 tests as evidence · ⬜ code-only · ⚠️ broken/suspicious.

---

## A. Packages

### packages/calendar — provider-neutral CalendarProvider abstraction
- **What:** One `CalendarProvider` interface, fan-out registry, **five** adapters (ids: `local`/`ics`/`gcal`/`caldav`/`macos`). All exported from `src/index.ts`.
  - `LocalCalendarProvider` (`~/.muse/calendar.json`), `LocalIcsCalendarProvider`,
    `GoogleCalendarProvider` (OAuth/REST v3), `CalDAVCalendarProvider` (REPORT/PUT/DELETE iCalendar), `MacOsCalendarProvider` (osascript).
  - `CalendarProviderRegistry` (registry.ts): parallel `listEvents` fan-out, swallows per-provider errors (local file still yields), `listEventsWithDiagnostics` names failed providers. Mutations route to one provider; `requireOrPrimary` treats hallucinated ids `default`/`primary` as primary (defensive against small-model invented ids).
  - Helpers: `eventsToIcs`/`parseIcsCalendar`/`expandRecurringEvent`, `compareCalendarEvents`, `CalendarProviderError`/`CalendarValidationError`, retry helpers, credential-store, corrupt-quarantine.
- **Status:** 🧪 — 13 test files under `packages/calendar/test/` (registry, local-provider, local-ics, google-provider, caldav-provider, caldav-ics, macos-provider, ics-export, calendar-write-contract, compare-calendar-events, credential-store, errors, calendar.test.ts). NOTE: no `*.test.ts` colocated in `src/` (all in `test/`) — fine, just where to look.
- **Doc drift:** README §calendar accurately lists 4 adapters + paths; `MUSE_CALENDAR_FILE`/`MUSE_CALENDAR_PROVIDERS` env documented. README capability matrix marks Google/CalDAV/macOS `scaffold` (need real creds to exercise live), Local `live`. Reasonable.

### packages/scheduler — DynamicScheduler (cron-driven jobs)
- **What:** `DynamicScheduler` class + `createSchedulerTools()` MuseTools. Job types `mcp_tool` | `agent`; cron + timezone validation, retry config, execution-timeout, template-variable rendering, locks (scheduler-locks.ts), stores (scheduler-stores.ts), validation (scheduler-validation.ts). Backed by Postgres (scheduled-job rows + execution rows).
- **Status:** 🧪 — 5 test files (scheduler.test.ts, scheduler-validators, scheduler-helpers-templating, scheduler-locks, plus colocated scheduler-helpers.test.ts).
- **Surface:** drives `muse scheduler` CLI (below). Requires the API server for `list`/`create-agent`/`trigger` (no `--local`).

---

## B. CLI commands (top-level) — all respond to --help ✅

### calendar  (read-only-described surface, but has write subcommands)
Subcommands captured: `providers`, `events`, `export`, `free`, `focus`, `block`, `conflicts`, `add`, `delete`, `edit`, `tomorrow`, `this-week`, `show`, `import`.
- **providers** ✅ ran (`--local` → `local [local] — Local file`).
- **events** ✅ ran (`--local` → no events; --from/--to default now→+30d).
- **free** ✅ ran (`--local` → "Free all of …"; --min-minutes gap filter).
- **focus** ✅ ran — longest uninterrupted free block per day (attention-residue, Leroy 2009). Deterministic, no model.
- **conflicts** ✅ ran (`--local` → "No double-booked events ✓"). Window now→+30d.
- **block** ⬜ code-only (WRITE — creates an event in earliest free slot; not run to avoid mutation). Gollwitzer 1999 time-blocking.
- **add** ⬜ code-only (WRITE; `--at` ISO/relative incl. Korean, `--for` mins, `--location`, **`--remind <minutes>`**, `--repeat daily|weekly|monthly|yearly`, `--json`).
- **edit / delete / show / import / export / tomorrow / this-week** — code-only (write/IO); `export` serializes all-day+timed+location/notes to RFC 5545.
- **`--remind` linkage VERIFIED in code** (`commands-calendar.ts`): `add --remind N` builds a reminder via `buildEventReminder(..., event.id)` — reminder carries `eventId` linking it to the event; on `calendar delete` the linked reminder is cleaned up (best-effort) so a cancelled event stops firing. Matches MEMORY note `calendar_reminder_link`.
- **All-day conflict handling VERIFIED in code** (`conflictWarningForNewEvent`): a NEW all-day event returns NO warning (it would otherwise "overlap" every timed event), and all-day EXISTING events are filtered out of the timed-overlap check. Sound design.
- **Status overall:** ✅ read-only paths ran; 🧪 48 tests in `commands-calendar.test.ts` + focus 17 in `calendar-focus.test.ts`.

### tasks  (Personal todo list)
Subcommands: `providers`, `flow`, `next`, `list`, `open-loops`, `add`, `complete`, `edit`, `delete`.
- **list** ✅ ran `--local` (31 open tasks; `--status open|done|all`, `--tag <label>`, `--local`).
- **next** ✅ ran — EDF + anti-starvation aging ("What to do next"). Reads local by DEFAULT.
- **flow** ✅ ran — Little's-Law created-vs-completed rate, backlog trend, lead time (last 7d). Reads local by default.
- **open-loops** ✅ ran — unfinished+unscheduled tasks (Zeigarnik/Ovsiankina).
- **add/complete/edit/delete** ⬜ code-only (WRITE).
- **Status:** ✅ read paths + 🧪 commands-tasks 36 + task-flow 8 + task-priority 9 + task-completion 7.
- **⚠️ Minor drift:** `tasks next` and `tasks flow` help text reads "reads the local tasks file" but they REJECT a `--local` flag (`error: unknown option '--local'`) — they always read local. Not broken, but inconsistent with `list/add/complete/edit/delete` which DO take `--local`. Doc/UX nit only.

### remind  (Personal reminders — passive, surfaced in `today`)
Subcommands: `add`, `list`, `snooze`, `fire`, `run`, `history`, `clear`.
- **list** ✅ ran (4 pending incl. a "(repeats daily)"). Falls back to local store when API down (prints a notice).
- **history** ✅ ran ("(none)").
- **add** ⬜ (WRITE; `<when>` ISO/relative incl. KR, `--repeat daily|weekly|monthly`, `--channel`).
- **snooze/fire/clear** ⬜ (WRITE); **run** ⬜ (Phase-B firing loop — delivers via messaging, do NOT run).
- **Status:** ✅ read paths + 🧪 commands-remind 25.

### contacts  (People graph — ~/.muse/contacts.json)
Subcommands: `add`, `import`, `export`, `birthdays`, `dupes`, `list`, `overdue`, `link`, `resolve`, `network`, `related`, `encrypt`, `decrypt`, `encryption-status`.
- **list** ✅ ("No contacts yet"). **dupes** ✅ ("✓ No likely-duplicate"). **birthdays** ✅ ("none in next 30d"). **overdue** ✅ ("No contacts").
- **related** ⬜ — PMI co-occurrence from notes (Church & Hanks 1990), the inferred sibling of explicit `link`.
- **network** ⬜ — direct + 2-hop circle. **resolve** ⬜ — reports AMBIGUOUS/not-found, never guesses (outbound-safety recipient rule).
- **link** ⬜ (WRITE edge). **add/import/export** ⬜ (WRITE/IO; `add` flags `--email/--phone/--alias.../--birthday MM-DD`).
- **encrypt/decrypt/encryption-status** ⬜ — AES-256-GCM at rest (key = MUSE_MEMORY_KEY or per-host). `encryption-status` needs no key.
- **Status:** ✅ read paths + 🧪 commands-contacts 27 + contact-dupes 5 + contact-network 10 + contact-cooccurrence 8.

### today ✅ ran (`--local`)
Morning briefing: overdue/open tasks + next-24h calendar + recent notes. Flags: `--json`, `--lookahead-hours`, `--local`, `--brief` (NL summary via model), `--model`, `--speak`+`--audio-voice`/`--audio-format` (TTS), `--save-to-notes`, `--connect` (related past notes). ✅ printed overdue tasks. 🧪 commands-today 62 + today-stale-revisit + commands-today-api-warn.

### brief ⬜ code-only — "One-command morning briefing" (JARVIS-style). Flags `--user`/`--persona`/`--model`/`--speak`. Distinct from `today` (this is the daemon/persona-slot variant). 🧪 commands-brief 22 + brief-conflicts + brief-feeds + brief-reflection.

### recap ✅ ran — Evening recap (retrospective sibling of `brief`): "got done today" + slipping + open loops. `--json`. 🧪 commands-recap 26.

### week ✅ ran — Next 7 days at a glance: events + due tasks + birthdays + daily weather, grouped by day. `--json`. Read-only, local. 🧪 commands-week 12.

### commitments  (Open loops voiced in chat)
- **scan** ✅ ran ("No open commitments detected"). **track <number>** ⬜ (WRITE → task). 🧪 commands-commitments 7.

### checkins  (Proactive check-ins — daemon asks how it went)
- **list** ✅ ran ("No scheduled check-ins"). **scan** ⬜ (WRITE; schedules due-windowed check-ins). **cancel/snooze** ⬜. 🧪 commands-checkins 13.

### followup  (Self-queued follow-up promises, auto-captured)
- **list** ✅ ran (20 scheduled). **show** ⬜, **snooze/cancel** ⬜ (WRITE). 🧪 commands-followup 4 (thin coverage).

### objectives  (Standing objectives pursued autonomously)
- **list** ✅ ran ("No objectives"). **add/cancel/done** ⬜ (WRITE). Outbound actions need recorded scoped consent (outbound-safety). 🧪 commands-objectives 11.

### anomaly ✅ ran — Most unusual days vs own history (robust z-score; reported 18.7σ etc.). `--json`. Local, deterministic, draft-first. 🧪 commands-anomaly 3 (thin).

### scheduler  (cron jobs — needs API)
Subcommands: `list`, `create-agent`, `trigger`, `dry-run`, `delete`, `executions`, `next`.
- **next** ✅ ran (showed followups soonest-first; aggregates scheduler jobs + reminders + followups). 
- **list** ⚠️ requires the API server — no `--local` (printed "Muse API not reachable … Re-run with --local" but `--local` is NOT actually supported by `scheduler list`; the error message suggests a flag the subcommand doesn't accept). Mild UX drift.
- Backed by packages/scheduler DynamicScheduler. 🧪 commands-scheduler-setup.test.ts + scheduler pkg 5 files.

---

## C. Deterministic data tools (ecology/biology/forensics-derived) — ALL VERIFIED COMPUTING ✅

Tested with throwaway /tmp CSVs (exp.csv: category,amount; weight.csv: kg).

- **csv** ✅ — exact aggregates. `--sum amount` → 3403.84; `--sum --group-by category` correct; `--count --where category=food` → 4. Flags: `--sum/--avg/--min/--max/--count/--where/--group-by/--json`. Deterministic, no model.
- **benford** ✅ — Benford leading-digit + Pearson χ² (Benford 1938 / Pearson 1900). Printed observed-vs-expected table, chi-square 3.17, AND a correct guardrail warning ("Only 10 values — below 30 unreliable") + scope note (not for bounded values). 🧪 benford 9.
- **trend** ✅ — Mann-Kendall + Sen's slope (Mann 1945 / Kendall 1975). On falling weight col → z=-3.58, slope -0.22/step, "Strongly DECREASING (p<0.01)". Reads rows in time order. 🧪 trend 9.
- **diversity** ✅ — Shannon H' + Gini-Simpson + Pielou evenness J' (Shannon 1948 / Simpson 1949). H'=1.280 (max 1.386), Gini-Simpson 0.700, J'=0.923, most-abundant food 40%. 🧪 diversity 7.
- (Sibling tools also present, slightly outside the named list but same family: `muse on-this-day` date-cued recall ✅ exists/registered; `muse notes bridges` brokerage/keystone — outside this domain.)
- 🧪 csv-aggregate 18 tests.

---

## D. Doc drift summary (vs docs/FEATURES.md, docs/SYSTEM-MAP.md, README.md)

HIGH — features entirely MISSING from feature docs:
1. **`muse anomaly`** — NOT in FEATURES.md, SYSTEM-MAP.md, or README. Fully shipped + ran live (robust most-unusual-days). No mention anywhere.
2. **`muse recap`** (evening recap) — NOT in FEATURES.md, SYSTEM-MAP.md, or README. Shipped + ran live.
3. **Calendar section is badly under-documented.** FEATURES.md §일정 lists only 4 items (multi-provider, CRUD, free-time, .ics export). MISSING: `conflicts` (double-booking detection incl. all-day handling), `focus` (longest free block, Leroy 2009), `block` (time-blocking, Gollwitzer 1999), `tomorrow`/`this-week`/`show`, `import` (bulk .ics), and the **`--remind` event→reminder linkage** (a notable cross-store feature, only in MEMORY notes, not user docs). SYSTEM-MAP §4 same gap.
4. **Tasks analytics missing from FEATURES.md:** `tasks flow` (Little's Law), `tasks next` (EDF + aging), `tasks open-loops` (Zeigarnik). FEATURES lists only add/CRUD/urgent/due/tag.
5. **Contacts analytics partly missing from FEATURES.md:** `dupes`, `overdue`, `link`, `network`, `related` (PMI), encrypt/decrypt. FEATURES §연락처 covers only store/import/birthday/recipient-resolution.

MEDIUM:
6. **`muse week`** is in README but NOT in FEATURES.md / SYSTEM-MAP.md feature lists.
7. The data tools (`benford`/`trend`/`diversity`/`csv`/`on-this-day`/`calendar focus`/`calendar block`) are documented well in README's "research-derived levers" tables but are ABSENT from FEATURES.md / SYSTEM-MAP.md proper feature sections.

LOW (UX/help-text nits, not stale doc claims):
8. `tasks next` / `tasks flow` help says "reads the local tasks file" yet reject `--local` (always local). Inconsistent with sibling subcommands that accept `--local`.
9. `scheduler list` error message suggests "Re-run with --local" but `scheduler list` does not implement `--local` (needs the API server). Misleading hint.

NO false/over-claims found in the docs that were checked — the drift is all UNDER-documentation (shipped features absent), which is the safer direction but leaves the calendar/tasks/contacts surfaces looking far thinner than reality.

---

## E. Broken / suspicious

- Nothing functionally BROKEN. All read-only commands ran and the four data tools compute correctly with sane guardrails.
- Only suspicious items are the two help-text/flag inconsistencies (D8, D9) — cosmetic, not failures.
- Live data state note (not a bug): `tasks list` shows 31 stale test-seeded tasks ("테스트 …"), `recap` "got done today (556)" is dominated by web-action test entries, `followup list` shows 20 past-due test followups, `anomaly` flags loop-busy days. This is dev/test residue in the local stores, not a code defect.
