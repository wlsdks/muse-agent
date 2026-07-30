---
title: Muse feature definitions (per-feature detail)
audience: [planners, developers, AI agents]
purpose: Detailed definition of what each feature is and how it behaves from the user's perspective
status_legend:
  "✅": usable right away (SYSTEM-MAP's ✅ means a different thing: verified against the codebase)
  "⚙️": needs external integration/setup
  "⚠️": known gap (not yet trustworthy enough)
updated: 2026-07-13
related: [../strategy/attunement.md, ../design/attunement/README.md, SYSTEM-MAP.md, ../README.md, ../strategy/positioning/differentiation.md]
---

# Muse feature definitions (for planners)

> **What is this document?** It defines, feature by feature, what Muse "can actually do right now."
> It explains **what each feature is and how it behaves from the user's perspective** — not code
> structure or implementation. It is meant for people making product and design decisions, not
> developers.
>
> Status legend: ✅ usable right away · ⚙️ needs external integration/setup · ⚠️ known gap (not yet trustworthy enough)
>
> **Related documents:** product direction is [`../strategy/attunement.md`](../strategy/attunement.md) ·
> **the verified full feature inventory (with evidence) is
> [`../benchmarks/EVIDENCE.md`](../benchmarks/EVIDENCE.md)** (published evidence, with the failures kept visible).
>
> ⚠️ This document is a high-level narrative and does not enumerate every CLI command 1:1.
> Additional command surfaces — `anomaly` · `recap` · `week` · `daemon` · `watch-folder` ·
> `webhook` · `feeds` · `routine` · `history`/`open` · `propose`/`approvals` etc. — and per-command
> evidence live in the evidence index above.

## Contents

1. [Conversation & agent execution](#1-conversation--agent-execution)
2. [Personal assistant domain (calendar, tasks, reminders, contacts, notes, memory)](#2-personal-assistant-domain-calendar-tasks-reminders-contacts-notes-memory)
3. [Perception](#3-perception--the-ability-to-see-the-world)
4. [Knowledge & search](#4-knowledge--search)
5. [Proactivity & autonomous action](#5-proactivity--autonomous-action--the-jarvis-that-speaks-first)
6. [Acting outward (Reach / Actuator) + safeguards](#6-acting-outward-reach--actuator--safeguards)
7. [Voice](#7-voice)
8. [Multi-agent collaboration](#8-multi-agent-collaboration)
9. [Trust, safety, accountability](#9-trust-safety-accountability-the-cross-cutting-foundation)
10. [Observability & operations](#10-observability--operations)
11. [Usage surfaces](#11-usage-surfaces-where-you-use-it)
- [Maturity at a glance](#maturity-at-a-glance) · [Known gaps](#known-gaps) · [Attunement — aspirational roadmap](#attunement--aspirational-roadmap-north-star)

---

## Muse in one line

**Muse is a personal AI agent that continuously understands and helps one person's life and work.**
The full product picture is a continuing companion that connects calendar, notes, relationships,
environment, and work. Getting better and better at when to stay quiet and when to offer which
help is what we call `Attunement`. You can choose among multiple companies' models and local
models, but the full Attunement learning loop is still roadmap
([product direction](../strategy/attunement.md)).

Two traits run through every feature:

- **Proactive** — speaks up before being asked. Watches calendar, tasks, patterns, and follow-up
  promises and lets you know on its own.
- **Instantly responsive** — when called, handles the request to completion on the spot. Not a
  command parser but a companion that finishes the job.

And **any action that goes outward (messaging someone else, booking/submitting, etc.) only runs
after a human gives final confirmation.** A wrongly sent message cannot be recalled, so this is
designed as a **blocked-by-default safeguard (fail-close)**, not a "please be careful" prompt.
Banking, payments, and money transfer are permanently out of scope.

---

## 1. Conversation & agent execution

The most basic channel for talking to Muse, and the center every feature converges on.

- **General conversation** ✅ — ask in natural language and get an answer. When needed it picks
  tools on its own (time lookup, note search, adding calendar events, etc.) and synthesizes the
  results into an answer.
- **Streaming responses** ✅ — the answer flows out in real time, character by character, and the
  moment a tool is used it shows "currently using tool ○○."
- **Tool-use loop** ✅ — can chain multiple tools within one conversation turn, but with **a count
  cap and a time limit** so it never loops forever.
- **Plan & Execute mode** ✅ — complex requests first get a step-by-step plan → each step is
  executed → results are combined into the final answer. If everything fails midway it safely falls
  back to just answering directly.
- **Continuous conversation / memory** ✅ — carries prior conversation context forward, and
  automatically pulls in past-session summaries and user facts to inform answers.
- **Clarify** ✅ — for requests with an unclear target like "do that thing," it does not guess and
  execute; it **asks back what you mean**.

---

## 2. Personal assistant domain (calendar, tasks, reminders, contacts, notes, memory)

The area that directly manages the user's personal life data. All data is stored on the user's own
device/account.

### Calendar
- **Multi-calendar integration** ⚙️ — Google Calendar, CalDAV, the macOS system calendar, and a
  local file calendar can be used together.
- **View, add, edit, delete events** ✅ — creates and changes events from natural language like
  "book a meeting tomorrow at 3."
- **Free-time finding (availability)** ✅ — for "am I free tomorrow afternoon?" or "find me a
  30-minute gap," it merges events and computes the open slots.
- **iCalendar (.ics) export** ✅ — exports events as a standard `.ics` file to carry into other
  calendar apps (Google/Apple etc.) (`muse calendar export --out plan.ics`). Serializes all-day and
  timed events, location, and notes in RFC 5545 format.

### Tasks
- **Add, list, complete, edit, delete tasks** ✅ — understands natural-language deadlines like
  "report by next Monday 6pm."
- **Urgency flag** ✅ — say "it's urgent…" and it stores an urgent flag, highlighted with ⚠ on
  other screens.
- **Due-soon view** ✅ — answers "what's due today?" filtered by deadline.
- **View by tag** ✅ — filter the list by tags attached to tasks (e.g. work, home)
  (`muse tasks list --tag work`). Tags that used to be storage-only are now usable in queries.

### Reminders
- **Create, list, snooze, fire reminders** ✅ — manual reminders that fire at a set time. Also
  appear in the morning brief.
- **Recurring reminders** ✅ — supports repeats like "every morning" or "every Monday."

### Follow-ups
- **Automatic capture** ✅ — promises made mid-conversation like "I'll do ○○ for you later" are
  **remembered by Muse itself, queued**, and fired when due.
- **Recovering my open loops** ✅ — deterministically extracts **your own unresolved commitments**
  dropped in conversation ("I need to …") and shows them (`muse commitments scan`). These are
  things not yet registered as tasks/reminders, so you just pick the ones worth tracking and
  register them. When you reopen a session, the "where were we" summary surfaces them first as
  **"N open items you mentioned"** so they aren't forgotten.
- **Proactive check-ins on open commitments** ✅ — schedules a check-in that **asks you first the
  next day** about commitments you said you'd do (`muse checkins scan`); when due, the daemon
  **speaks first**: "the other day you said you'd '…' — how did it go?" Daily cap, dedup, and
  quiet hours (DND) apply, and only on your own channel. Check with `muse checkins list`. You can
  also enable a setting that automatically scans a session's open commitments at session end and
  schedules check-ins (off by default; fails silently). Even if you never look at the daemon
  channel, due check-ins surface directly when the chat is idle (read-only — already-sent ones
  don't reappear).

### Contacts (People Graph)
- **Store and look up contacts** ✅ — manages name/email/phone/aliases/birthday. Answers "what was
  Mom's number?"
- **Bulk address-book import** ✅ — imports a whole vCard (.vcf) file at once.
- **Birthday reminders** ✅ — surfaces upcoming birthdays in the morning brief.
- **Recipient resolution (no guessing)** ✅ — when a name is ambiguous while sending a message, it
  shows candidates and asks back. It never picks an address arbitrarily.

### Notes
- **Store, view, search, append, delete notes** ✅ — file-based personal notes. Supports semantic
  search (find by similar meaning).
- **File and web-page ingest** ✅ — brings local text/markdown files or **public web pages**
  (`--url`) in as searchable notes (`muse notes ingest <file>` / `muse notes ingest --url <url>`).
  Web ingest passes an SSRF guard (blocks private/local addresses and redirects) and readability
  extraction. You can fold documents and articles into the knowledge base without pasting their
  contents.
- **Multiple store integrations** ⚙️ — beyond the local folder, extensible to Apple Notes and Notion.

### Long-term memory
- **Automatic fact learning** ✅ — **automatically extracts and stores** the user's facts,
  preferences, don't-dos, and goals revealed in conversation, and reflects them in later answers.
  (On by default.)
- **Manual remember/forget** ✅ — add directly with "remember this," and delete what's wrong.
- **Past-session recall** ✅ — summarizes and stores past conversations, and when a similar topic
  comes up it retrieves related memories **even when phrased differently**.
- **Structured model of me (User model)** ✅ — separate from scattered simple facts, it builds
  **preferences, schedule, constraints, goals** as typed slots with confidence and update time
  (`muse user model`). Same items overwrite rather than pile up as duplicates, and the stored
  model rides into the **persona** from the next session on, informing answers as "this is who
  Jinan is." Beyond direct entry, it **infers stable preferences on its own from mid-conversation
  corrections** (e.g. a "give it to me as bullets" correction → "prefers concise bullets"). Simple
  fact corrections (time, names) are not fabricated into preferences. Automatic inference at
  session end can also be enabled in settings (off by default, no fabrication). **Confidence decay
  & reconfirmation**: inferred preferences **fade with a half-life (default 30 days)** and
  gradually drop out of the persona (things the user directly asserted, and constraints, don't
  fade — safety). Faded preferences are collected and shown so you can re-assert or discard them
  (`muse user model review`) — instead of insisting on an old guess forever, it asks once.
- **Recurring-theme reflection** ✅ — aggregates **topics that keep recurring** across sessions and
  shows "what keeps coming up lately" (`muse episode themes`). Not single-session recall but a
  deterministic consolidation across all memory.
- **Grounded cross-session insights (`muse reflections`)** ✅ — synthesizes insights that span
  multiple sessions while **citing the past sessions they're based on**; when the evidence is weak
  it steps down to "I'm not sure" instead of asserting (if it invents a nonexistent source, code
  discards that insight). View directly with `muse reflections`; the daemon also runs this
  retrospection on its own when idle (automatic dreaming). Each insight shows **followable
  sources** (note paths, past sessions) underneath, so it's verifiable on the spot. Accumulated
  insights then ride into `muse ask` answers as context, so reflection comes back as "answers that
  know me better" (dreaming closes the loop). After recall and proactivity, reflection passes the
  same grounding + citation gate — one more surface of the "shows its work" differentiator
  ([differentiation](../strategy/positioning/differentiation.md)).
- **Duplicate-memory consolidation** ✅ — finds nearly identical past-session summaries and tidies
  them (`muse episode consolidate`). Default is a preview (read-only); on apply it keeps only the
  richer one and cleans up duplicates (taking a backup first). Prevents the memory store from
  crowding with similar summaries and blurring recall and the persona.
- **Promoting often-recalled memories (Dreaming)** ✅ — records a **recall count** every time a
  past session surfaces in recall, then picks the **most useful (frequently + recently recalled)**
  memories and lifts them into the always-on persona (`muse memory promote`) — keeping them at
  hand even when a query doesn't match. The score weights recall count by recency (21-day
  half-life), so long-unrecalled memories naturally fall away, and each run **swaps in** the
  current top set (running it repeatedly doesn't bloat). Unlike content(theme)-based
  consolidation, this is promotion based on **proven usefulness**.

---

## 3. Perception — the ability to "see" the world

Features that let Muse sense surrounding state without asking the user.

- **Screen perception (glance)** ⚙️ (macOS) — reads the current app, window title, and selected
  text and uses them as context.
- **Ambient context** ⚙️ — the daemon can use a snapshot of the current app/window in rule triggers
  (off by default; clipboard is a separate opt-in). It currently does not store persistent work
  rhythms and is not the Observe wired through the whole agent request path.
- **Image understanding (vision)** ⚙️ — describes local/remote images with a vision model.
- **Document reading** ✅ — reads PDF, text, markdown, logs, CSV, and answers questions grounded in
  the content or stores it as notes.
- **Web-change watching (web-watch)** ⚙️ — periodically checks a given web page and notifies only
  when a condition holds, like "when text ○○ appears/disappears / a number drops below a threshold."
- **Home-state watching (home-watch)** ⚙️ — watches and notifies on smart-home device state changes
  the same way.
- **Local file/log watching (file-watch)** ⚙️ — watches files/logs on disk with the same rules
  (appear/disappear/change/numeric threshold) and notifies only when the condition holds. Register
  a file path as a watch target and the daemon checks it periodically (e.g. "tell me if ERROR
  shows up in app.log").
- **Weather** ✅ — current weather plus rain forecast within the next 12 hours (no separate key
  needed).
- **Real browser viewing** ⚙️ — can look directly at the real Chrome the user is logged into and
  answer grounded in its content (read by default; state-changing acts like click/type require
  approval).

---

## 4. Knowledge & search

The area that gathers scattered personal data and external information as grounds for answers.

- **Unified knowledge search (knowledge_search)** ⚙️ — **bundles notes, tasks, calendar, contacts,
  email, reminders, follow-ups, news feeds, and objectives into one knowledge base** searched
  semantically. Opt-in (when on, every question re-embeds the knowledge base, so it defaults to
  off). For questions like "what do I have stored about ○○?" the local model reliably selects this
  tool (verified).
- **Semantic note search** ✅ — finds notes with similar meaning even when the exact words differ.
- **News feeds (RSS/Atom)** ✅ — register feeds of interest and it fetches the latest posts,
  including them in the morning brief, search, and the knowledge base.
- **Unified quick find (find)** ✅ — "where did I mention that?" in one shot. Searches by substring
  across tasks, reminders, contacts, and **calendar events**, grouped by domain
  (`muse find dentist`). Unlike semantic `recall` (notes/memory) or web `search`, this is an
  instant, deterministic local lookup.
- **Bulk ingest (ingest)** ✅ — brings large piles from elsewhere in wholesale as searchable,
  citable knowledge (`muse ingest`). Supports exported ChatGPT/Claude conversation logs and
  mailboxes (.mbox) — a beachhead for the personal corpus that makes "things I discussed with
  another AI before" and old mail retrievable from my knowledge base with sources.

### Deterministic data-analysis tools (no model, cannot fabricate)

Analyzes documents and tables (CSV) **deterministically, without a model**, giving exact answers
where hallucination is impossible by construction. Several tools transplant verified mechanisms
from biology, ecology, and statistics — the embodiment of the research-distillation discipline the
README describes. (All confirmed working by live execution.)

- **Precise CSV aggregation (`muse csv`)** ✅ — computes column sum/mean/min/max/row-count exactly,
  with row filters. Free-form questions go to `muse ask --file`; exact totals go here.
- **Extractive summary (`muse summarize`)** ✅ — extractive summarization that picks the document's
  own key sentences by significance density (Luhn 1958). Deterministic and model-free, so it cannot
  fabricate.
- **On this day (`muse on-this-day`)** ✅ — resurfaces notes written on today's date in past years,
  a date-cue recall (uses YYYY-MM-DD in note paths, model-free).

---

## 5. Proactivity & autonomous action — the Jarvis that speaks first

The most Jarvis-like area, where Muse moves on its own without instructions.

- **Proactive notifications** ⚙️ — **sends imminent tasks, events, and reminders first to a
  designated messenger**. Never sends the same content twice.
- **Earned proactivity** ✅ — unprompted suggestions and recalls surface only when they pass a
  **trust score** and a **confidence bar**. It doesn't butt in on shaky guesses; it speaks first
  only when confident, so proactivity is allowed only as far as trust has been earned. Even as
  Attunement learns the timing and shape of interventions, this floor does not weaken.
- **Quiet hours / DND** ✅ — during a configured window (e.g. 10pm–7am) the daemon **holds back**
  ambient/web/home watch notifications (no waking you at night). Reminders and follow-ups you set
  yourself are a separate path and still fire.
- **In-chat proactive prompts** ✅ — when the `muse` chat is idle, Muse surfaces **imminent
  reminders, follow-ups, due-soon tasks** and **finished background jobs** first. Scoped by a time
  window and once per session (dedup).
- **Preemptive research** ⚙️ — for imminent items, finds related notes **without being asked** and
  attaches them to the notification. ("📎 related note: …")
- **Situation briefing** ⚙️ — bundles imminent items + in-progress objectives into one coherent
  briefing sent to a channel.
- **Standing objectives** ✅ — register persistent goals like "when ○○ happens, do △△" via
  `muse objectives` (add/list/cancel/done); the daemon's objectives tick (`runDueObjectives`)
  re-evaluates the condition with a model evaluator and acts when satisfied (`daemon --status`
  shows `enabled`). Two default actuators — **notify on your own channel**
  (`createMessagingObjectiveActuator`) or a **draft-first proposal**
  (`createProposingObjectiveActuator` → confirm via `muse propose approve`). Neither is an
  automatic send. **Action toward a third party runs only with pre-recorded scoped consent**
  (`performConsentedAction`); absent that, fail-close. The objective evaluator, both actuators,
  the objectives tick, and the CLI are all implemented and tested.
- **Pattern detection → preemptive suggestions** ✅ — finds recurring usage patterns (weekday,
  time-of-day, weekly work) and the daemon **offers a suggestion first** ("you usually write the
  report on Mondays — want me to draft it now?"). The suggestion text is synthesized naturally by
  the local model **grounded only in actually observed facts** (with thin evidence it abandons
  synthesis and falls back to a stock phrase — it doesn't invent nonexistent patterns); cooldown
  and quiet hours apply, and it is a **suggestion**, not an action. If enabled in settings,
  fireable pattern suggestions also surface when the chat is idle (read-only — already-sent ones
  are deduplicated by cooldown).
- **Dismissed suggestion = learned avoidance** ✅ — turn off a bad suggestion with
  `muse pattern dismiss <id>` and it **never makes that suggestion again** (survives a cooldown
  `reset`). Check the list with `muse pattern dismissed`. If it annoys you, one dismissal ends it.
- **One-touch mute by channel reply** ✅ — reply "그만" ("stop") or "stop" to a notification Muse
  sent first, and it learns that notification's source and goes quiet (it reacts only when there's
  a recent delivery record and doesn't touch other conversation — an honest scope). The
  confirmation message states exactly what was muted and how to undo it
  (`muse proactive keep <source>`).
- **Interruption budget & evening digest** ⚙️ — notifications Muse initiates **unasked** have
  hourly and daily caps (`MUSE_INTERRUPTION_HOURLY_CAP`/`MUSE_INTERRUPTION_DAILY_CAP`, default 2/h
  and 6/day; 0 or below = unlimited). Notifications over the cap are quietly queued on the spot,
  and at a set evening hour (`MUSE_DIGEST_HOUR`, default 18:00) the daemon sends **the day's worth
  compressed into one message** (disable via `MUSE_DIGEST_ENABLED`, on by default; preview pending
  items with `muse digest`). If that hour falls inside quiet hours and can't go out, it does not
  retry that day and sends **at the same hour the next day** (queued content stays and is not
  lost). The interruption budget applies only to utterances Muse **initiates by its own judgment**
  (pattern suggestions, ambient detection, follow-ups, background-completion notices, check-ins);
  **reminders you scheduled yourself and imminent event/task alerts are outside this budget** —
  if the budget blocked a notification you asked for, that would be obstruction, not help.
- **Two-way channel conversation** ⚙️ — for messages arriving via Telegram etc., it **runs the full
  agent and replies** (keeping prior conversation context per channel). Not mere receipt logging —
  a real back-and-forth.
- **Conversation rhythm (ack → quiet work → cited completion)** ⚙️ — small talk (greetings, thanks)
  is answered immediately without running tools. General conversational messages like moods and
  chit-chat also get a reply within seconds (without running the full agent — the classifier is
  conservative: when it's ambiguous whether something is a real request, it always falls through
  to the existing delegation path). Delegation requests ("do X for me") first get **a one-sentence
  read-back confirmation of what will be done**, then Muse works **quietly** without spamming
  progress, and finishes with a final answer citing its grounds (two sends per channel: read-back
  + final). The read-back is in the user's language and only restates the request — it invents no
  new facts or numbers. `MUSE_CHANNEL_ACK=false` disables just the read-back (the final answer
  stays). Tuning note: if the final send fails and is retried, the read-back may appear once more.
  These small-talk replies — only in the user's own 1:1 chat scope (shared/group chats excluded) —
  also consult a short snapshot of stored facts/preferences (max 10 lines, each line with its
  source) so Muse answers like someone who knows you, not a stranger. To be honest: this snapshot
  is grounds only for cross-checking sentences that carry a citation marker; it is not a complete
  defense against uncited fabricated facts (that is still carried by the "don't fabricate" system
  prompt instruction + the conservative classifier).
- **Action log & undo (Accountability)** ✅ — every autonomous action Muse takes (or refuses) is
  recorded with its rationale, can be undone in one step, and an undo teaches it "don't do this
  next time."
- **Self-authored skills** ✅ — from procedural corrections received in conversation, it **writes
  skills on its own at session end** and automatically applies them to similar requests in later
  sessions (`muse skills author`). Auto-authored skills have **no execution permission** (only a
  human promotion makes them executable), and their body passes a **dangerous-pattern check**
  (prompt injection, dangerous shell, secrets); if flagged, they are quarantined instead of
  activated — a second line of defense against a poisoned correction hardening into persistent
  injection. Long-unused skills are moved to an archive rather than deleted (`muse skills curate`),
  and when similar skills accumulate, overlapping ones are **merged into one umbrella skill**
  (`muse skills consolidate`; ones that don't group stay as they are). Consolidation and archiving
  are reversible (`muse skills archived` / `restore`). Automatic consolidation at session end, or
  background consolidation only while the user is idle, can be enabled in settings (off by
  default) — so even an always-on companion session tidies itself without blocking exit.
- **Learned-strategy tidying (Playbook consolidate)** ✅ — when similar work strategies learned
  from corrections pile up, `muse playbook consolidate` **merges duplicates into one general
  strategy** (preview by default; on apply, originals are removed and the merged one recorded).
  Distinct strategies are not merged.
- **Strategy & skill reinforcement — reward/decay (RL-flavored)** ✅ — strategies that actually
  worked (were approved) get rewarded and corrected ones get their score lowered, so when helping
  with answers it pulls **highest-scored first** (rewards accumulate within a cap). It works both
  ways (reinforce on approval, decay on correction), and this reward-weighted ordering applies
  **identically to learned strategies (playbook) and self-authored skills** — over time, only what
  works for you survives.

---

## 6. Acting outward (Reach / Actuator) + safeguards

Features that send something to another (third) party or change external system state. **All follow
"draft first → human confirmation → execute,"** and if confirmation fails, is denied, or times out,
**nothing executes.**

- **Send email** ⚙️ — drafts recipient/subject/body, gets approval, sends via Gmail.
- **Send messages** ⚙️ — sends to connected channels like Telegram, Slack, Discord, LINE (approval
  gate).
- **Web actions (web_action)** ⚙️ — state-changing web requests like form submission, booking,
  applications run only after approval. **Payments and purchases are deliberately out of scope**
  (a design principle — stated in `web-action.ts`; treated as a product boundary rather than a
  separate keyword blocklist, and every state change passes the approval gate).
- **Smart-home control (home_action)** ⚙️⚠️ — controls devices through Home Assistant. *Live
  verification requires a real home integration environment.*
- **External tool connections (MCP)** ⚙️ — register external tool servers to extend capabilities.
  A security allowlist controls which servers may be used.

**Safety rules in short:**
1. No automatic sending, ever — a human must confirm the exact content before it leaves.
2. The approval gate fails closed — no confirmation, no action.
3. Recipients are resolved, never guessed — if ambiguous, ask back.
4. Every send (sent AND refused) is recorded and subject to undo.
5. Banking, payments, and money transfer are permanently out of scope.

---

## 7. Voice

- **Ask by voice, hear the answer (listen)** ⚙️ — push-to-talk turns speech into text for the
  agent and reads the answer back as speech.
- **Speech-to-text (STT)** ⚙️ — OpenAI Whisper (cloud) or local whisper.cpp.
- **Text-to-speech (TTS)** ⚙️ — OpenAI TTS (cloud) or local Piper.
- **Wake-word detection** ⚙️ — a mode that wakes when a specific word is heard.

---

## 8. Multi-agent collaboration

- **Orchestrating multiple agents** ✅ — runs several specialist agents **sequentially or in
  parallel**. (The `race` mode was **intentionally parked** in the 2026-06 maturity review and
  currently falls back to sequential — passing `mode: "race"` returns every worker's result and
  does not "adopt only the first to finish.")
- **Model tiering** ✅ — within one job, simple lookups are routed to a fast model and deep
  reasoning to a stronger one, automatically.
- **Agent Specs** ✅ — register agents with a role, tools, and system prompt, and pick the matching
  agent for a request by keyword.
- **Muse swarm federation (`muse swarm`)** ⚙️ — multiple Muse instances exchange **only learned
  know-how (e.g. skills)** as peers (P2P): an allowed-peer registry + signed transport + secret
  masking. **Received know-how is quarantined inactive until a human promotes it** (never executed
  on receipt — defense against poisoned know-how); review pending incoming know-how with
  `muse swarm pending`, and see the current swarm state (peers, pending items, etc.) at a glance
  with `muse swarm status`. **Sending know-how also goes out only after you confirm a draft first**
  (`muse swarm share`, same draft-first as outbound safety), and the receiving endpoint for peers'
  know-how runs via `muse swarm serve`. Personal data — notes, memory, contacts — never crosses.
  Off by default (`MUSE_A2A_ENABLED` opt-in); in a single-user posture this is an exceptional
  feature.
- **Multi-Muse council reasoning (`muse swarm council`)** ⚙️ — fans one question out to peer Muses,
  has each **reason with cited grounds**, and synthesizes the received answers into one locally
  (multi-round **debate where each refines its view after seeing the others' reasoning** is also
  possible — multi-agent debate) — the synthesis **cites only what peers actually answered** and
  nothing ungrounded survives (the same grounding gate as recall and reflection). It travels
  request→reasoning→response over A2A transport; what is shared is reasoning utterances, not
  personal data (same safety rules as swarm, `MUSE_A2A_ENABLED` opt-in).

---

## 9. Trust, safety, accountability (the cross-cutting foundation)

- **Input defense** ✅ — blocks prompt injection (hidden command insertion) and PII patterns
  (Korean + international) before they reach the model.
- **Output defense** ✅ — filters system-prompt leakage, personal-data exposure, and fabricated
  ungrounded citations.
- **Deterministic safety** ✅ — permissions, budgets, and stop conditions run as **fixed rule
  code**, not "model judgment."
- **Trust calibration** ✅ — per-user trust lists that allow/block specific tools.
- **Local-only mode (no cloud egress)** ✅ — in the local-only posture, nothing can leave for a
  cloud LLM/voice API. If a cloud model is selected, the runtime **refuses loudly** rather than
  silently disabling; voice likewise ignores cloud keys, so only local voice engines register
  (blocking silent egress of mic audio). Even a remote host counts as egress. The health check
  (`muse doctor`) reports this posture, and the decision is made by fixed rules, not a model.
- **Zero-config local path** ✅ — with no model specified, Muse can start on an available local
  model. A cloud key floating around the machine does not substitute for the strong on-device
  guarantee for personal data. If you need that guarantee, set `MUSE_LOCAL_ONLY=true` explicitly.

---

## 10. Observability & operations

Mostly operator-facing screens, but used directly for cost and quality decisions.

- **Cost tracking** ✅ — token cost per model/session/day, top most-expensive runs, monthly budget
  overrun warnings.
- **Latency/quality (SLO)** ✅ — response latency distribution, SLO violation detection, prompt
  drift detection.
- **Traces** ✅ — per-run step records and tool-call history.
- **Tool accuracy** ✅ — which tools succeed/fail and how often.
- **Failure replay (Debug Replay)** ✅ — saves failed runs' context for post-hoc analysis.
- **Health check (doctor)** ✅ — checks model, integrations, scheduler, and other configuration in
  one pass.
- **Status dashboard (status/today)** ✅ — persona, imminent tasks, last notification at a glance /
  morning brief.
- **Operational utilities** ✅ — backup/restore (`export`/`import`), log cleanup (`maintenance`),
  activity-routine analysis (`routine`), focus/DND mode (`session`), raw telemetry (`telemetry`),
  arbitrary activity-record lookup (`open`), inline terminal images (`show`).

---

## 11. Usage surfaces (where you use it)

- **CLI** ✅ — nearly every feature from the terminal via 100+ commands. (Conversation, personal
  domain, perception, autonomy, reach, operations.)
- **Guided first run (onboard)** ✅ — walks a first-time user step by step (point at a notes folder
  → bulk ingest → first question), taking them from install to a **private, source-citing first
  answer** (`muse onboard`). Each step shows "done/to-do" and tells you the next command to type.
- **Web app** ✅ — Chat, home, continuity, work, tasks, reminders, notes, calendar, scheduler,
  agents, board, flows, skills, tools, MCP, messaging, activity, journey, autonomy,
  self-improvement, prompt-lab, integrations and settings views. Voice is CLI-only.
- **API server** ✅ — most of the above over HTTP (proactive notifications as a real-time stream).
  Publishes a standard Agent Card for interop with other agents.
- **Local execution sandbox** ✅ — potentially risky local command execution happens only in an
  isolated environment (time limit, output limit, env-var whitelist).

---

## Maturity at a glance

| Grade | Areas |
|---|---|
| **Verified with a real LLM** | General conversation, streaming, tool loop, plan-execute, multi-agent tiering, input guard. Plus, always-running local eval gates confirm that the local model **picks the right tool in one shot and fills its arguments** (including confusable tools and no-request cases) and **refuses dangerous requests without over-refusing normal ones** |
| **Solid via unit/integration tests** | Most personal-domain, perception, knowledge, autonomy, and observability features |
| **Known gaps** | ⚙️ Live verification with real integrations for features needing external credentials (email/inbox/smart home/web actions) |

## Known gaps

- **Attunement: collection is implemented; interpretation and timing are not** — Personal
  Continuity Slice A connects exact local tasks/notes to a user-created life/work thread and
  provides `muse continue` → explicit outcome → a limited change to the next pack's display.
  Observe O1 collects app category, time, and duration for the exact thread, opt-in and locally,
  with inspect/pause/resume/forget. But rhythm/friction hypotheses, automatic linking, more data
  sources, usefulness/rhythm/timing improvement, and proactive delivery are still roadmap in the
  [implementation plan](../../internal/goals/attunement-implementation-plan.md).
- **Generic desktop computer use is not implemented** — the real Chrome is operated via semantic
  snapshots and fail-close target matching, but action trees for arbitrary apps outside the
  browser, state restoration, and cross-app workflow compilation are not provided.
- **Live verification of external integrations** — for features needing external accounts/devices
  (smart home, email, inbox, web actions), the logic and safeguards themselves were verified
  against contract-faithful fakes, but live verification in a real-credential environment still
  remains.
- **Single-path exception for image (vision) input** — image attachments are sent on local Ollama
  (gemma4, `muse ask --image`), Anthropic, OpenAI Chat-Completions, OpenAI-compatible/OpenRouter,
  and Gemini. The one exception is the OpenAI **Responses** API path, which sends text only
  (`input_text`). In the explicit local-only posture, images cannot leave the machine.
- **Multi-agent default worker presets** — orchestration itself is wired via the CLI
  (`muse orchestrate run`) and API (`/api/multi-agent/orchestrate`), and the voice wake word works
  via `muse listen --wake`. What's still thin on the surface is a bundled **default worker set**
  (presets usable without registering your own).
- **Test gaps in some operational commands** — some dashboard-style CLI commands and the skill
  execution path still have thin automated test coverage.

> Note: unified knowledge search was once suspected as a "tool-selection gap," but that was an
> environment where the feature was disabled; with it enabled, the local model selects it reliably
> (not a gap).

---

## Attunement — aspirational roadmap (north star)

**Why use this.** Muse does not claim to be smarter than the best models. Its goal instead is to
learn the timing and size of help that fits one person. The first user experience is **Personal
Continuity** — carrying forward the life threads that remain: a project, a doctor's appointment,
trip prep, someone you meant to contact, an article you were reading.

### The flagship "wow" experience (roadmap)

When you resume trip prep, Muse aims to show — instead of a mere reminder — one Capsule of "where
you stopped, what changed since, why now, which materials it connected, and how far a click will
execute." A reaction like "not now, this evening" becomes a Policy Card proposal scoped to that
thread, not a hidden global preference.

- **Shadow Muse** — does not intervene first; compares suggestion/silence candidates against actual
  returns.
- **Continuity Capsule** — restores the stopping point, changes, grounds, next steps, prepared
  work, and estimated time.
- **Policy Card** — shows the grounds and scope of a learned collaboration rule, with
  try/edit/reject/undo.
- **AttuneGraph** — a proposed agent-only module that links time, relations,
  provenance, and policy on top of existing stores, building only the small Working Graph a turn
  needs. The current private library substrate is partial; the SQLite AttuneGraph Store and a standalone
  release are roadmap.

The key sentence: **Muse doesn't remember apps; it remembers the state I meant to continue.**
The detailed product contract and module design follow [Attunement](../strategy/attunement.md),
[AttuneGraph](../design/attunement/attunegraph.md), and the
[separate execution roadmap](../../internal/goals/attunegraph-roadmap.md). These items are not shipped
features yet.

The first flow: **user picks a life thread → context pack prepared → usage recorded → next pack
improved.** Observation, rhythm analysis, and recurring-friction discovery are follow-on slices
that improve timing after this flow's value is confirmed.

Today's memory, pattern, proactivity, browser, and trace are the substrate of this loop, not the
whole loop. The concrete privacy contract and per-stage gates/kill criteria follow the
[Attunement design](../design/attunement/README.md) and the
[implementation plan](../../internal/goals/attunement-implementation-plan.md).

### The foundation already in place

Attunement is not a plan to build everything anew. It is a plan to connect the personal memory,
source-visible recall, notifications, approval-gated action, and execution records that already
exist into one user experience.

The existing foundation loop: **remembers me → notices before I ask → gets it done (with
approval) → records it.**

These three goals are built **one at a time, properly** (brainstorm→TDD→dogfood→merge). Not all at
once (no half-builds).

| ID | Goal | One line | Status | Current parts / gaps |
|---|---|---|---|---|
| **SB-1** | **Unified recall (knowledge encyclopedia)** | Ask anything about "everything I ever dropped into Muse" and get an answer *with sources* | ✅ delivered | Unified knowledge search bundles notes, documents, tasks, calendar, contacts, email, reminders, follow-ups, objectives, and feeds plus **past sessions + remembered facts** into one corpus, answering with source citations. Plain questions also ground automatically on notes, past sessions, feeds, and memory (notes and sessions auto-reindex) → "what did I say about X before?" recalls past conversations |
| **SB-2** | **Frictionless capture** | Throw anything — conversation, voice, clipboard, screen, file — at the brain in one action and it auto-indexes | 🚧 partially delivered | One-action capture via `muse note "<thought>"` · **stdin pipe** (`pbpaste \| muse note` = clipboard, `echo … \| muse note`) · **`muse note --voice`** (mic clip → STT → capture, reusing `muse listen` STT) → daily inbox note → auto-index → instant recall (SB-1) + related past knowledge shown (SB-3). Remaining gaps: global hotkey, direct screen capture (OS integration) |
| **SB-3** | **Proactive connection** | Connect what I'm looking at / doing right now to past knowledge and suggest *first* | 🚧 partially delivered | At capture time: `muse note` searches the unified corpus for the new thought and immediately shows "💡 related past knowledge." At proactive (daemon) time: unified knowledge attaches to both the situation briefing's related knowledge and real-time ambient notifications (enabled via settings). Remaining gap: triggers from *arbitrary* current context like the screen or active app (currently driven by imminent items, capture, and ambient signals) |

> Where we don't compete (honest): we don't try to beat frontier models on pure reasoning/coding
> answer quality — a small local model loses there. Muse wins as *my* layer.

---

*This document is the feature-definition baseline; details are updated as the product evolves.*
