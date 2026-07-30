---
title: Muse system map
audience: [product, developers, AI agents]
purpose: One page that gives the whole shape of what Muse can do
status_legend:
  "✅": verified against the codebase
  "⬜": outline only, code verification pending
  "⚙️": needs external integration or configuration
  "⚠️": known gap (not yet trustworthy)
updated: 2026-07-30
related: [strategy/attunement.md, design/attunement.md, FEATURES.md, README.md, feature-catalog/INDEX.md, strategy/differentiation.md]
---

# Muse at a glance (system map)

> **What is this?** A structural map for taking in **everything Muse can do**, quickly.
> It does not talk about code or files — it describes **what the capabilities are and how they
> behave**, in words. Product people, developers and AI agents should all be able to get the whole
> outline of "what Muse can do" from this one page.
>
> - Deeper per-feature descriptions: [`FEATURES.md`](FEATURES.md) · **the verified full inventory
>   with evidence (audited 2026-06-14): [`feature-catalog/INDEX.md`](feature-catalog/INDEX.md)** ·
>   product identity and strategy: [`strategy/differentiation.md`](strategy/differentiation.md) ·
>   documentation index: [`README.md`](README.md)
>
> **Reading convention (for humans and agents alike):** each area starts with a `## number. name`
> heading, and every capability inside it is one line of the form
> `- **capability** — what it does (how/when)`. The coverage table below is both the index of areas
> and the progress indicator. This map is written against the actual codebase and updated when
> behaviour changes.

## The one-line identity

**Muse is a personal AI agent that keeps understanding, and helping with, one person's life and
work.** The goal is a continuing companion that carries schedule, notes, relationships, environment
and work context forward and helps when help fits. Technically it is a conductor that handles many
models, personal data and tools in one execution flow, without being tied to a single model vendor.

The first development flow is **the user picks a life thread to continue → the needed context is
prepared → whether it was used is recorded → the next help improves**. A thread can be work, but
equally a schedule, a relationship, health, travel or a hobby. Later, with the user's permission,
Muse observes activity transitions and learns the timing of help and the friction that keeps
recurring. Memory, pattern, proactivity, browser and trace are the substrate today. Observe O1
collects only app-category transitions, locally, for one exact thread the user picked, and can be
paused, inspected and forgotten. Personal Continuity Slice A hands back the life/work thread the
user picked together with the exact local task/note through `muse continue`, and an explicit outcome
changes only what the next pack shows. Interpreting Observe O1 collection as rhythm or friction,
using it for pack delivery, automatic linking, and timing improvements are all still **roadmap**
([product direction](strategy/attunement.md) · [technical design](design/attunement.md)).

The signature roadmap experience is **Shadow Muse → Continuity Capsule → Policy Card**: Muse first
learns in silence, then restores the state the user meant to continue along with what changed since,
then shows the next collaboration rule with its evidence, scope and rollback. The proposed **Muse
Attunement Graph (MAG)** behind it is not a heavy server duplicating existing stores; it is an
agent-native personal context compiler that links time, relationships and provenance as a
regenerable projection and builds only the small Working Graph each turn needs
([graph design](design/attunement-graph.md) ·
[separate execution roadmap](../internal/goals/attunement-wow-graph-roadmap.md)).

## The big picture — what layers Muse is made of

The twelve areas below are Muse's whole capability structure. The top is "how it thinks and speaks"
(the engine), the middle is "what it knows and remembers" (your data and knowledge), the bottom is
"how it touches the world" (action and surfaces), and cutting across all of them is safety and
trust.

| # | Area | One line | Verified |
|---|---|---|---|
| 1 | **Conversation & agent execution** | The central engine that takes a request through to the end | ✅ |
| 2 | **Model & deployment choice** | Pick local or cloud models, and force on-device when needed | ✅ |
| 3 | **Tool system** | The ability to choose and use the right tool itself | ✅ |
| 4 | **Personal assistant data** | Calendar, tasks, reminders, contacts, notes | ✅ |
| 5 | **Memory (long and short term)** | Remembers you, recalls past conversations | ✅ |
| 6 | **Knowledge & retrieval (RAG)** | Gathers everything of yours and answers with sources | ✅ |
| 7 | **Perception** | Sees your screen, documents, the web, your home state | ✅ |
| 8 | **Proactivity** | Speaking first, before you ask | ✅ |
| 9 | **Self-improvement** | Learns from corrections and gets better on its own | ✅ |
| 10 | **Outbound action + safety** | Anything sent to another person waits for your confirmation | ✅ |
| 11 | **Voice & multi-agent** | Talking out loud, several agents collaborating | ✅ |
| 12 | **Trust, observability, surfaces** | Guards, operational observability, where you use it | ✅ |

> ✅ = written up after checking the code · ⬜ = outlined below, to be sharpened by code
> verification. This table is the coverage indicator for "all capabilities".

---

## 1. Conversation & agent execution — the central engine

The channel every capability flows into. Whether you call it from the server, the CLI or the web
app, **the same engine** does the work.

- **Natural-language conversation** — answers questions and, when needed, chooses tools itself
  (checking the time, searching notes, adding a calendar entry) and synthesises the result.
- **Live streaming** — the answer arrives character by character, and the moment a tool runs you see
  "now using X".
- **Tool-use loop** — tools can run one after another within a single turn, but under **a call
  ceiling and a time limit**, so it cannot loop forever.
- **Plan-and-execute mode** — a complex request gets a step-by-step plan → execution → a combined
  answer. If that goes badly it falls back safely to answering directly.
- **Continuous conversation and context** — carries the previous context forward and automatically
  pulls in past-session summaries and what it knows about you.
- **Clarify** — when the target is ambiguous ("do that thing"), it does **not** guess and execute;
  it asks what you mean.

## 2. Model & deployment choice — a swappable brain, with an explicit opt-in local boundary

- **Vendor-neutral** — a conductor structure with adapters for OpenAI, Anthropic, Gemini,
  OpenRouter, Ollama, and supported OpenAI-compatible endpoints. LM Studio uses the compatible
  adapter with a local `baseUrl`; it is not a dedicated adapter. You are not tied to one company's
  AI.
- **Capability-based routing** — each model declares "can it stream, can it call tools, can it see
  images, how large is its context", and work is distributed safely to match.
- **Fallback policy** — a model without tool calling gets the text protocol instead; a small context
  gets stronger trimming. **Fixed rules, no hidden retry magic.**
- **Local-only mode (explicit opt-in)** — under `MUSE_LOCAL_ONLY=true`, **nothing can reach a cloud
  AI or voice service.** Selecting a cloud model is **refused loudly** rather than silently
  disabled, and only local voice engines are registered. A remote host counts as external.
- **Flexible deployment paths** — local, self-hosted, and cloud models are first-class choices
  behind the provider-neutral adapter. You can start with Ollama and no API key, or select a
  supported cloud provider. Personal file-backed stores remain local by default today.

## 3. Tool system — choosing its own tools

Muse does not just produce answers; when needed it **picks a tool itself** and finishes the job.
Tools come in two kinds — Muse's built-ins, and tools connected from outside (MCP).

- **Built-in computation tools** — pure tools that run instantly with no external connection: time
  arithmetic (now, difference, addition, next weekday), text statistics, expression evaluation, JSON
  value extraction, URL analysis, regex extraction, CSV/table conversion, hashing and base64, unit,
  radix and epoch conversion, lunar-calendar and Korean age/number conversion, and more. The small
  adjustments an answer needs get handled without external dependencies.
- **Built-in integration tools** — the ones that touch your data and the world: weather, finding
  free time, task management, note and knowledge search, contacts, home state, web actions.
- **A specification per tool** — every tool carries a name, a description of what it does, an input
  schema, a risk class (read/write/execute), related keywords and a domain (messaging, calendar,
  tasks, notes, system …), so the model is not confused about what to use when.
- **Only the tools that fit the question** — each question exposes only the tools whose keywords and
  domain match, with a ceiling on how many are shown at once (so a small local model does not get
  lost). Low-risk read tools come first, ordered by relevance, and core tools needed everywhere are
  always exposed. Interdependent tools get their execution order arranged.
- **Getting it right on the first try** — the single goal of the design above is that the local
  model **picks the right tool and fills its arguments in one shot** (rather than adding reasoning
  rounds).
- **Risk class + trust gate** — every tool is classified read/write/execute. Immediately before a
  call the trust gate checks: reads pass, **execute tools must be on the trust list**, and blocked
  tools are always refused. A refusal is recorded in the action log. (State-changing external
  actions additionally pass through the safeguards in section 10.)
- **Tool-use limits** — a single turn has ceilings on tool-call count, total elapsed time and tool
  output length, so it cannot loop forever.
- **External tools (MCP)** — external tool servers extend the capability set, controlled by an
  **allowlist** of which servers may be used. Eligibility is re-checked both at registration and at
  connection time. Example: a tool that drives **the real Chrome you are logged into** (off by
  default — it drives an actual browser, so it must be turned on explicitly).

## 4. Personal assistant data — calendar, tasks, reminders, contacts, notes

Muse manages personal life data through one owner-controlled interface. Muse-owned personal stores
are file-backed **on your machine, under your account** by default; connected providers retain
their data under their configured terms.

- **Calendar** — several calendars at once (Google, CalDAV, macOS, local file), natural-language
  query, add, edit and delete, finding free time, export to the standard `.ics` format.
- **Tasks** — natural-language due dates, open/done state, urgency marks, due-soon queries, tag
  filters, attached notes.
- **Reminders** — reminders at a set time, recurring reminders, snooze. They also appear in the
  morning brief.
- **Contacts** — names, emails, handles, phone numbers (preserved exactly as entered), aliases and
  birthdays. Bulk vCard import and export, upcoming-birthday warnings, and **when the recipient is
  ambiguous it shows the candidates and asks rather than guessing.**
- **Notes** — file-backed personal notes, saved and searched (by meaning, not just exact words), and
  local files or public web pages can be imported into searchable notes (the web goes through a
  safety filter).
- **Follow-ups** — promises made mid-conversation ("I'll do X for you later") are remembered and
  picked up when the time comes, and half-stated intentions ("I should really do this") are
  collected and surfaced.

## 5. Memory (long and short term) — it remembers you

- **Automatic fact learning** — facts, preferences, vetoes and goals that surface in conversation
  are **extracted and stored automatically** and reflected in later answers (on by default). You can
  also add one directly with "remember this", or delete a wrong one.
- **A structured model of you** — separately from scattered facts, preferences, schedules, things
  not to do and goals accumulate as **entries with a confidence and an update time**, so answers
  carry "this is the kind of person Jinan is". It also infers stable preferences from mid-conversation
  corrections.
- **Confidence decay and reconfirmation** — an inferred preference **fades on a half-life** and drops
  out over time (things you asserted yourself, and vetoes, do not fade); faded ones are collected and
  shown so you can reconfirm or discard them — old guesses are never insisted on forever.
- **Past-session recall** — past conversations are summarised, and when a similar topic comes up the
  related memory is found **even when the wording differs**. (If there is nothing to find, or the
  engine is off, it still works on word overlap so the thread does not break.)
- **Recurring-theme review** — topics that recur across sessions are collected to show "what keeps
  coming up lately".
- **Grounded cross-session insight (reflection)** — insights like "this is the pattern lately" are
  synthesised across sessions, **with the past sessions they rest on cited**. Weak evidence degrades
  the claim into "I'm not sure", and if a source is invented the code discards that insight (the
  same "show your work" gate applies to reflection). You can view them on demand, and the daemon
  runs the reflection itself when idle. Each insight comes with **followable sources** (which note,
  which past session) so it can be checked at a glance. The accumulated insights then ride along as
  context in ordinary answers, so reflection comes back as "an answer that knows you better".
- **Duplicate-memory cleanup** — near-identical past summaries are found and only the richer one is
  kept, so the memory store does not crowd with near-copies and blur recall.
- **Promoting often-recalled memory (dreaming)** — memories recalled often and recently score higher,
  and the most useful of them are promoted to **information kept always at hand**. What has not been
  recalled in a long time naturally falls back.

## 6. Knowledge & retrieval (RAG) — everything of yours, in one place, with sources

Muse's decisive area. It answers over **everything you have ever put into Muse**.

- **Unified knowledge search** — notes, tasks, calendar, contacts, email, reminders, follow-ups,
  news feeds, goals, past sessions and remembered facts are **bound into one knowledge store** and
  searched by meaning.
- **Source citation** — answers carry **a source marker** saying where the content came from, so you
  can tell it was grounded in your data rather than invented. At the end of an answer there is **a
  followable, openable source list** — a receipt you can check on the spot.
- **No citation without confidence** — when relevance falls below the bar it does not manufacture a
  source; it degrades to "I'm not sure". This is the hallucination guard.
- **Long documents in full** — long notes and imported documents are split into reasonable chunks so
  later content is searchable and citable too. Identical content is shown once.
- **Exact words as well as similar meaning** — two searches are combined so that names, error codes
  and numbers that require **an exact match** are caught alongside semantic matches. Similar chunks
  are diversified so they do not take every slot.
- **Quick find** — "where did I mention that?" answered instantly, searching across tasks,
  reminders, contacts and calendar by word and grouping the hits (an immediate exact local lookup,
  not semantic search).
- **Web search and news feeds** — searches the web through an external engine, and pulls the latest
  posts from RSS feeds you follow into briefs, search and the knowledge store.
- **Bulk ingest** — large piles accumulated elsewhere (exported ChatGPT or Claude conversations, a
  mailbox) can be imported wholesale into searchable knowledge — so "what I discussed with another
  AI a while back", or an email, can be pulled from your own knowledge store with a source.
- **Deterministic data analysis (no model, cannot be invented)** — CSV aggregation, trend detection
  (rising/falling, Mann-Kendall), diversity indices (Shannon, Simpson), Benford anomaly detection,
  keyword extraction (RAKE), extractive summarisation (Luhn), plus "notes from this day in past
  years" and "unusually distinctive days". None of it passes through a model, so it is exact,
  reproducible, and structurally incapable of hallucination.

## 7. Perception — the ability to "see" the world

Muse senses surrounding state without being asked (most of it must be turned on explicitly, for
privacy).

- **Screen and ambient context** — the app you are in, the window title, selected text and the
  clipboard are used as context.
- **Image understanding** — looks at an image and describes it (local vision).
- **Document reading** — reads PDF, text, Markdown, logs and CSV, and answers from them or saves
  them as notes.
- **Watching (web, home, files)** — watches a web page, a smart-home device or a local file and
  notifies you **only when a condition is met**: "when the text X appears / disappears / changes at
  all / when a number drops below (or rises above) a threshold". Noisy pages can be narrowed **to a
  region of interest** with a regex, and numeric thresholds fire **once on crossing** rather than
  repeatedly.
- **Weather** — current weather and imminent rain (no separate key needed).
- **Looking at the real browser** — looks directly at the real Chrome you are logged into and
  answers from it (read by default; clicks, typing and other changes need approval).

## 8. Proactivity — speaking first

The area that moves without instruction.

- **Proactive notifications** — imminent tasks, calendar entries and reminders are sent to your
  chosen messenger **first** (the same content is never sent twice).
- **Quiet hours** — during the hours you set (at night, say) proactive notifications are held back
  so you are not woken. Reminders you set yourself still fire.
- **Running itself in the background** — a daemon wakes at an interval and checks "is there anything
  to do now", driving the notifications above. There is a ceiling on how much is handled per pass,
  failures retry a fixed number of times, and persistent failures escalate.
- **Pattern detection → proactive suggestion** — recurring usage patterns (weekday, time of day) are
  found and turned into a suggestion: "you build that report every Monday — shall I draft it?" It
  does not invent patterns that are not there, and a suggestion you dismiss once is not repeated
  (learned avoidance).
- **Open-commitment check-ins** — something you said you would do gets a follow-up the next day:
  "you mentioned you'd do X — how did that go?"
- **Standing objectives** — register a persistent objective ("when X happens, do Y") and it acts
  when the condition is met — except that anything going outward requires **recorded, scoped consent
  in advance**, and is blocked without it.
- **Speaking first inside chat** — when the chat window is idle, Muse surfaces imminent items,
  finished background work and speakable suggestions on its own.
- **Action log and undo** — every action Muse took (or refused) is recorded with its reason, can be
  undone, and undoing teaches it "don't do that next time". The log is bound in a **hash chain** so
  silent deletion, reordering or modification is detectable (tamper-evident,
  `muse actions --verify`).
- **Entry points for external signals** — credential-free entry points wake proactive notifications:
  folder watching (notify when a new file appears), webhooks (external HTTP triggers), activity
  routine aggregation.
- **Earned proactivity** — proactive suggestions and recollections surface only when they pass a
  trust score and **a confidence bar**. Muse does not interject on a half-formed guess; it speaks
  first only when it is sure — proactivity is allowed only in proportion to accumulated trust.

## 9. Self-improvement — learning from corrections

- **Skill authoring** — from procedural corrections received mid-conversation, Muse writes a "skill"
  for itself at the end of the session and uses it on similar requests later. Auto-written skills
  have no execution authority (a human must promote them), and their body passes a dangerous-pattern
  check that quarantines anything that trips it — so a poisoned correction cannot harden into
  behaviour.
- **Skill curation and consolidation** — long-unused skills are archived rather than deleted, and
  when similar skills accumulate the similar ones are merged into a single "umbrella skill" (and
  left alone when they do not merge). You can preview before applying, and curation also runs in the
  background when idle. Archived skills can be restored.
- **Learned-strategy curation** — when work strategies (playbooks) learned from corrections
  accumulate similarly, duplicates are merged into one general strategy. Genuinely different
  strategies are not merged.
- **Reinforce what worked, fade what was wrong (RL-flavoured)** — strategies that actually worked
  (were approved) are rewarded so they get used more, while corrected strategies are scored down and
  recede. So when helping with an answer, **the highest-scoring ones are pulled first**, and rewards
  accumulate within a cap — and this reward weighting applies **to authored skills as well** as to
  learned strategies, so over time only what works for you survives.
- **Automatic preference inference** — at the end of a session, stable preferences are inferred from
  that session's corrections and folded into the model of you (without inventing preferences that
  were not there).

## 10. Outbound action (reach) + safety — a wrongly sent message cannot be recalled

Capabilities that send something to a third party or change external system state. **All of them are
"draft first → human confirms → execute"**, and if confirmation fails, is denied or times out,
**nothing runs.**

- **What it can do** — send email, send messages (Telegram, Slack, Discord, LINE …), web actions
  such as form submission, booking and applications, and smart-home device control.
- **Draft first, never an automatic send** — Muse produces the exact content, and it leaves only
  after a human confirms **that exact content**. If a risky action is attempted mid-chat, it sends a
  notice saying "I was about to do this, I did not run it, approval is needed" and stops.
- **The approval gate is fail-closed** — denial, timeout, a failure to deliver the approval request,
  or an error in the gate itself all mean **nothing is sent**. A send never proceeds because the
  confirmation step failed.
- **Recipients are resolved, never guessed** — when the target is ambiguous it shows candidates and
  asks.
- **Every action logged and reversible** — sent or refused, every external action is recorded with
  "what, why, and the outcome", can be undone, and undoing teaches it not to repeat that action.
- **Payment verbs excluded** — buy, order and checkout are deliberately absent from web actions.
- **Banking, payments and transfers are permanently out of scope** — Muse does not connect accounts
  and does not move money (an irreversible risk, so a permanent product boundary).

## 11. Voice & multi-agent

- **Voice conversation** — push to talk, and speech is transcribed and the answer read back.
  Speech-to-text and text-to-speech can be local or cloud, and under local-only **only local engines
  are registered** (so mic audio cannot leak). There is also a wake-word mode.
- **Multi-agent collaboration** — specialist agents run **sequentially or in parallel**, and each
  collaboration's mode, duration and success/failure counts are kept in a history. (Race mode is
  currently parked deliberately and falls back to sequential — details in
  [`feature-catalog/INDEX.md`](feature-catalog/INDEX.md).)
- **Model tiering** — within one task, simple lookups go to a fast model and deep reasoning to a
  strong one, automatically.
- **Agent specs** — agents with a role, tools and instructions can be registered, and the right one
  selected per request.
- **Know-how sharing between Muse instances (swarm)** — several Muse instances peer with each other
  and exchange **only learned know-how such as skills**. Transfers go only to allowed peers, are
  signed, and leave with secrets redacted, and **received know-how is quarantined inactive until a
  human promotes it** (it does not start working on arrival). Personal data such as notes, memory
  and contacts is never exchanged — "share the know-how, not the data". It is off by default (must
  be turned on explicitly), sending know-how also **leaves only after the draft is confirmed**, and
  there are commands to open the intake for peer know-how and to review and promote what arrives.
  This is know-how exchange, not personal-data sync, multi-device continuity, or hosted storage.
- **Multi-Muse consensus reasoning (council)** — one question is put to peer Muse instances, each
  **reasons with evidence**, and the answers are merged on your side. It can run several rounds of
  **debate where each refines its view after seeing the others' reasoning**. When merging, **only
  what peers actually answered is cited** and unsupported material is dropped (the same "show your
  work" gate applies to consensus). What moves between peers is reasoning, not personal data (the
  same safety rules as swarm), and it is available as a user command.

## 12. Trust, observability and surfaces

- **Input/output defence** — hidden instruction injection (prompt injection) and PII patterns are
  blocked before reaching the model, and system-prompt leakage, personal-data exposure and
  unsupported forged sources are filtered out of answers.
- **Deterministic safety** — permissions, budgets and stop conditions run as **fixed rule code**,
  not model judgement (guards fail closed, hooks fail open).
- **Trust calibration** — a per-user trust list allows or blocks specific tools.
- **Observability and operations** — token cost is aggregated by model, provider and session, and
  daily with an estimated USD cost, with budget-overrun warnings. Plus latency and quality (SLO)
  monitoring, per-step execution records (traces), tool success rates, failure reproduction,
  configuration health checks (doctor), backup and restore, a status dashboard and the morning
  brief.
- **Surfaces** — the terminal (CLI, 100+ commands), the web app (25 views registered in `VIEW_IDS`:
  home, chat, chats, tasks, board, agents, calendar, reminders, messaging, integrations, notes,
  continuity, journey, activity, autonomy, flows, work, dashboard, tools, mcp, self-improvement,
  skills, prompt-lab, scheduler, settings — voice is CLI-only), and the API server (HTTP and live
  streams, with the standard cards other agents integrate against). Potentially dangerous local
  commands run only in a separate isolated sandbox (with time and output limits). There is also a
  native macOS desktop companion (floating).
- **Guided first run (onboard)** — walks a first-time user through it step by step (point at a notes
  folder → bulk ingest → first question), getting them from installation to **a private, cited first
  answer**.

---

*This map is the whole outline of what Muse can do, and it keeps being updated as the product
evolves. For deeper per-feature descriptions see [`FEATURES.md`](FEATURES.md).*
