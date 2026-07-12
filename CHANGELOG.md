# Changelog

All notable changes to Muse are recorded here. The format is loosely based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project is in
continuous iteration on `main`; once a tagged release exists, sections will
move from `Unreleased` to dated/versioned headings. Version policy:
[`docs/VERSIONING.md`](docs/VERSIONING.md).

## [Unreleased]

### Added

- **Scroll up to read without getting yanked back down.** The chat view now
  keeps following new messages only while you're already near the bottom. If
  you scroll up to re-read something while Muse is still replying, it leaves
  you there instead of snapping you to the latest line; scroll back down and
  it resumes following.

- **Save a new contact — with your confirmation.** "save Ada's number as a
  contact" now adds the person to your Apple Contacts, but only after you
  confirm the exact name, phone, and email. If you decline (or Muse can't ask
  you), nothing is written.

- **Turn Bluetooth on or off by asking.** "turn on bluetooth" / "블루투스 꺼줘"
  now toggles Bluetooth. Because macOS has no built-in command for it, this runs
  a small Shortcut you set up once (Muse tells you exactly how if it's missing),
  and `muse doctor` flags whether it's ready.

- **Set your Mac's screen brightness by asking.** "set brightness to 40" / "화면
  밝기 60으로 해줘" now dims or brightens the display. Because macOS has no
  built-in command for it, this runs a small Shortcut you set up once (Muse tells
  you exactly how if it's missing), and `muse doctor` flags whether it's ready.

- **`muse setup cloud` now explains privacy routing.** After wiring a cloud
  model, the wizard tells you how to turn on privacy-tiered routing so only
  context-free questions use the cloud while anything personal stays on your
  local model. Colloquial Korean possessives like "내꺼 일정", "제꺼 노트" are
  now correctly treated as personal, so they stay local when routing is on.

- **Background-job "done" notices no longer interrupt mid-answer.** When a
  background job finishes while Muse is generating a reply, its completion notice
  now waits for the reply to finish instead of getting spliced into the middle —
  and it's never dropped; it appears at the next quiet moment.

- **Muse won't silently overwrite a memory file you edited by hand.** If your
  user-memory file is changed outside Muse (a manual edit, another tool) while
  Muse is mid-write, Muse now stops instead of clobbering it, backs up the
  changed file, and tells you to reconcile — your edit is never lost.

- **No more garbled emoji or CJK when Muse shortens text.** Recall snippets,
  tool descriptions, knowledge summaries, and text-to-speech previews now cut on
  safe character boundaries, so an emoji or CJK-extension character sitting right
  at the length limit is dropped cleanly instead of leaving a broken half-character.

- **Encrypt your calendar on disk.** Set `MUSE_CALENDAR_ENCRYPT=true` (with your
  `MUSE_MEMORY_KEY`) and Muse stores your local calendar — event titles,
  locations, notes — as an encrypted file at rest instead of plain text. It
  reads back transparently, and a wrong key fails safely without ever
  destroying the encrypted data.

- **Secrets in command output stay out of the model.** When Muse runs a shell
  command or a skill, any API keys or tokens printed to its output are now
  masked before the result is handed to the model, so a stray `env` dump or
  config print can't leak a credential into the conversation.

- **Harder to disguise a destructive command.** Muse's block on catastrophic
  shell commands (like `rm -rf /`) now sees through look-alike full-width
  characters and embedded ANSI color codes, so a disguised version can't slip
  past the guard.

- **A clear error when a model can't use tools.** If you point Muse at a model
  that doesn't support tool calling and then try to do something that needs a
  tool, you now get an explicit "this model can't call tools" message instead
  of a silent no-op. The default local model is unaffected — it supports tools.

- **Toggle Mac Dark Mode by asking.** "turn on dark mode" / "다크모드 켜줘" now
  switches macOS between dark and light appearance.

- **Ask Muse to quit a Mac app.** "quit Safari", "사파리 종료해줘" now closes the
  named app (a normal quit — it can still prompt you to save). The app name is
  handled safely so a weird name can't run anything else.

- **Find your photos, not just any file.** Muse's Mac file search can now be
  narrowed to photos and images — ask it to "find my photos of the beach" and it
  returns just the image files, not documents. It returns the files' locations,
  so you can open or copy them.

- **A connected tool now gets an accurate description of what Muse offers.**
  When another app connects to Muse's MCP server, the summary it receives now
  lists all of Muse's tools correctly (recall, note search, your model, calendar,
  and tasks — read-only — plus proposing an action for your approval), instead of
  an outdated list of three.

- **Connected tools can read your to-do list.** An agent connected to Muse's
  MCP server can now see your tasks — open ones by default, or finished ones, or
  all — without being able to add, complete, or change anything. An unrecognized
  status filter is refused rather than guessed.

- **Connected tools can read your calendar for a specific window.** When Muse
  runs as an MCP server, an agent can ask what's on your calendar between two
  times and gets exactly that window's events — a request for "today" never
  bleeds in next week's. Read-only, and a malformed or backwards time range is
  refused rather than guessed.

- **Other AI tools can ask Muse to do something, but only you can approve it.**
  When Muse runs as an MCP server, a connected agent can now propose an action
  for you (write a note, add a reminder, draft a message) — Muse parks it in
  your approval queue and never carries it out on its own. You review and
  approve pending items with `muse approvals`; nothing an outside tool proposes
  happens until you say so.

- **Edits keep your file's indentation even when the model's snippet is off.**
  When Muse edits a file and the text it's matching differs only by
  indentation (a common slip for the local model), the change now lands with
  the file's real indentation instead of the model's guess, so an edit no
  longer quietly re-indents the surrounding code. Muse also recovers from a few
  more ways the model can mangle quotes in its edit request.

- **Browser tasks now have an action budget so they can't run away.** When Muse
  is driving a web page, the number of state-changing actions it takes (clicks,
  typing, form fills) is capped per task. Once the cap is reached Muse stops
  acting and tells you, instead of clicking forever, and each action reports how
  many it has used (`actions_used N/M`) with a heads-up as it nears the limit.
  The default is generous (30 actions); raise or lower it with
  `MUSE_BROWSER_MAX_ACTIONS`.

### Fixed

- **A web page can't smuggle instructions into Muse.** Text Muse reads from a
  page is now fenced off as untrusted data before it reaches the model, and the
  classic hijack patterns — "ignore all previous instructions", hidden
  data-exfiltration links/images — are neutralized in code, not left to the
  model to resist. Normal page text is unaffected. (End-to-end proof against a
  real browser lands next.)

- **A web page can't push Muse into confirming or submitting on its own.** If a
  page pops up a confirmation ("OK to delete?") or a text prompt while Muse is
  browsing, Muse now cancels it by default instead of blindly clicking OK or
  submitting text — approving a click was never approval to answer whatever the
  page asks next. The dialog is still reported back so you know it appeared.
  Plain alerts and leave-page prompts are handled as before.

- **Muse's browser won't act on an element that isn't really on the page.**
  If the model refers to a page element by a number that the current view
  doesn't contain — a stale reference left over from a page that changed, or one
  it simply made up — Muse now stops and asks itself to re-read the page instead
  of clicking, typing, hovering, or uploading against a phantom element. Real,
  visible elements work exactly as before.

### Added

- **Opt-in macOS sandbox for local command execution.** Set
  `MUSE_RUNNER_SANDBOX=seatbelt` and every command Muse runs through the Rust
  runner executes inside a macOS seatbelt profile: writes are confined to the
  working directory, the temp dir, and known build caches (pnpm/npm/.cache);
  sensitive paths like `~/.ssh` are write-protected; network is off unless the
  caller opts a specific request in. Proven by real-process contract tests —
  a legitimate build/git flow succeeds while write-escape, home-dir, and
  network attempts are denied by the OS. Unset, behavior is byte-identical to
  before (the sandbox is strictly opt-in); on non-macOS the runner warns and
  runs unsandboxed. `muse doctor` now reports the sandbox posture. The safety
  eval battery also gains three sandbox-escape checks that confirm the OS
  itself blocks each escape, so a regression that weakened the confinement
  would be caught automatically.

- **Clearer confirmation when a shell command hides its real work.** When a
  command Muse wants to run buries what it actually does behind a shell
  construction the safety check can't read through — command substitution
  (`$(…)` / backticks), process substitution, a heredoc, or `eval` — the
  confirmation prompt now flags that plainly so you approve it with eyes open,
  and such a command can never slip through on a mis-labeled "read" risk. A
  legitimate one still runs once you approve; nothing is auto-refused. (Fuller
  automatic downgrade for any future unattended/trusted-run path is tracked as
  a follow-up.)

- **Combining sub-task answers won't overflow — long ones are saved to a file.**
  When Muse merges several finished sub-tasks into one answer, each piece now
  gets a fair share of the space; a piece that's too long is trimmed in the
  prompt and its full text is written to a file under your `~/.muse` folder,
  with the path shown — so a big result is never silently dropped and the merge
  step can't blow past the model's limit.

- **A limit on how many background jobs run at once.** `muse job run` no longer
  starts an unlimited number of background jobs — if you already have the cap's
  worth running (three by default, set `MUSE_JOBS_MAX_CONCURRENT` to change it),
  Muse declines to start another and tells you, instead of piling on work until
  the machine grinds.

- **Task board won't spiral into endless re-splitting.** When Muse breaks a
  request into sub-tasks on its task board, a sub-task can no longer be broken
  down again without bound — decomposition now stops at a set depth (one level
  by default, adjustable), so a request can't recursively fan out forever.

- **Each helper in a split task gets its own smaller step budget.** When Muse
  breaks a request into sub-tasks and works them with separate helper agents,
  each helper now runs with a smaller step allowance of its own instead of
  inheriting the whole task's budget — so several helpers running together can't
  collectively balloon past the intended limit, keeping a split task bounded.

- **Muse says when it's out of its step budget instead of stopping short.**
  A task is capped at a fixed number of tool actions so it can't spin forever.
  When Muse reaches that cap, it now explicitly tells itself it has used all of
  its steps and answers with what it has gathered — rather than quietly running
  out and possibly returning a half-finished reply as if it were done. (Only
  the "ran out of steps" case is affected; a task that finishes on its own, or
  stops for time/no-progress reasons, is unchanged.)

- **Better recaps when a long conversation gets compressed.** When Muse has to
  drop older turns to stay within its context window, it now summarizes them in
  chunks (splitting on tool-call boundaries) and stitches the pieces together,
  instead of one pass over everything — so a big drop keeps more of its detail.
  If part of the summarizing fails, the parts that succeeded are still kept, and
  the summarizer is now told to copy identifiers (IDs, file paths, URLs,
  numbers) exactly rather than paraphrase them.

- **Muse won't accidentally stop the wrong program.** When Muse stops a
  background task it started, it now first checks that the process still running
  under that ID is the same one it launched — because after a program exits, the
  operating system can hand its numeric ID to a completely unrelated program.
  If the identity doesn't match, Muse leaves that program alone and just marks
  its own record finished, so a stale entry can never send a stop signal to
  someone else's process.

- **A file change Muse can't confirm is saved to your approvals list instead of
  dropped.** When Muse (running with tools) wants to write or edit a file but
  there's no interactive prompt to confirm it — a headless or scripted run —
  the change is now recorded on your pending-approvals worklist (the same one
  `muse approvals` shows) rather than silently refused. Nothing is written to
  disk until you approve it. Reuses the existing approvals store, so remote and
  local pending items live in one place.

- **The approval prompt now highlights the risky parts of a command.** When
  Muse asks you to confirm a command, the parts worth a second look —
  a recursive/force delete flag (`-rf`, `--force`), a destructive command
  (`rm`, `dd`, `mkfs`), or a sensitive path (`/`, `~/.ssh`, `/etc`, a device) —
  are shown in bold red so they catch your eye instead of blending into a long
  line. Secrets are still redacted first; the highlight is purely visual and
  never changes what runs.

- **Stops a "ping-pong" tool loop.** A small model sometimes gets stuck
  bouncing between the same two tool calls (do A, do B, do A, do B…) without
  ever making progress, burning its whole step budget and ending in an error.
  Muse now recognizes that alternation and cleanly stops the run instead of
  spinning — it looks at the real action behind each call (ignoring cosmetic
  differences like a fresh timestamp or id), so genuine step-by-step work is
  never mistaken for a loop. Complements the existing stuck-on-one-call guard.

- **Post-compaction loop guard.** When the agent's context is compacted
  mid-run (old turns summarized away), a stuck small model could keep
  re-issuing the exact same tool call — the compaction failed to break the
  loop and nothing caught it. A new deterministic guard arms on compaction
  and aborts the run if an identical tool call (name + arguments + result)
  repeats three times afterward. A run with no compaction is completely
  unaffected.

- **Privacy-tiered routing now covers the interactive chat.** With
  `MUSE_PRIVACY_ROUTING=true` + `MUSE_CLOUD_MODEL` set, a context-free turn in
  the interactive Ink chat may ride the configured cloud model — same
  fail-close policy as the one-shot chat: any personal signal (persona,
  grounding match, PII, possessive marker, remembered-fact reference) keeps the
  turn local, `MUSE_LOCAL_ONLY` forces local unconditionally, and a cloud
  failure silently falls back to the local model. A turn with a `@file` or
  image attachment never rides cloud (attachment content is personal payload).
  Cloud answers still pass the same deterministic grounding gate, and the ☁️
  marker is display-only — never persisted into chat history. Both chat
  surfaces now share one cloud-leg implementation (`createChatCloudTurn`).

## [0.2.32] - 2026-07-10

Ask your notes from anywhere: the grounded ask pipeline now streams over the
API and into the web/desktop app — and every ask surface runs on one shared,
gate-proven pipeline, so answers can't quietly diverge between the CLI, the
API, and the app.

### Added

- **"Ask your notes" in the app.** The Notes view has a question panel: the
  answer streams in word by word, every claim carries a citation chip you can
  tap to open the note it came from, and a confidence badge shows how sure Muse
  is. When your notes don't contain the answer, it says so honestly instead of
  guessing. Bilingual (한국어/English).
- **The ask API streams.** `POST /api/ask` with `Accept: text/event-stream`
  now delivers the answer token by token over SSE — behind the exact same
  citation gate as the buffered response, so a fabricated citation can never
  flash by mid-stream, even split across chunks. The plain JSON response is
  unchanged.
- **The streamed surface is live-proven.** A new real-model battery asserts the
  streaming invariants (deltas equal the final answer; a fabricated source
  never appears in any delta; unanswerable questions abstain) — the grounded
  proof floor ratchets 34 → 35 surfaces.

### Fixed

- **Corrections now beat stale facts in answers.** A note that marks itself
  superseded ("예전에 …였는데 지금은 아니다", "used to …") no longer outranks
  its current counterpart in what Muse answers and cites — on chat, `muse ask`,
  and the API alike. The stale note is demoted, never hidden.
- **Opening and searching notes in the app actually works against a live
  server.** Both calls disagreed with the server's contract (they always
  failed silently in the browser), which also broke tapping a citation chip —
  found by driving the real app end-to-end, fixed everywhere.

### Changed

- **One ask pipeline everywhere.** Plain `muse ask` now runs on the same shared
  grounded-recall pipeline as the API and the MCP tool, so the flagship surface
  can no longer drift from the gate the live batteries prove. (Tool-using runs
  keep their dedicated path for now.)
- **Verification integrity.** Direct test runs in 8 packages no longer pick up
  stale compiled copies of old tests, which could mask a real failure with an
  outdated pass.

## [0.2.31] - 2026-07-09

Three real bugs, found by running the app against a real store instead of an empty one.

### Fixed

- **The sidebar subtitle could blurt a raw fact from memory.** It rendered "DR. KIM" —
  the name of a dentist stored in memory. A tagline was only checked for *grounding*
  ("is every word backed by a fact?"), which a bare echo of a fact trivially passes. It
  must now also be *well-formed* — framed the way the templates are ("커피 담당", "On
  coffee duty") — and clear person names are no longer used as material. Fabrication=0
  is unchanged; this composes on top of it.
- **Overdue items said "now".** Every past due-time collapsed to "지금 / now", so a
  reminder a month late looked due this minute. Past times now read as overdue with the
  elapsed magnitude ("31일 지남" / "31d overdue") and carry the warning tint; "now" is
  reserved for a genuine ±60-second window.
- **The connection status badge appeared twice** (header and sidebar). It now shows
  once, in the sidebar, with the server address still available as a tooltip.

## [0.2.30] - 2026-07-09

### Added

- **Chat starter prompts.** The empty chat now shows tappable starter chips grounded in
  what Muse can actually do — "오늘 일정 정리 / Summarize my day", "이번 주 할 일 / Tasks
  this week", "최근 노트 요약 / Summarize my notes", "뭘 도와줄 수 있어? / What can you
  help with?". Tapping one fills the input and focuses it (never auto-sends, so you stay
  in control); the chips disappear once a conversation starts.

## [0.2.29] - 2026-07-09

Web/desktop UI polish (real-browser verified).

### Changed

- **Branding matches the product voice.** Dropped the "AI Conductor / AI 지휘자" framing
  from the web app — the sidebar fallback is now the identity line ("Learns you, not the
  world" / "세상이 아니라, 당신을 배우는 AI") and the window title is just "Muse". (The live
  sidebar subtitle remains the AI-generated, personalized tagline.)
- **Connection status, not a raw address.** The header showed a bare `127.0.0.1:3030`;
  it's now a connection-status badge (connected / connecting / offline) with the URL kept
  as a tooltip and in Settings.
- **Calmer load errors.** When the app can't reach the server, dashboard cards no longer
  surface the raw browser "Failed to fetch" — they show a gentle "Couldn't load / 불러올
  수 없어요" with a check-your-connection hint.

## [0.2.28] - 2026-07-09

Onboarding nudge + a big test-coverage pass.

### Added

- **First-run points you at real first value.** After setup, the wizard now suggests
  `muse browsing sync` (seed answers from your Chrome history) and `muse demo` (a cited
  example) as next steps — a bilingual, opt-in suggestion (never auto-run), and it drops
  the browsing hint if you already connected it.

### Changed

- **~100 new tests** locking in behavior with no source changes: local tasks/notes
  providers and the weather tool (round-trips, corrupt-store degrade, write-atomicity,
  injected-fetch degrade paths that never fabricate), plus the memory user-store Kysely
  runtime, file-lock exhaustion, and pattern-detector boundaries. Each mutation-checked
  for teeth.

## [0.2.27] - 2026-07-09

Two headline additions — bring your own ChatGPT-subscription model via Codex, and
the grounding gate now covers the chat API too — plus memory/observability polish.

### Added

- **Codex delegation (opt-in).** If you have a ChatGPT Plus/Pro subscription and the
  official `codex` CLI installed + logged in, you can point Muse's chat/ask at it —
  Muse shells out to the official CLI (read-only sandbox, ephemeral, neutral workdir)
  and **never touches your OAuth token**. It's **off by default** (local stays the
  default), selected only via `--model codex/codex-default` or an opt-in setup choice,
  and blocked under `MUSE_LOCAL_ONLY=true`. Heads-up: using a ChatGPT *subscription* to
  back a third-party app is an unofficial, gray-area route (a cloud API key is the
  clean path) — Muse says so up front. Text answers only (no tool-calling via Codex);
  Muse still grounds and cites the result.
- **Compaction failure telemetry.** Memory-compaction failures are now classified into
  bounded reasons (no-compactable-entries / below-threshold / guard-blocked / summary-
  failed / timeout / provider 4xx·5xx / unknown) instead of opaque strings.
- **`muse browsing search --json`** now emits the same grounded block (`groundedVerdict`
  + citations) as `muse ask --json`, for consistent scripting across surfaces.

### Fixed

- **The chat API is now grounded like everything else.** `/chat` and `/api/chat` (and
  the streaming variants) route through the same deterministic grounding + citation gate
  as `/api/ask`: an ungroundable claim is dropped by code (→ "I'm not sure"), a grounded
  answer passes through unchanged, and the response carries the grounding verdict. This
  closes a real hole in Muse's core "every claim cites a real source" guarantee.
- The chat-ink "generating…" line and interactive grounding parity (Korean NFC input,
  pronoun follow-up rewrite) are now regression-guarded with wiring-level tests.

## [0.2.26] - 2026-07-08

The remaining pre-release polish items from the deep CLI audit: sharper command
naming, a consistent error voice, and a knob for a slow model.

### Fixed

- **`approval` vs `approvals` are no longer confusable.** The two adjacent groups
  both exposed `approve <id>`/`list`; their descriptions now name their distinct
  domains and cross-reference each other — `approval` = tool-call trust decisions,
  `approvals` = the outbound draft-first action worklist. (Names unchanged — no
  breaking change.)
- **Consistent error voice.** `import`, `ingest`, `bg`, and `approvals` now print
  failures through one `muse <command>: <message>` envelope instead of a mix of
  ad-hoc prefixes, with exit codes and stdout/stderr routing unchanged.

### Added

- **`MUSE_STREAM_IDLE_TIMEOUT_MS`** makes the streaming idle-timeout tunable. A
  model that connects but never responds no longer freezes `ask`/`chat` for the
  fixed 3 minutes — set e.g. `MUSE_STREAM_IDLE_TIMEOUT_MS=8000` to fail fast. The
  default (180 s) is unchanged, and the value can only *shorten* a real stall
  (`0`/negative/non-numeric fall back to the default, so it can't be disabled).

## [0.2.25] - 2026-07-08

A second, deeper pre-release CLI audit (four independent expert passes — no
blockers found) turned up a handful of real rough edges in the setup/onboarding
posture, help output, branding, and input robustness. This fixes them.

### Fixed

- **`muse setup` no longer tells a local-first user their model is "not
  configured".** On a fresh box it now credits the resolved local default
  (`ollama/gemma4:12b`) exactly like `muse doctor` — the two surfaces finally
  agree — and the next-step nudge is a soft "customize with `muse setup local`",
  not a push toward cloud providers you don't need.
- **`muse setup local` credits the model you already have.** It recommends the
  pinned local default instead of a 17 GB power-tier download, and persists your
  choice to config so the setup checklist actually clears.
- **The "New here?" banner stays on the top-level help.** It was leaking onto
  every one of 300+ subcommand `--help` outputs (and into piped stdout).
- **Off-brand "JARVIS" wording removed** from the `remember`, `brief`, and
  `status` help text and the briefing prompt — Muse is Muse.
- **A giant command-line argument no longer crashes with a raw stack trace.**
  Pasting ~1 MB of text as an argument (e.g. `muse note "$(pbpaste)"`) now prints
  a clean "input too large — pipe via stdin instead" message and exits 1.
- **Config writes are atomic.** `config.json` is written via a temp file + rename,
  so a crash mid-write can't truncate your settings.
- **Clean message when a store path is unreadable.** A config file that's actually
  a directory (or lacks read permission) now explains the problem instead of
  leaking a raw `EISDIR`/`EACCES` errno.

## [0.2.24] - 2026-07-08

A CLI-quality follow-up to 0.2.23: an expert audit turned up ten rough edges in
help, error handling, and flags — this fixes all of them, each with a test.

### Fixed

- **`muse help <command>` now works.** It renders the target command's full help
  (identical to `muse <command> --help`); an unknown name gets a grounded error.
  Previously `help` fell through to the unknown-command path.
- **Typos in a subcommand are caught, not swallowed.** `muse setup lcoal` used to
  silently run the `status` dashboard and drop the bad word; it now prints
  `unknown command` + a "did you mean 'muse setup local'?" suggestion and exits 1.
  `muse setup` with no argument still shows status.
- **`-q/--quiet` actually goes quiet.** The flag was wired but unused; it now
  suppresses the `today` empty-state hints, the two `ask` preference tips, and the
  chat spinner, while keeping the primary output and errors.
- **`--no-color` wins over an ambient `FORCE_COLOR`.** Precedence is now
  `NO_COLOR` > `--no-color` > `FORCE_COLOR` > `TERM=dumb` > TTY detection.
- **`--no-input` no longer hangs `setup data`.** A non-interactive run takes the
  safe default instead of blocking on a confirm prompt.
- **User mistakes read as user mistakes.** An invalid `--config`/`--args` JSON or a
  corrupt `config.json` now prints one clean fix-it line naming the problem,
  instead of a scary "internal bug" report with a GitHub-issue link.
- **`remind snooze` only moves reminders later.** A future reminder snoozed to
  `max(now, due) + 10min` (a tomorrow-18:00 reminder → 18:10 tomorrow), instead of
  being pulled back to `now + 10min`; a past-due one still clamps to ~now.
- **Correct copy-paste hints.** `muse setup` and `muse today` now suggest real
  commands (`muse tasks add`, `muse calendar add`, correct `remind add` argument
  order) that run as shown.
- **Every command is grouped in `--help`.** 21 commands that sat in a bare
  "Commands:" bucket are now filed under their proper headings, and `completion`
  appears in its own completion candidate list.

### Changed

- **Docs: local-only is opt-in.** The README now states plainly that Muse runs
  local by default and is provider-neutral; `MUSE_LOCAL_ONLY=true` is the explicit
  opt-in that fail-closes all cloud egress (it is no longer described as the
  enforced default).

## [0.2.23] - 2026-07-08

A best-in-class pass on the CLI, grounded in the clig.dev guidelines: it starts
faster, reads cleaner, and helps you more.

### Added

- **Examples-first help.** The daily-driver commands (ask, today, remember,
  skills, mcp, ingest, setup) now show a copy-pasteable "Examples:" block on
  `--help`, safe path first.
- **Global flags:** `--no-color`, `-q/--quiet` (suppress tips/spinners, keep
  primary output + errors), and `--no-input` (never prompt — take the safe
  non-interactive default). A "New here?" hint and a docs/support footer on the
  top-level help.
- **Humane errors.** Expected failures (API unreachable, bad flags) print one
  clean line with a next-step hint; genuine bugs print a pre-filled GitHub issue
  link with the version + command.
- **Distinct conversation turns.** Each exchange starts with a dim rule + `#N`
  number and a bold prompt header, so a long chat is scannable.
- **Cleaner answers.** Model answers render markdown properly — framed code
  blocks with a language label (no more raw ```backticks), aligned/nested lists,
  highlighted inline code, readable links, and blank-line spacing.
- **A truthful HUD** with a context-usage indicator (`ctx N%`): a local Ollama
  model reads 🔒 local (the old HUD false-alarmed ⚠ cloud), warning only when
  data can actually egress. The HUD segments stay customizable.

### Changed

- **~6× faster cold start on light commands.** The CLI now lazy-loads commands
  instead of importing the whole graph at startup: `--help` 374→68ms,
  `completion` 386→61ms, `config-path` 384→62ms; heavier commands drop ~40% to
  their own dependency floor. `--help`, completion, and did-you-mean are
  unchanged; `--version` stays ~20ms.

### Fixed

- Complete colour discipline: `NO_COLOR` > `FORCE_COLOR` > `--no-color` >
  `TERM=dumb` > isTTY (a piped/CI/dumb terminal never gets ANSI).

## [0.2.22] - 2026-07-08

Terminal polish: the `muse` chat gets a living bluebird and a HUD you can shape,
and the first-run wizard now reads as clearly-numbered steps.

### Added

- **An animated bluebird in the terminal chat.** The chat home screen shows a
  small pixel bluebird (the same mascot art) that gently bobs and blinks on an
  idle loop, above the input. Static under `NO_COLOR` / non-TTY / `MUSE_NO_ANIM`.
- **A customizable HUD.** Shape the status bar: `MUSE_HUD_SEGMENTS=model,locality,
  tools,skills` picks and orders segments, and `MUSE_HUD=minimal` / `full` are
  preset shortcuts. Unset stays exactly as before.

### Changed

- **Clearer first-run setup steps.** The wizard now frames its flow as numbered
  steps with a ruled divider before each — 1/3 pick a model, 2/3 connect your
  data, 3/3 finishing up — instead of one long undifferentiated scroll; the
  per-provider confirmations were tightened so each step reads as its own block.

## [0.2.21] - 2026-07-08

A first-run experience worthy of the app: `muse` now opens a warm, branded setup
wizard, walks you through connecting your data, and proves its value on the first
screen — and the app's empty states now guide you to value instead of dead-ending.

### Added

- **A premium first-run setup wizard.** On first `muse` (or `muse setup start`),
  a brand-new user gets a branded, bilingual (KO·EN) onboarding — the bluebird
  banner, a designed "how should Muse think?" picker (Local / Cloud API key /
  Codex), and a bird success moment — instead of being dropped into chat. Shows
  once; `--no-setup` / `MUSE_SKIP_FIRST_RUN` bypass it; fail-soft into chat.
- **Connect your data during setup.** After picking a model, the wizard offers a
  multi-select of the safe, built-in connectors (Apple Contacts, Chrome browsing
  history, Reminders/Notes mirrors) so setup ends with real data — the "learns
  you" value starts on day one. Opt-in and skippable.
- **A proof-of-value moment.** Setup finishes with a personalized, grounded line
  ("Sam님, 연락처 12명 연결됐어요 — 이제 당신을 배울게요"); an empty install gets a warm
  content-free welcome. Fabrication = 0 — it can never invent a trait.
- **Codex (your ChatGPT subscription) as a setup option** — detects your own
  official `codex` CLI login and delegates to it (Muse never handles the token),
  with honest copy up front (an unofficial third-party route; the clean path is a
  Cloud API key). Live routing is a flagged preview.
- **Starter skills** scaffolded on a fresh install (daily-briefing, quick-capture)
  when the skills folder is empty.
- **Actionable empty states in the app.** "No tasks / notes / …" blanks became
  warm CTAs — add your first task, connect a calendar, "start a chat and Muse
  will learn" — that move you toward value instead of dead-ending.

## [0.2.20] - 2026-07-08

Muse gets a face and a fresh coat of paint: the pixel bluebird now lives across
the whole app, the in-app UI got a Toss/Apple-grade redesign, the `muse` chat
fills your terminal like a proper TUI — and Muse is now provider-neutral, with
cloud allowed by default.

### ⚠️ Heads-up

- **Cloud is now allowed by default; `MUSE_LOCAL_ONLY` is opt-in.** Muse runs on
  cloud or local models — your choice. To keep the old strictly-on-device
  posture (no cloud egress, fail-closed), set `MUSE_LOCAL_ONLY=true`: the
  guarantee and its gate are fully kept, just no longer forced. With no cloud key
  set, Muse still boots on the local default (gemma4:12b).

### Added

- **The bluebird, everywhere.** An original, code-drawn pixel bluebird mascot is
  now the app icon, the menu-bar glyph, the animated desktop companion, the CLI
  banner, and the web DeskPet — the old goddess imagery is retired.
- **A companion with personality.** The desktop bluebird cracks little jokes,
  teases gently, and speaks real, grounded context (your next reminder, a due
  task) — varied every time, and it can never assert a fact it doesn't have
  (fabrication = 0).
- **Toss/Apple-grade in-app redesign.** The web UI (chat, today, sidebar, cards,
  empty states) moved from flat grey to a calm, precise dark design — a
  considered accent, soft depth, tabular numerals, refined typography.
- **A personalized sidebar tagline.** Instead of a fixed "AI Conductor", the
  sidebar shows a fun line personalized to what Muse knows about you ("개발자·커피
  담당") — different each open, and grounded (never invented).
- **Full-screen `muse` chat.** The terminal chat now fills the screen like a
  proper TUI: banner on top, a big canvas, the input pinned at the bottom, a
  one-line status bar — Korean (IME) input preserved.
- **Grounded proactive openers** (`muse companion-line`) drawn from your real
  calendar / reminders / notes.

### Changed

- **Instant chat open.** `muse` no longer composes a full morning briefing on
  startup (a weather fetch + two model calls) — the chat appears immediately; the
  day view is on demand via `muse today`.
- The onboarding window is centered and right-sized with an Apple-style layout,
  and its "ready" copy now reads human (and varies), not a machine string.

### Fixed

- The bundled desktop CLI crashed at startup on `node:sqlite` — fixed, so the
  companion's openers and real in-app chat work again.
- `file_read` no longer scans Downloads / Desktop / Documents unprompted (no more
  surprise macOS permission prompt); it's opt-in via `MUSE_FS_DOC_ROOTS`.
- Chat answers route through a hardened citation gate; the interactive chat gains
  contextual query rewrite, NFC-normalized input, and weakness-ledger parity.
- The chat mascot no longer clips at the top; honest connection-refused hints for
  API-only admin commands.

### Developer

- A predictable window-placement layer + `apps/desktop/scripts/shot.sh` let the
  desktop app be driven and screenshotted deterministically for tests.

## [0.2.19] - 2026-07-08

The bluebird takes over every surface — and fixed a real chat bug on
the way. Early / experimental, macOS only.

### Added

- **The mascot is everywhere now.** The README opens with an animated
  bluebird (a self-contained SVG generated from the same pixel data —
  it blinks and tilts right on GitHub), and `muse logo` plus the chat
  banner render the bird in the terminal with true-color half-blocks
  (it even blinks once; NO_COLOR gets a clean text fallback). One
  canonical pixel source (`@muse/mascot`) feeds every surface, with a
  drift guard so the app's copy can never silently diverge. The old
  goddess artwork is retired.

### Fixed

- **Chat's message list now actually scrolls.** A broken CSS height
  chain meant the chat scroller never scrolled (the whole page moved
  instead) — found while investigating the mascot's clipped head,
  which is also fixed: the bird and its chirp/zzz/heart overlays now
  always have headroom above the input.

## [0.2.18] - 2026-07-07

Muse has a face now — meet the bluebird. Plus focused compaction, a
stricter citation gate, and Muse itself as an MCP server. Early /
experimental, macOS only.

### Added

- **Muse's mascot: a pixel bluebird lives on the chat input.** Drawn
  entirely in code (no image assets — even the favicon is generated
  from the same pixel data), it hops along the composer edge, blinks,
  tilts, pecks, preens, occasionally flaps or sings to itself, dozes
  off with a quiet zzz when you've been away, perks up while Muse is
  thinking, chirps when your answer arrives, and shivers-then-droops
  if a request fails. Static under reduced-motion, provably zero
  layout impact, never blocks a click. Design showroom:
  `docs/design/mascot-showroom.html`.
- **`muse mcp serve`** exposes Muse itself as a local, read-only MCP
  server over stdio — so another agent (Claude Code, Cursor, Codex, …)
  can call `muse_recall` (cited grounded Q&A over your notes),
  `knowledge_search` (deterministic ranked search over your notes +
  remembered facts/preferences, no model required), and
  `user_model_read` (your facts/preferences with confidence; never
  vetoed/forgotten entries). No write/outbound tools, no network
  listener; running the command is your explicit consent to expose
  these read tools to the connecting client.
- **`/compact <topic>` in chat performs a real, focused compaction** —
  compress the conversation around what matters now, behind a
  fail-close quality gate so a bad summary never silently replaces
  your history.
- **Recall receipts now always state whether a claim is single-source
  or corroborated**, so you can weigh an answer's footing at a glance.

### Changed

- **Playbook distillation and skill authoring are now on by default** —
  Muse learns reusable strategies from its own successful runs without
  an opt-in flag.

### Fixed

- **The citation gate now drops the entire fabricated clause, not just
  its citation marker** — previously an ungroundable claim could lose
  its bracket but keep its words.

## [0.2.17] - 2026-07-07

Connecting your Mac's data to Muse is now one guided command. Early /
experimental, macOS only.

### Added

- **`muse setup data`** walks you through everything Muse can learn
  from, in one flow: import your Contacts (runs immediately, shows the
  count), sync your Chrome history, and turn on the standing switches
  (hourly browsing auto-sync, Reminders/Notes mirrors) — emitted as a
  ready-to-paste snippet for your shell profile. Every step asks first
  and defaults to no; scripting uses explicit per-feature flags (there
  is deliberately no --yes). A fresh install's onboarding now points
  here, so the "empty Muse" problem solves itself on day one.

## [0.2.16] - 2026-07-07

Your address book can now feed Muse's memory. Early / experimental,
macOS only.

### Added

- **`muse contacts import --apple` imports your macOS Contacts** —
  names, phones, emails, and birthdays (year-less birthdays included) —
  into Muse's contact store, so birthday briefings, overdue-contact
  nudges, and "send it to 민수" recipient resolution finally have data
  to work with. The merge is additive-only: anything you've set by hand
  (relationships, notes) is never overwritten, and re-running the
  import converges instead of duplicating. If macOS hasn't granted
  Contacts access yet, you get a clear instruction instead of a hang.

## [0.2.15] - 2026-07-07

Korean voice input works out of the (opt-in) box, and "방해금지 켜줘"
now actually turns on Do Not Disturb. Early / experimental, macOS only.

### Added

- **Focus / Do-Not-Disturb control from chat.** "방해금지 켜줘" /
  "집중모드 꺼줘" toggles Focus via Apple's own Shortcuts "Set Focus"
  action (you create two small shortcuts once — Muse tells you exactly
  how if they're missing, and `muse doctor` checks they exist).
  Verified live on the local model: correct tool choice 48/48 including
  the "볼륨 꺼줘" confusable.
- **`muse doctor` now guides voice setup.** It reports STT/TTS state
  and, when off, the exact steps to enable local voice — including the
  Korean TTS voice option (with its non-commercial license caveat
  stated plainly).

### Changed

- **The default speech-recognition model is now multilingual, so
  Korean voice input just works.** Previously the shipped default was
  an English-only model that failed silently on Korean speech. If you
  already downloaded the old English model, it keeps working (with a
  one-time hint about the multilingual upgrade); an explicit
  `MUSE_WHISPER_CPP_MODEL` is always respected.

## [0.2.14] - 2026-07-07

Muse notes can now follow you into Apple Notes. Early / experimental,
macOS only.

### Added

- **Apple Notes mirror.** With `MUSE_APPLE_NOTES_MIRROR=true` (off by
  default), a note you deliberately create in Muse — in chat, via
  `muse notes save`, or through the API — is also created in Apple
  Notes.app, with multi-line content preserved. Deliberate is the key
  word: bulk imports, the daily quick-note inbox, and edits of existing
  notes never mirror, so Notes.app doesn't get spammed, and your Muse
  notes (the recall corpus) are provably untouched by the mirror. Note
  text is escaped against both HTML and AppleScript injection, each
  layer mutation-tested with hostile payloads.

## [0.2.13] - 2026-07-07

Muse reminders can now follow you onto your iPhone and Watch. Early /
experimental, macOS only.

### Added

- **Apple Reminders mirror.** With `MUSE_APPLE_REMINDERS_MIRROR=true`
  (off by default), any reminder you create in Muse — in chat, via
  `muse remind add`, or through the API — is also created in Apple
  Reminders.app, so it shows up across your Apple devices. Muse's own
  store remains the source of truth for briefings and follow-ups; the
  mirror is a one-way, best-effort copy that can never fail or lose
  your reminder (a mirror problem surfaces as a warning with an
  actionable permission hint). Reminder text is escaped against
  AppleScript injection, mutation-tested with hostile payloads.

### Fixed

- **The calendar command no longer describes itself as read-only.**
  Event creation/editing/deletion has been shipped for a while — a
  stale description string was misleading users (and one of our own
  capability audits).

## [0.2.12] - 2026-07-07

Muse's vision now has proven Korean coverage — and the proof reversed
our own hypothesis. Early / experimental, macOS only.

### Added

- **Korean documents are now part of the vision test floor.** Two
  realistic Korean fixtures (a receipt and an event flyer) and Korean
  cases across both vision batteries permanently guard field
  extraction, grounded answers, and honest abstention on Hangul
  content.
- **A measured model decision, recorded in code.** A head-to-head run
  showed gemma4:12b handles all Korean cases cleanly (6/6 actions, 5/5
  grounding) while the candidate qwen3-vl:8b consistently failed
  calendar-event extraction in both languages — so the default stays
  gemma4, with the measurement written into the code so the rationale
  can't rot.
- **`MUSE_VISION_MODEL` lets you point image understanding at a
  different local model** without touching the chat model — fail-soft
  (an unavailable override falls back safely), and `muse doctor` shows
  which vision model is active.

## [0.2.11] - 2026-07-07

The browsing and feed recall shipped this week are now permanently
guarded: two new live batteries in the fabrication-zero release gate
mean a future change that breaks them fails CI numerically. Early /
experimental, macOS only.

### Added

- **Browsing recall and cross-language feed rescue are now regression-
  gated.** Two live batteries (real local model, real embeddings, the
  real citation gate) continuously prove: a visited page is cited, a
  Korean question still reaches an English title, a fabricated
  browsing/feed citation is stripped, an empty archive stays silent,
  and the embedding-powered rescue is genuinely load-bearing (its
  negative control must fail). The grounded-surface ratchet rises
  30→32 — if either surface ever drops out of the gate, `self-eval`
  fails the build.

## [0.2.10] - 2026-07-07

Cross-language recall now covers your RSS feeds too. Early /
experimental, macOS only.

### Added

- **A Korean question can now find an English feed headline.** Feed
  entry titles are embedded locally when a feed is added or refreshed,
  so asking "지난주에 나온 러스트 릴리스 소식 있었어?" surfaces an
  older "Rust 1.80.0 released" headline from your subscriptions — even
  when it has fallen out of the recent-headlines window — cited
  `[feed: ...]` under the same citation gate as everything else. The
  recent-headlines behavior you already have is unchanged, and if the
  local model is offline, feed refreshes simply continue without
  embeddings.

### Fixed

- **Feed refreshes can no longer silently discard the embeddings they
  just built.** RSS re-delivers the same entries on every refresh; the
  store merge now carries each entry's embedding forward unless its
  title actually changed (in which case it is re-embedded on the next
  pass).

## [0.2.9] - 2026-07-07

Browsing memory grows up: Muse can now keep learning from your browsing
passively (one opt-in switch), and a Korean question can find an
English-titled page. Early / experimental, macOS only.

### Added

- **Set-and-forget browsing sync.** With `MUSE_BROWSING_AUTO_SYNC=true`
  the daemon quietly imports new Chrome visits about once an hour
  (`MUSE_BROWSING_SYNC_INTERVAL_MINUTES` to tune) — no more remembering
  to run the sync command. Still strictly opt-in: with the switch off
  (the default), no background process ever touches the Chrome file, and
  a test pins that guarantee.
- **Cross-language recall over your browsing history.** Page titles are
  now embedded locally at sync time, so asking "지난주에 본 러스트
  블로그 뭐였지?" finds "Announcing Rust 1.80.0" — a Korean question
  reaching an English page, verified live on the local model. Everything
  stays on your machine (localhost embedder only), and if the local
  model is offline, syncing simply continues without embeddings.

## [0.2.8] - 2026-07-07

Muse can now learn from what you browse — the start of "learns you without
you writing notes". Your Chrome history becomes a first-class, cited memory
source, 100% locally: nothing ever leaves your machine, and nothing is read
until you explicitly ask. Early / experimental, macOS only.

### Added

- **`muse browsing sync` imports your Chrome browsing history into Muse's
  local store** — opt-in by running the command (no daemon or background
  process ever touches the Chrome file), zero new dependencies, zero
  network calls, and the store is written owner-read-only. Only page
  visits (http/https) are ingested; cookies and passwords are never
  touched. `muse browsing search` and `muse browsing recent` explore it.
- **`muse ask` can now answer from pages you visited, with a real
  citation.** "그 러스트 블로그 뭐였지?" gets a grounded answer marked
  `[browsing: blog.rust-lang.org]` plus a "🌐 from pages you visited"
  receipt — under the same deterministic citation gate as every other
  source, so a made-up page citation is stripped by code. Page titles are
  treated as untrusted third-party text throughout (prompt-injection
  escaping, untrusted-source cue). Korean queries match Korean titles.
- **The agent can search your history in conversation** via a new
  `browsing_search` tool ("that article I read last week"), verified to
  route correctly on the local model alongside web search and feed search.

## [0.2.7] - 2026-07-03

Three correctness fixes surfaced by a fresh backlog pass, all tied to Muse
honestly reporting its own state — an ungrounded answer, an MCP connection
audit, and a credential check each had a case where they silently lied.
Early / experimental, macOS only.

### Fixed

- **A complex `muse ask --with-tools` request that decomposes into several
  sub-tasks, where EVERY sub-task fails to find an answer, no longer prints
  a blank line.** It now gives the same honest "I'm not sure" refusal Muse
  gives everywhere else, so the citation/refusal messaging around it works
  correctly too.
- **`muse doctor` no longer falsely reports an official MCP preset
  (GitHub/Notion/Linear/Sentry) as "blocked".** When you explicitly enable
  one with a credential, Muse automatically permits it even under a strict
  allowlist — the doctor's audit view now reports that same reality instead
  of a stale "blocked" reading.
- **A whitespace-only value in a `~/.muse/*.json` credentials file
  (model API key, MCP token, or messaging bot token) is now correctly
  treated as no credential at all**, instead of being used as-is and
  silently producing a broken auth header.

## [0.2.6] - 2026-07-03

Three more source-level scouting findings against the fastest-moving open
agents, each closing a real gap: silent context-window truncation, no way
to reach a gated self-hosted LLM, and no visibility into what auto-trimming
would drop. Early / experimental, macOS only.

### Added

- **Muse can now learn a local Ollama model's real context window instead
  of trusting a static, sometimes-wrong catalog value.** Opt in with
  `MUSE_OLLAMA_PROBE_CONTEXT=true`: Muse asks Ollama directly, and if your
  configured context size is larger than what the model actually supports,
  it's clamped down automatically (with a one-time warning) so prompts
  never get silently truncated.
- **Custom HTTP headers can now be attached to every model request** via
  `MUSE_MODEL_EXTRA_HEADERS` (a JSON object) — for a self-hosted LLM gateway
  behind a reverse proxy or service-token auth that needs more than a
  standard API key.
- **A new `/compact` command in chat previews what auto-compaction would
  drop** — message count, token budget, and which messages would go —
  before it happens, without touching your conversation.

## [0.2.5] - 2026-07-03

A second round of source-level scouting against the fastest-moving open
agents, this time turning up five real self-bugs — two of them in code
shipped earlier today. Early / experimental, macOS only.

### Fixed

- **A crashed external MCP server no longer stays broken until you notice
  and manually reconnect.** It now self-heals on the very next call.
- **Non-ASCII output from background processes and Shortcuts can no longer
  get corrupted.** Korean/CJK/emoji text that happened to split across a
  process's output stream — window titles, skill output, tar file listings,
  notification text — could turn into garbled replacement characters;
  fixed at all eight affected call sites.
- **A single transient hiccup in the background context-summarizer no
  longer costs 10 minutes of degraded compaction** — it retries with
  backoff before giving up.
- **The local multi-model advisory feature (added earlier today) is now
  ~44% faster** for a typical turn — advisor models can be capped
  independently of the model that writes the final answer, since the turn
  was waiting on the slowest advisor's full-length output.
- **A future schema upgrade to your feeds, episode, or notes index can no
  longer silently wipe your data** — a version mismatch now backs up the
  old file before starting fresh, instead of silently discarding it.

## [0.2.4] - 2026-07-03

Runtime resilience and safety hardening, closing every finding from a
source-level scout of the fastest-moving open agents (openclaw, hermes) and a
config drift-guard. Early / experimental, macOS only.

### Added

- **Faster startup**: a V8 compile cache shaves ~12% off `muse`'s warm
  cold-start on every invocation.
- **`muse doctor` state-integrity checks**: flags `~/.muse` sitting inside a
  cloud-sync folder (iCloud/Dropbox/Drive/OneDrive — multi-device sync can
  corrupt the local file locks), permission drift on any of 8 sensitive
  stores, and an aggressively-low tool-output cap that would silently starve
  grounding evidence.
- **Local multi-model advisory pass**: a new opt-in mechanism lets several
  local models answer a question in parallel and one model synthesize the
  final answer having seen all of them — distinct from the existing
  multi-agent council debate.
- **Background-job finish notices**: `muse bg run` jobs now send a one-shot
  heads-up when they exit, even across a crash/restart.
- **Daemon health surfacing**: `muse doctor`/`status` can now tell "the
  background daemon is running but failing every tick" apart from "it isn't
  running at all."
- External MCP servers get an additional live malware-advisory check before
  connecting (on top of the existing static audit), and the skill curator now
  snapshots before pruning and won't archive a skill a scheduled job still
  depends on.
- Local state (run logs, checkpoints, the audit log, the learn queue) is now
  pruned by age automatically instead of growing forever.
- A new `MUSE_*` environment-variable inventory (479 vars) is drift-guarded
  in CI so an env var can't silently go undocumented or stop being read.

### Fixed

- **A hung local model can no longer freeze a whole daemon tick.** Every
  model call in the batch now runs with independent timing, and read-only
  tool calls in the same turn now execute in parallel instead of one at a
  time.
- **A failing background-compaction summarizer stops retrying itself into a
  freeze** — it now backs off after repeated failures or after two rounds
  that didn't meaningfully shrink the context.
- **An MCP reconnect batch no longer aborts entirely because one server
  failed** — each server's reconnect is now isolated.
- Interactive chat (`muse chat`) turns now write the same outcome-labelled
  run-log trace that `muse ask` always has, closing a blind spot in
  `muse trace`/`muse doctor`'s failure-rate view.
- A reflection-guard registry drift (two surfaces moved without updating
  their pinned paths) is fixed and now caught by its own guard.

## [0.2.3] - 2026-07-03

The grounded-recall engine is now a shared package, and the API server can
answer grounded questions on its own. Early / experimental, macOS only.

### Added

- **`POST /api/ask` — grounded recall over your notes on the API surface.**
  The server (and anything built on it) can now answer a question from your
  notes corpus with the same guarantees the CLI gives: every claim cites a
  real source, a fabricated citation is removed by code before the response
  leaves, an honest "I'm not sure" never carries a citation, and the response
  reports the retrieval-confidence verdict plus openable source receipts.
  Enabled automatically when the server runs with a model and a notes
  directory configured.
- A new live release-gate battery drives a real local model through the
  shared recall pipeline and proves the fabrication guarantee on real output —
  the grounded-surface count ratchet rises to 30.

### Changed

- The entire retrieval core — embeddings, the notes vector index, chunking,
  the wiki-link graph, PDF/Office/email text extraction, and the four ask
  grounding stages (notes, past sessions/feeds/reflections, shell/git/action
  activity, tasks/calendar/reminders/contacts) — moved from inside the CLI
  into the shared `@muse/recall` package. `muse ask` behaves exactly as
  before; the grounding machinery is simply no longer CLI-only, so every
  current and future surface draws on one implementation.

Deterministic-safety hardening, from a fresh source-level scout of what the
fastest-moving open agents (openclaw, hermes) shipped in the last nine days.
Early / experimental, macOS only.

### Fixed

- **A hung local model can no longer freeze Muse.** Every model HTTP call now
  carries an abort signal plus a safety-cap timeout (`MUSE_MODEL_TIMEOUT_MS`,
  default 5 min, `0` disables) — a wedged Ollama socket times out and retries
  instead of blocking the turn and every daemon tick behind it forever, and
  Ctrl-C during `muse ask` now stops the actual generation, not just the
  output. Streaming keeps its dedicated stall detector and is never
  total-capped, so long answers are safe.
- **The dangerous-command guard resists obfuscation.** The fail-close gate on
  `run_command` now normalizes and re-scans commands at real command
  positions: `$(echo rm) -rf /`, `$IFS`-obfuscation, base64-decode-piped-to-
  shell, `--recur`-style flag abbreviation, and `eval "$(curl …)"` all block,
  while quoted mentions (`git commit -m "rm -rf /"`) and `git rm --cached`
  no longer false-trigger. Approval prompts redact secrets before display.
- **Consent, veto, objectives, and draft-approval records can no longer be
  lost to a process race.** The four outbound-safety stores now take the same
  cross-process file lock the task/reminder stores already used — a daemon
  tick and a manual command can't clobber each other's fail-close records.

## [0.2.1] - 2026-07-02

Trust-signal accuracy release, driven by a fresh-eyes product probe: the
grounding warnings now fire only when they should, "learns you" surfaces your
real memory again, and simple arithmetic answers instantly regardless of
phrasing. Early / experimental, macOS only.

### Fixed

- **False attribution warnings are gone.** The citation checkers recognized
  only the `[from <file>]` marker while answers legitimately cite ten other
  kinds (`[memory: …]`, `[task: …]`, `[reminder: …]`, …) — so the bundled
  demo, plain memory-fact recall, and even small talk fired scary
  "carries no citation" warnings on correctly-cited answers. All marker kinds
  are recognized now, and the ask pipeline no longer feeds a
  citation-stripped answer variant to those checks.
- **Your memory is visible again.** Facts written under the legacy "default"
  user bucket (by an old daemon or early version) were invisible to today's
  OS-named session — a lived-in profile showed "Muse hasn't learned anything
  about you yet" with real facts one key away. The local store now surfaces
  the orphaned bucket as your memory and migrates it on the first write;
  deliberately-named profiles and `user@slot` sub-profiles are untouched.
  `muse status` also reads through the store API now (it previously
  re-parsed the raw file, which would also have broken on an encrypted
  store).
- **Arithmetic answers regardless of phrasing.** "간단히 계산해줘: 3+4" and
  "3+4는 얼마야?" now hit the deterministic calculator instantly instead of
  reaching the grounded path and refusing grade-school math.
- `muse --version` reports the right version (0.2.0 shipped reporting 0.1.2).

## [0.2.0] - 2026-07-02

Muse grows from a grounded Q&A companion into a **durable local agent**: runs
now checkpoint and resume after a crash, long tasks run as managed background
processes, complex requests fan out over a persistent task board, and one
model call can execute a whole multi-step tool plan — all still local-first
and citation-gated. The release also lands a repo-wide code-quality overhaul,
which is why it is a minor bump: six little-used analytics commands were
removed from the CLI. Early / experimental, macOS only.

### Changed (breaking)

- **Breaking:** the six deterministic-statistics commands `muse benford`,
  `muse diversity`, `muse keywords`, `muse trend`, `muse latency`, and
  `muse analytics` are removed. They were demo-grade analysis surfaces
  outside Muse's "learns you" core; if you scripted them, pin `v0.1.2`.
  Everything else on the CLI surface is unchanged (verified by the full
  parser test suite and a live-binary probe after the commander 15 upgrade).

### Added

- **Crash-safe runs**: every agent run writes durable local checkpoints
  after each tool step; `muse resume` re-runs a crashed or interrupted run
  from its last checkpoint without re-executing completed side-effecting
  tools, and `muse trace` is a local time-travel inspector that shows what
  each answer retrieved, which tools ran, and any grounding caveats.
- **Background processes**: `muse bg run/list/stop/restart/logs/prune`
  manages long-running commands with a crash-safe registry, PID
  reconciliation after a crash, uptime display, and `muse doctor`
  surfacing of failures; agents get a matching read-only `background_list`
  tool.
- **Task board**: `muse board` — a persistent Kanban for agent work.
  Complex tasks decompose into a sub-task DAG (sequential or parallel
  fan-out with combined synthesis), standing objectives can seed the board,
  zombie in-progress tasks are reclaimed after a crash, and the web console
  renders a live board view.
- **Programmatic Tool Calling**: `run_tool_plan` lets the local model plan a
  multi-step tool chain in ONE inference and have a deterministic DAG
  interpreter execute it through the same gated tool path — proven live on
  gemma4:12b via few-shot exemplars.
- **SecretSource**: tools read secrets on demand from your local vault
  (Keychain/env) instead of holding them in prompt context; hardened by two
  adversarial red-team passes. External MCP servers now pass a fail-close
  static supply-chain audit before Muse will connect.
- **Smarter self-learning**: reinforcement credit now targets the strategy
  that was ACTUALLY injected into the session (not a lookalike), and a
  cleanly-grounded success implicitly rewards the strategy that helped.
- **Recall additions**: an agent-callable `history_search` tool (hybrid
  lexical+semantic fusion, CJK-aware) and a default-on cross-source
  corroboration hedge on grounded answers.
- **Cloud opt-in wizard**: `muse setup cloud` walks through BYO-key setup
  for Gemini/OpenAI/Anthropic/OpenRouter — strictly opt-in; local-only mode
  still refuses cloud egress in code. `muse models` lists every model with
  its capability profile.
- **Voice**: a persona layer for TTS, a multi-provider fallback chain, and
  sentence-boundary capping for over-long speech.
- **Local cost visibility**: `muse cost local` shows token usage persisted
  locally per run/day — no cloud telemetry.
- **Vision**: `muse ask --auto-image` auto-attaches images referenced in
  your prompt (with a sensitive-path gate).
- **Privacy hardening**: encryption-at-rest for the reflections and
  belief-provenance stores; sensitive URL query values redacted; grounding
  citation fences protected against forgery and scrubbed from answers.

### Fixed

- **Recall calibration**: the confidence floor is now embedder-aware and
  conformally calibrated — the default embedder no longer over-abstains on
  answerable personal questions across ask, chat, and proactive surfaces
  (answerable coverage 15/24 → 21/24 with zero fabrication regressions).
- **Korean & Unicode correctness**: NFC normalization across the whole
  recall path (NFD notes now match NFC queries), full-width character
  folding, Korean mobile-number matching across domestic/E.164 forms,
  natural Korean duration phrases in the scheduler, and Korean actuator
  arguments no longer false-dropped by the anti-fabrication guard.
- **Time correctness**: daily/weekly calendar and reminder recurrences no
  longer drift an hour across DST; all-day events no longer produce false
  conflict warnings.
- **Resilience**: a hung model stream times out instead of hanging the
  agent; retries fail fast on permanent errors; malformed tool-call JSON
  and tool names from small local models are repaired deterministically;
  catastrophic `run_command` inputs (recursive rm/chmod at root) are
  fail-close blocked.
- **Durability**: grounding corpus and sidecar stores write atomically (no
  mid-write corruption); the run log is retention-bounded.
- A verified bug-hunt fixed 26 correctness bugs across the tree and locked
  them with 40 regression tests, plus many smaller stability fixes.

### Changed

- **Repo-wide quality overhaul (2026-07-02)**: a workspace-wide CI gate
  (lint + comment-marker guard + full build/test) now protects every push;
  seven god files were decomposed behavior-preservingly (including the
  2,306-line ask pipeline); `@muse/mcp` was split into focused packages
  (`stores`/`proactivity`/`domain-tools`/`mcp-shared`) with the loopback
  tool-server family unified; package barrels are curated named exports
  (−205 public symbols); duplicated utilities consolidated into
  `@muse/shared`.
- **Dependencies**: latest stable across the tree (React 19.2.7, vitest
  4.1.9, eslint 10.6, fastify 5.9, ink 7.1, vite 8.1, commander 15,
  `@types/node` 26, testcontainers 12).
- **Eval integrity restored**: the package split had silently broken 232 of
  365 tool-selection eval cases plus six verify/smoke batteries (skips
  masked as green) — all live again (eval:tools 360/365, smoke:broad 52/52,
  smoke:live 23/0), and a previously-masked date-reasoning regression is
  now tracked openly.

## [0.1.2] - 2026-06-22

A CLI-and-companion polish release on top of `0.1.1` — **early /
experimental, macOS only**, still a `0.x` pre-release. The focus was making
the `muse` CLI's first screen and everyday output top-grade: a navigable
`--help`, faster trivial commands, action-bearing empty/error states, and one
grounding-accuracy fix on the status dashboard. The native companion and web
console got matching polish.

### Added

- **`muse --help` is now navigable, not a 280-line wall.** The 100+ top-level
  commands are grouped under ordered headings — Chat & ask, Memory & knowledge,
  Planning & time, Setup & status, Automation & agents, Connections, Documents &
  analysis, Reports & history, Diagnostics — with the long tail under the
  default group. The list is also alphabetically sorted within each group.
- **Grounded "did you mean" for unknown subcommands.** `muse <group> <typo>`
  (e.g. `muse memory serch`) now suggests the closest real subcommand and lists
  the group's actual subcommands instead of a dead-end error.
- **Faster trivial commands.** `muse spec` / `muse spec --json` join
  `muse --version` on a pre-framework fast path, skipping the ~100-module
  command graph (~0.5s → ~0.02s).
- **Action-bearing empty states.** `muse objectives list` now tells you the next
  step (`muse objectives add …`) instead of printing a bare "No objectives."
- **Clearer status & progress.** Humanized timestamps on the `muse status`
  dashboard and `muse doctor` summary; scannable `⚠` doctor warnings; overdue
  markers on `muse tasks list`, `muse remind list`, and the in-chat reminder
  list; `[i/N]` progress on `muse notes reindex`; identity-led onboarding on the
  no-model first run; a tightened REPL splash.
- **Companion & web.** Time-of-day companion greeting and adaptive idle-bubble
  timing in the macOS app; keyboard-navigable Automation tabs, ranked
  command-palette results, and Settings API-URL validation in the web console.

### Fixed

- **`muse status` no longer claims your local model was "inferred from
  GEMINI_API_KEY".** Under local-only (the default) the runtime ignores ambient
  cloud keys, so the status line now reads "(local-only default — … ignored)",
  matching `muse doctor` and the privacy posture shown beside it.
- Web console: restored scroll on every view, capped oversized list icons, and
  localized the Automation status badges.

## [0.1.1] - 2026-06-21

A broad polish-and-harden release on top of the first cut — **early /
experimental, macOS only**. Three things got much richer: the native macOS
companion, the "learns _you_" loop (Muse now shows you what it just learned and
forgot, with sources), and the "shows its work" grounding edge (poisoned
external sources — URL-ingested notes, past sessions, tool/feed output — can no
longer launder into a confident "your own data" answer on any surface).

### Added

- **Native macOS companion, fully fleshed out** — a self-contained app that
  bundles the server and web UI, an animated goddess mascot (blink, wink, talk,
  emotion frames), a menu-bar status line (privacy posture · model · server),
  first-run onboarding with a local-AI readiness check, a Korean-localized UI,
  and one-tap access to the full app.
- **Set Muse up entirely from Settings** — install/remove local models, connect
  calendars (macOS / CalDAV / Google), connect a messenger (Telegram / Discord /
  Slack / LINE), and manage background daemons + the MCP server allowlist,
  without touching a config file.
- **Muse shows you what it learned about you** — after a conversation it surfaces
  a cited "got it, here's what I now know" confirmation, and `muse recap` /
  `muse status` / `muse brief` now carry cited "recently learned about you" and
  "Lately about you" lines (preferences as well as facts, with honest
  first-time-vs-updated attribution and a truthful recency window).
- **…and what it forgot** — `muse memory show` / `muse memory why` surface the
  _forgotten_ half too (what you had Muse forget, and the value-change path
  behind a fact, not just a count), and `muse status` shows a compact
  "recently forgotten" line. When you correct a fact in chat, Muse cites the
  prior value it's replacing.
- **Source-trust cues across every grounding surface** — an answer or a proactive
  nudge resting on an externally-ingested note, a past session, or tool/feed
  output is now marked as resting on an unverified source instead of being
  presented as your own data; when a poisonable source disagrees with your own
  note, Muse names the conflict and tells you to trust your own. The provenance
  bit follows a poisoned session into long-term memory so it can't launder later.
- **Local-first privacy posture, made visible** — on the chat HUD, the
  `muse status` dashboard, and the `--help` / first-run screens, with a
  local-first quickstart.
- **Steadier multi-agent orchestration** — opt-in per-worker deadlines that
  explicitly terminate a hung worker, fan-in/synthesis calls bounded by that
  deadline, detection of redundant (repeated) sub-tasks surfaced as an advisory,
  and a reasoning-vs-action alignment check on sequenced handoffs.
- **More reliable tool use on a small local model** — Muse now nudges the model
  off an identical repeated tool call, and when it invents or mis-types a tool
  name it's routed to the nearest real tool (or the command runner) instead of
  failing.
- **Self-improvement web console** — view and reward learned skills, see
  reflections and learned strategies, and edit the MCP allowlist, all from the
  console (backed by new read/write self-improvement API routes).
- **Local-model speed controls (opt-in)** — model warmup on server start, a
  generation-length cap (`MUSE_OLLAMA_NUM_PREDICT`), `num_thread` / `num_gpu`
  Ollama knobs, and a live FrugalGPT-style tiered cascade.

### Changed

- **Sharper terminal art** — the goddess mascot renders in truecolor sextants
  with a transparent background and legible eyes in the CLI/REPL banner, sized
  for clarity.
- **Faster, friendlier CLI** — instant `muse --version` via a pre-framework fast
  path, a discovery on-ramp when you type an unknown command, honest empty-states
  (e.g. `muse notes reindex` with no markdown found), and first screens aligned
  to the learns-you, local-first identity.
- **Clearer truncation of capped output** — file and command results that hit a
  size limit now carry a self-labelled marker (and a narrowing hint) so the model
  re-runs tighter instead of trusting a silently-cut result.

### Fixed

- The floating companion hides while the full app is open, and its input field
  grows vertically with an open-full action in the bubble; web scroll and bubble
  layout fixes.
- `muse --version` no longer reports `0.0.0`.
- `file_list` no longer reports truncated when the matches exactly equal the
  limit; capped `run_command` output stays valid UTF-8 (no split multibyte char).
- Byte-hygiene corrections (escape raw NUL delimiter bytes), and `muse doctor`
  now reports the `MUSE_OLLAMA_NUM_PREDICT` speed setting.

## [0.1.0] - 2026-06-21

First tagged release — **early / experimental, macOS only**. While the major
version is `0`, every release is a pre-release and the public surface may still
change (see [`docs/VERSIONING.md`](docs/VERSIONING.md)).

### Added

- **The personal AI that learns _you_, not the world.** A local-first agent
  that builds a private model of who you are from your own notes and files,
  reinforces what works for you, and forgets the moment you correct it — the
  model of you never leaves your machine (cloud egress is refused in code under
  `MUSE_LOCAL_ONLY`, on by default).
- **"Shows its work" grounding gate** under every surface (recall, proactivity,
  reflection, chat, vision): every claim cites a real source, weak grounding
  becomes "I'm not sure," and an un-groundable claim is dropped by code.
  `fabrication = 0` is a CI-enforced release gate.
- **Runs entirely on a local open-source model** (`gemma4:12b` via Ollama by
  default) behind a model-neutral `ModelProvider` core; the same runtime drives
  the CLI, the API server, and the web UI.
- **Personal-domain surfaces** — notes, tasks, reminders, calendar (5
  providers), a proactive daemon, multi-agent orchestration, messaging
  channels, and a native macOS desktop companion — all draft-first for any
  third-party action, with banking permanently out of scope.

### Fixed

- Fresh `pnpm install` now wires dependency build scripts automatically — no
  manual `pnpm approve-builds` step on a first clone.

### Prior `[Unreleased]` development log

The detailed entries below accumulated during pre-tag iteration on `main` and
are retained here for history.

### Added

- **Grounding gate — architectural-delta benchmark (`pnpm eval:grounding-delta`).**
  The honest "best" claim for a fixed ~12B local model is not an absolute
  faithfulness score (a bigger model beats that) — it is the DELTA a deterministic
  gate buys on the SAME model. This runs the corpus through the real recall stack
  twice — gate ON vs gate OFF (a no-op verdict injected into `runGroundingEval`,
  in the eval harness only, never a production bypass) — and writes
  `docs/benchmarks/RESULTS.md` with the Δ table. First measured number on
  `gemma4:12b`: gate OFF lets 17/17 fabrications through (faithfulness 0.00); gate
  ON catches 16/17 (**0.94**) at **0.00** false-refusal — a **+0.94** lift that is
  purely the gate's architectural contribution, not the model's. (Same-model judge
  ⇒ an internal-validity delta; a public-dataset arm — SQuAD-2.0-style
  answerable/unanswerable — is the next slice to make it externally citable.)

- **`fabrication=0` is now enforced by code, not discipline.** CLAUDE.md calls
  fabrication=0 a release gate and "grounded-surface count never drops", but the
  only git hook was the immutable-core commit-msg guard — a grounding regression
  could land on a green `pnpm check`. Two layers close that:
  - **Deterministic grounded-surface ratchet** (`self-eval`): `countGroundedSurfaces`
    counts the live batteries registered in the `eval:self-improving` release gate
    and exposes them as a numeric scoreboard gate, so `detectRegressions` fails the
    moment a surface is dropped from the gate (no Ollama; runs at the top of every
    loop fire). Proven: dropping one surface yields `groundedSurfaces: 27→26` +
    exit 1.
  - **Live pre-push tripwire** (`pnpm precheck:grounding`): re-spawns the
    fabrication-critical batteries (faithfulness-rate, recall-citation-gate,
    rubric-reverify) `MUSE_EVAL_REPEAT` times each and requires every run to pass
    (pass^k). Installed as a `pre-push` hook by `scripts/install-git-hooks.sh`.
    Fail-open ONLY on a broken environment (Ollama unreachable, or a battery
    exceeds its per-battery timeout → that battery skips); a battery that RUNS and
    FAILS blocks the push. Emergency escape: `MUSE_SKIP_PREPUSH=1`. Proven live:
    3/3 batteries green at pass^2 on `gemma4:12b`.

- **Default local model → `gemma4:12b`** (was `qwen3:8b`). Chosen for native
  multimodal vision plus stronger grounding; verified across every agent-eval
  gate (tools, faithfulness, adversarial safety, judge meta-eval, plan-quality,
  self-improving). Answer temperature is now pinned explicitly (grounding-first
  0.6, `MUSE_ANSWER_TEMPERATURE`) instead of inheriting the model's high default.
- **Grounded vision actions** — turn the camera into a grounded, draft-first
  agent. `muse ask --image` sees a photo; `--extract "f,…"` pulls structured
  JSON; `--auto` classifies the image (event / receipt / contact / document) and
  drafts the matching action (calendar event / expense note / contact / titled
  note), writing only on `--apply`. The agent does the same flag-free given an
  image + a natural request. `muse chat --local --image` and the Ink chat's
  `@photo.png` bring vision to the chat surface. The grounding floor holds on the
  image surface (an unreadable field is omitted, an absent fact is refused — never
  invented), gated by `eval:vision`, `eval:vision-agent`, `eval:vision-grounding`
  (the last registered into the `eval:self-improving` release battery).

- **Proactive surfacing (Phases A + B + C + D)**. New daemon scans the
  calendar registry AND the personal-tasks store every minute
  (`MUSE_PROACTIVE_TICK_MS`, default 60s) and pushes a one-line
  notice via the messaging registry for items in the
  `MUSE_PROACTIVE_LEAD_MINUTES` window (default 10):
  - **Phase A — calendar imminence**: non-all-day events whose
    `startsAt` is in `[now, now + leadMinutes]`. Format
    `⏰ {title} in {N} min (location?)`.
  - **Phase B — task due-soon**: open tasks (status="open") with
    `dueAt` in the same window. Format `📋 {title} due in {N} min`.
  - **Phase C — per-item opt-out**:
    - Calendar: case-insensitive `[no-proactive]` marker in the
      event title or notes suppresses the notice. Provider-neutral
      (works against CalDAV / Google Calendar / LocalCalendar /
      macOS Calendar) since every backend surfaces user-typed text.
    - Tasks: explicit `proactive: false` field on a `PersistedTask`
      suppresses the notice without affecting the rest of the
      lifecycle (still due, still surfaces in `muse today`).
  - **Phase D — agent-initiated turn**: when
    `MUSE_PROACTIVE_AGENT_TURN=true` AND an `AgentRuntime` is wired
    AND the user has touched `/api/chat*` within
    `MUSE_PROACTIVE_ACTIVE_SESSION_WINDOW_MS` (default 300_000 =
    5 min), the daemon spawns a one-shot agent run with a
    JARVIS-style synthesis prompt and uses the LLM reply (with the
    emoji prefix kept) as the notice text. Falls back to the flat
    "⏰ {title} in {N} min" string when the window has lapsed,
    the agent is missing, or synthesis errors. Activity tracker
    defaults to in-process; set
    `MUSE_PROACTIVE_PRESENCE_FILE=~/.muse/presence.json` to switch
    to a file-backed tracker that two processes (apps/api + a
    future `muse listen` daemon) can share, so activity on either
    surface unlocks Phase D for both. Writes are debounced to once
    per second to avoid disk thrash.
  Off by default — activates only when `MUSE_PROACTIVE_PROVIDER` +
  `MUSE_PROACTIVE_DESTINATION` are set, the named provider is
  registered, AND at least one signal is available (a calendar
  registry with ≥1 wired provider OR a `tasksFile` configured).
  Shared dedupe sidecar at `MUSE_PROACTIVE_SIDECAR_FILE`
  (default `~/.muse/proactive-fired.json`) ensures a single item
  fires at most once per `{kind, id, startIso}` tuple; a moved
  meeting / rescheduled task re-fires. Quiet-hours inherit from
  `MUSE_REMINDER_QUIET_HOURS` unless overridden by
  `MUSE_PROACTIVE_QUIET_HOURS`. Phase D (agent-initiated turn) is
  scoped in `docs/design/proactive-surfacing.md`.

- **Local Whisper.cpp STT** via the new `WhisperCppSttProvider`. Set
  `MUSE_VOICE_STT=whisper-cpp` to route `/api/voice/stt` (and the
  CLI `muse listen` path, once it picks up the runtime registry)
  through the local `whisper-cpp` binary instead of OpenAI Whisper.
  Tune the binary / model paths with `MUSE_WHISPER_CPP_PATH`
  (default `whisper-cpp` via `$PATH`) and `MUSE_WHISPER_CPP_MODEL`
  (default `~/.muse/whisper-models/ggml-base.en.bin` — operators
  bring their own model). See `docs/design/voice-mode.md` for the
  full Phase F contract.

- **Reminder firing — agent-synthesized text (Phase D mirror)**.
  When `MUSE_REMINDER_AGENT_TURN=true` AND an `AgentRuntime` is
  wired AND the user touched `/api/chat*` within
  `MUSE_REMINDER_ACTIVE_SESSION_WINDOW_MS` (default 300_000 = 5
  min), the firing loop spawns a one-shot agent run with a
  JARVIS-style synthesis prompt and uses the LLM reply as the
  delivered message instead of the raw `reminder.text`.
  - Falls back to the flat reminder text on missing wires, stale
    window, empty reply, or synthesis error (failure logs to
    `summary.errors` but the reminder still fires so the user
    never misses a beat).
  - The activity tracker is **shared** with the proactive daemon:
    a single `onRequest` hook on `/api/chat*` unlocks both daemons
    in lockstep. `MUSE_PROACTIVE_PRESENCE_FILE` still drives the
    file-backed variant for multi-process setups.
  - History records the *delivered* text (synthesized or flat) so
    `muse.reminders.history` reflects what the user actually saw.

- **`muse proactive test` / `muse proactive scan`** — operator tools
  for verifying the proactive surfacing daemon without waiting for
  a real imminent event.
  - `muse proactive test [--text <message>]` sends a one-line
    notice through `MUSE_PROACTIVE_PROVIDER` / `MUSE_PROACTIVE_DESTINATION`
    so the operator can confirm the messaging channel works
    end-to-end. Exits 1 with a helpful message when either env is
    missing or the configured provider isn't registered.
  - `muse proactive scan [--lead-minutes N]` dry-runs the
    calendar + tasks scan against the same window the daemon
    would use and prints what would fire next tick. Doesn't push,
    doesn't touch the sidecar.

- **Web SetupPanel now surfaces voice STT/TTS backends, user-memory
  auto-extract, and proactive daemon state** — parity with the CLI
  `muse setup` output. The `voice` row reads
  `stt=openai-whisper, tts=openai-tts` (or whichever local
  combo is wired), the new `user memory` row reflects
  `MUSE_USER_MEMORY_AUTO_EXTRACT`, and the new `proactive` row
  shows the provider/destination/lead/tick + Phase D and
  quiet-hours flags when the daemon would activate.

- **Proactive surfacing audit log** — full stack mirror of
  `reminder-history`. The proactive daemon now appends every
  delivery attempt (success or failure) to
  `~/.muse/proactive-history.json` (override via
  `MUSE_PROACTIVE_HISTORY_FILE`) with the resolved item id, title,
  startsAt/dueAt, provider/destination, the *delivered* text
  (flat or Phase D agent-synthesized), the firedAt, status, and
  error context. The history surface is exposed through four
  symmetric channels:
  - **MCP loopback**: new `muse.proactive.history` tool (mirror
    of `muse.reminders.history`) — the agent can answer "did the
    3pm meeting notice land?" without an extra tool call.
  - **REST**: `GET /api/proactive/history?limit=N` returns the
    newest-first audit log. Auth-gated when an auth service is
    wired.
  - **CLI**: `muse proactive history [--limit N] [--json]` — a
    quick terminal-side audit without needing the API server.
  - **Library**: `appendProactiveHistory` / `readProactiveHistory`
    in `@muse/mcp` for callers that want the same shape directly.

- **Setup status now surfaces the reminder firing daemon**. New
  `reminder` section in the snapshot mirrors the `proactive`
  section: `{ enabled, providerId?, destination?, tickMs,
  agentTurn, quietHours?, nextStep? }`. Both the CLI text
  renderer and the web SetupPanel print a `reminder firing` row
  alongside the existing `proactive` row, including the
  `agent-turn=true` flag when `MUSE_REMINDER_AGENT_TURN=true`.

- **`muse setup status` now surfaces the recent env knobs**. The
  setup-status snapshot (used by both `muse setup` CLI text /
  `--json` and `GET /api/setup/status`) gained three sections /
  fields so operators can verify their toggles without grepping
  env:
  - `voice.sttBackend` and `voice.ttsBackend` resolve the
    effective backend (`openai-whisper` / `whisper-cpp` for STT,
    `openai-tts` / `piper` for TTS) given the configured env. The
    CLI line reads `[ok] voice — stt=openai-whisper, tts=openai-tts`
    (or your local-only combo) instead of the previous "OpenAI
    key present" string.
  - New `userMemory` section: `{ status, autoExtract, model? }`.
    Reflects the `MUSE_USER_MEMORY_AUTO_EXTRACT` flag (default
    `true`) and the resolved extraction model.
  - New `proactive` section:
    `{ status, enabled, providerId?, destination?, leadMinutes,
    tickMs, agentTurn, quietHours?, sidecarFile, nextStep? }`.
    The `enabled` boolean reflects whether
    `MUSE_PROACTIVE_PROVIDER` + `MUSE_PROACTIVE_DESTINATION` are
    set (the server-side daemon also needs a calendar or tasks
    signal, which the snapshot doesn't enumerate). Phase D
    `agentTurn` exposes whether `MUSE_PROACTIVE_AGENT_TURN=true`.

- **`LiveVoiceProvider` abstraction** for duplex (audio-in /
  audio+text-out) providers like Gemini Live and OpenAI Realtime
  (Voice Phase F.3). Ships the interface
  (`LiveVoiceSession.sendAudio` / `endTurn` / `events()` /
  `close()`) and a `FakeLiveVoiceProvider` for tests / dry runs.

- **Gemini Live wire-format helpers** —
  `buildGeminiLiveSetupFrame`, `buildGeminiLiveAudioFrame`,
  `buildGeminiLiveEndTurnFrame`, `parseGeminiLiveServerFrame`.
  These compose into a future `GeminiLiveProvider` (which would
  implement `LiveVoiceProvider`) without locking the websocket
  transport details. Parser surfaces text-delta / audio-delta
  / turn-complete events; malformed JSON resolves to an error
  event so a single consumer loop handles both happy and sad
  paths.

- **`AudioFrameWakeWordDetector` interface** + a
  `FakeAudioFrameWakeWordDetector` test seam. Extends the
  Phase F.1 wake-word scaffolding so a future
  `OnnxWakeWordDetector` (openWakeWord / Porcupine) can plug in
  alongside the existing text-scan detector without changing the
  CLI loop's shape. The audio-frame variant consumes 80 ms
  PCM16 frames at 16 kHz and exposes `feedFrame()` +
  `reset()`.

- **Wake-word ambient mode** for `muse listen` (Voice Phase F.1
  first cut). New `--wake "hey muse"` flag turns the CLI into a
  continuous-listen daemon: short rolling clips (default 5s,
  override via `--clip-seconds`) are transcribed through the
  configured STT provider, scanned for the wake phrase, and on a
  hit Muse either uses the residual text after the phrase as the
  prompt (same clip) or captures another clip to get one. Ctrl-C
  stops the loop. Implemented against a new `WakeWordDetector`
  abstraction in `@muse/voice` so a future
  `OnnxWakeWordDetector` (openWakeWord / Porcupine) drops in
  without touching the CLI. This Phase F.1 cut uses the
  text-scan path; the openWakeWord ONNX adapter is future work.

- **Local Piper TTS** via the new `PiperTtsProvider`. Set
  `MUSE_VOICE_TTS=piper` AND `MUSE_PIPER_VOICE=/path/to/voice.onnx`
  to route `/api/voice/tts` through the local `piper` binary
  instead of OpenAI TTS. Override the binary path with
  `MUSE_PIPER_PATH` (default `piper` via `$PATH`). Piper produces
  WAV only (the existing `format: wav` request stays valid; mp3 /
  opus etc. requests are rejected with `UNSUPPORTED_FORMAT` so
  callers transcode downstream if needed). Voice files come from
  https://github.com/rhasspy/piper/blob/master/VOICES.md. Phase
  F.3's Gemini Live duplex stream remains future work.

### Changed

- **`MUSE_USER_MEMORY_AUTO_EXTRACT` default flips from `false` to
  `true`**. JARVIS-class memory ("the assistant that remembers")
  is central to Muse's identity, so the per-turn structured-output
  LLM call that persists newly stated facts / preferences into the
  `UserMemoryStore` is now on by default. The extractor runs
  fail-open with a 10-second wall-clock cap and bounded
  input slices (2 KB / 2 KB user / assistant). Set
  `MUSE_USER_MEMORY_AUTO_EXTRACT=false` to skip the extra call
  (offline runs, cheap-model budgets, disabled-memory test rigs).

### Added

- **Native server-side `web_search`** is now default-on across OpenAI /
  Anthropic / Gemini. The agent surfaces normalized `citations[]` on every
  response. Set `MUSE_WEB_SEARCH=off` (env) or `webSearch.enabled=false`
  (runtime-settings) to disable.

  - **Breaking**: the OpenAI adapter migrated from Chat Completions to
    the Responses API (`/v1/responses`). The OpenAI-compatible path
    (`/v1/chat/completions`) used by Ollama / OpenRouter / LM Studio is
    unchanged.
  - **Gemini limitation**: Gemini's `generateContent` API rejects
    requests that mix the built-in `googleSearch` tool with function
    declarations. When Muse auto-registers ambient tools (notes / tasks
    / calendar / messaging / reminders / mcp loopback), function tools
    win and grounding is skipped. To use grounding on Gemini, issue
    requests with no function tools (e.g. set `MUSE_TOOLS_ENABLED=false`
    or pass an empty tool registry).
  - CLI: `muse chat ... --no-web-search` opts out per request.
  - API: `POST /api/chat` accepts `metadata.tools.web_search: false`;
    response body includes `citations[]`; stream emits
    `event: tool_call` (`phase: started|finished`) and
    `event: citations` SSE events.
  - Web UI: assistant messages render citation chips; setup panel has a
    `webSearch.enabled` toggle.

- **Six new OpenAI-compatible provider presets** — Groq, DeepSeek,
  Together, Mistral, Moonshot, Cerebras. Just export the matching key
  (`GROQ_API_KEY`, `DEEPSEEK_API_KEY`, `CEREBRAS_API_KEY`, …) and
  `muse` auto-selects a sensible default model. The interactive
  `muse setup model` wizard now offers all 11 providers (legacy 5 +
  new 6) and the JSON / CLI setup status surfaces each preset.
- **Bare-prefix model spec inference** — `MUSE_MODEL=mistral-small-latest`
  (no `provider/` prefix) now resolves to the Mistral provider via the
  `knownModelPrefixes()` map instead of falling through to undefined.
  Same fix applies to `moonshot-`, `codestral-`, `pixtral-`, etc.

- **Fixes to the streaming + multi-turn paths shipped alongside
  `web_search`**: Anthropic / Gemini `provider.stream()` now synthesise
  `tool-call-started` / `tool-call-finished` / `citations` `ModelEvent`s
  the same way the OpenAI Responses SSE parser does (was: silently
  dropped on those two providers). OpenAI Responses request `input[]`
  items now always use `content[].type: "input_text"` (was: `output_text`
  for assistant turns, which is the response-side shape).

- **`webSearch` policy line in `muse setup`** — the human-readable setup
  output now reports `enabled / maxUses / source` so operators can
  verify a `MUSE_WEB_SEARCH=off` override is being honored without
  hitting an endpoint.

- **Admin API now mirrored in the CLI** — ten previously web-only
  observability / admin surfaces now have thin CLI wrappers:
  `muse runs list/show`, `muse doctor`, `muse cost {daily,top,for}`,
  `muse latency {summary,timeseries}`, `muse traces {list,spans}`,
  `muse settings {list,get,set,unset,refresh}`,
  `muse tools {stats,accuracy,calls,ranking}`,
  `muse analytics {failures,latency-distribution}`,
  `muse debug {replay,replay-show}`, plus `muse scheduler {delete,executions}`.
  Operators can now triage from the terminal without curl or the web UI.

- **`muse calendar events --local`** and **`muse calendar providers
  --local`** complete the `--local` trio. The CLI instantiates
  `LocalCalendarProvider` against `~/.muse/calendar.json` directly.
  OAuth (Google) and CalDAV stay API-only. `muse today --local`
  now also surfaces local-file events instead of skipping calendar.
- **`muse today --brief [--model <id>]`** — JARVIS-style natural
  language summary. Composes the structured briefing, feeds it
  to the configured model with a short system prompt, prints 2-3
  sentences leading with the most time-sensitive item. Works in
  both remote and `--local` mode.
- **`muse setup` (no args)** — configuration health-check across
  model key, MCP entries, calendar credentials, notes/tasks state,
  voice key. Pure read-only inspection, no API needed.
- **`muse today --brief --speak [--audio-voice <name>] [--audio-format <type>]`** —
  pipes the JARVIS brief through the configured TTS provider and
  plays through afplay/aplay. Falls back to a friendly stderr hint
  when no voice provider is configured. Shared playback helper
  (`voice-playback.ts`) ready for any future "speak this" surface.
- **`muse.reminders.{add, due, clear}` MCP loopback** — agent
  surface for the reminder store. The LLM can now schedule its
  own reminders ("내일 6시에 우유 사라고 알려줘" → `add` with
  parsed dueAt), check what the user should see right now (`due`
  status filter for overdue+now-or-earlier pending), and remove
  one by id (`clear`). Always-on at `~/.muse/reminders.json`
  (catalog total: 11 → 12); the file self-creates on first write.
- **`muse remind` — passive personal reminders + `muse today` integration**.
  `muse remind <when> <text...>` adds an entry to
  `~/.muse/reminders.json` (or `MUSE_REMINDERS_FILE`). `<when>`
  accepts the same grammar as task `--due` (ISO-8601 or relative
  phrase, e.g. "tomorrow at 6pm"). `muse today` (both API and
  CLI `--local`) now surfaces overdue + within-lookahead pending
  reminders so the morning briefing is your reminder check-in.
  Active firing through messaging (`muse remind --send-now`) is a
  follow-up — this iter is read-only at fire time. Companion REST
  surface: `GET/POST/DELETE /api/reminders` with `?status=pending|fired|all|due`.
- **`muse setup messaging` interactive wizard** — `@clack/prompts`
  multiselect of Telegram / Discord / Slack / LINE, masked password
  prompt per token, persists to `~/.muse/messaging.json`
  (chmod 600 via `FileMessagingCredentialStore`). Existing tokens
  shown masked with a replace-or-keep confirm. KakaoTalk skipped
  on purpose. `buildMessagingRegistry(env)` now reads both env
  tokens and the credentials file (env wins on conflict), so
  setup-once-then-use works without re-exporting on every shell.
  `muse setup` status surfaces per-provider source ("telegram
  (file)", "discord (env)") for instant diagnosis.
- **`muse.messaging.{providers, send}` MCP loopback tool** — Phase 3
  of the messenger plan. Once any provider env token is set, the
  agent runtime auto-registers a loopback MCP server so the LLM can
  itself send Telegram / Discord / Slack / LINE messages
  ("remind me on Telegram when the deploy finishes"). Send is
  marked `risk: "write"` for the policy layer; structured errors
  (`PROVIDER_NOT_FOUND`, validation, upstream failures) come back
  as `{ error, providerErrorCode, upstreamStatus? }`. Catalog entry
  is opt-in (requires one of the four env tokens).
- **`@muse/messaging` package + `muse messaging {providers, send}` CLI**
  — Phase 1 (outbound) of the Telegram / Discord / Slack / LINE
  integration. Provider-neutral contract mirrors `@muse/calendar`
  (`MessagingProvider` / `MessagingProviderRegistry` /
  `FileMessagingCredentialStore`); each platform is a thin REST
  wrapper around its sendMessage equivalent. Opt-in via env tokens
  (`MUSE_TELEGRAM_BOT_TOKEN` / `MUSE_DISCORD_BOT_TOKEN` /
  `MUSE_SLACK_BOT_TOKEN` / `MUSE_LINE_CHANNEL_ACCESS_TOKEN`).
  KakaoTalk skipped on purpose — Kakao restricts general bots to
  verified business channels. Phase 2 (inbound: polling /
  Socket Mode / webhook) tracked in `docs/design/messaging.md`.

### Removed

- `muse memory --user <id>` flag — Muse is single-user, the CLI
  hard-codes `me`. Multi-tenant residue from the Reactor migration.

### Fixed

- **CLI displayed task/reminder times in UTC** — `muse tasks list`,
  `muse remind list`, `muse today`, and `muse brief` all rendered
  stored UTC ISO instants by slicing the string ("2026-05-14 06:00")
  with no timezone conversion. A user in KST who typed
  `--due "tomorrow at 3pm"` saw `06:00` back, forcing a mental
  UTC→local conversion on every glance. Times now render in the
  host's local timezone via a shared `formatLocalDateTime` helper
  (Intl.DateTimeFormat with `en-CA` to preserve ISO digit ordering),
  so "tomorrow at 3pm" round-trips as `15:00`. The three previously
  duplicated `shortDateTime` helpers collapse to one export.
- **Gemini parallel-tool 400** — when the model issued N parallel
  tool calls (e.g. `muse.tasks.list` + `muse.calendar.list` +
  `muse.notes.list` for "what's on my plate today?"), the wire
  request emitted N separate `role:"function"` messages. Gemini
  requires one `role:"function"` turn with N functionResponse
  parts and 400'd with "the number of function response parts is
  equal to the number of function call parts of the function call
  turn". `toGeminiRequest` now coalesces consecutive tool messages
  into a single turn. Live dogfood: `muse chat "What's on my plate
  today? Check tasks, calendar events, and recent notes."` now
  succeeds where it previously failed 100%.
- **`today` recent-notes ignored subdirectories** — Obsidian-style
  vaults (`dogfood/2026-05-10.md`) never surfaced. The walker is
  now recursive (depth cap 8).
- **Raw stack traces from CLI when API is down** — `apiRequest` now
  translates `ECONNREFUSED` / `ENOTFOUND` to a one-line hint and
  the entrypoint catches uncaught failures so users see
  `muse: <message>` exit 1 instead of an undici stack.

### Changed

- **CLI personal-domain commands print human-readable output by
  default**; pass `--json` to opt back into the raw API response
  for scripting. Affected: `tasks list/add/complete/delete/providers`,
  `notes list/read/search/save/append/providers`, `calendar
  events/providers`, `memory show/set`. `today` already worked this
  way and was the model for the rest. `notes read` now prints the
  file content directly (no more JSON envelope) so the obvious
  pipe `muse notes read foo.md | less` works without `jq`.

### Added

- **`--local` mode for `muse tasks`, `muse notes`, `muse today`** —
  the CLI no longer requires a running API server for personal
  data. `--local` reads/writes `~/.muse/tasks.json` and
  `~/.muse/notes/` directly via the same engine the API uses
  (`@muse/mcp` shared store + `createNotesMcpServer` in-process),
  so on-disk state stays byte-identical between modes. Calendar
  is still served through the API in this iter — its registry
  needs OAuth/CalDAV boot. Three new CLI vitest cases cover
  tasks/notes/today round-trips with `fetch` rigged to throw
  (proves no API hop). Dogfood: `node muse tasks list --local`
  works with the API server stopped.
- **`muse tasks add --due <when>`** — CLI surface caught up to the
  MCP tool. Accepts ISO-8601 or relative phrases ("tomorrow at
  6pm", "in 3 hours", "next Monday"); `POST /api/tasks` parses
  both via the same resolver re-exported from `@muse/mcp`.

### Refactored

- Personal task on-disk shape, atomic writes, status filter, and
  dueAt parsing moved to `@muse/mcp/personal-tasks-store`. The MCP
  loopback tool, the Fastify REST routes, and the CLI's `--local`
  mode now share one implementation; previously the API duplicated
  parsing inline.

### Added

- **`muse listen` CLI** — Voice Phase C from `docs/design/voice-mode.md`.
  Push-to-talk loop: press Enter to start recording, again to stop;
  CLI captures via `sox` (`rec -r 16000 -c 1 -t wav -`), transcribes
  through the configured `SpeechToTextProvider`, sends transcript to
  `/api/chat`, synthesizes the reply via `TextToSpeechProvider`,
  plays through `afplay` (macOS) / `aplay` (Linux). Flags:
  `--lang ko|en` (STT hint), `--voice <name>` (TTS voice id),
  `--format mp3|wav|opus|aac|flac`. Sox / player shells injected via
  `ListenShells` so tests run without audio hardware. Missing sox
  exits 1 with `brew install sox` / `apt install sox` hint; missing
  voice providers (no `OPENAI_API_KEY` / `MUSE_VOICE_OPENAI_API_KEY`)
  exits 1 with the env-var hint. Phase F (wake-word ambient mode +
  local Whisper.cpp / Piper) stays deferred until real
  latency/cost data justifies.
- `muse.tasks.add` (`dueAt`) and `muse.calendar.add`
  (`startsAtIso` / `endsAtIso`) accept relative-time phrases
  in addition to ISO-8601: `tomorrow`, `tomorrow at 6pm`,
  `today at 14:30`, `in 3 hours`, `in 2 days`, `next Monday`,
  `next Monday at 9am`, plus `noon` / `midnight` time suffixes.
  Resolved server-side against the local clock — no more relying
  on the LLM to chain `time_now` + `time_add` correctly.

### Added (round 190)

- **`muse.tasks.add` accepts `dueAt`**. Real bug surfaced via
  dogfood: when a user said "Add a task: 우유 사기 — due
  tomorrow", the LLM responded with "I cannot set a due date" and
  asked to proceed without one — the tool's input schema only
  accepted `title` / `notes` / `tags`. Adds optional
  `dueAt: string` (ISO-8601) to the schema; invalid timestamps are
  rejected with `dueAt must be a valid ISO-8601 timestamp`. The
  field round-trips through the on-disk JSON
  (`PersistedTask.dueAt`) and surfaces in `list` / `search` /
  `complete` responses. Back-compat: legacy entries without
  `dueAt` still parse (the type guard's new branch only rejects
  when `dueAt` is present and non-string). 3 new vitest cases
  (mcp 118 → 121): valid ISO timestamp round-trips through add →
  list → search; invalid timestamp errors with a clear message;
  legacy pre-`dueAt` entry still loads. **Live dogfood verified**:
  real Gemini call with the same Korean prompt that failed before
  ("Add a task: 우유 사기 due 2026-05-15T18:00:00Z") now invokes
  `muse.tasks.add` with both fields, the task persists with
  `dueAt: "2026-05-15T18:00:00.000Z"`, and `GET /api/tasks` shows
  it. Caveat: `dueAt` is currently a free-form ISO timestamp the
  LLM emits; natural-language relative dates ("tomorrow", "next
  Monday") still need the LLM to compose `time_now` + `time_add`
  / `next_weekday` first. The tool composition works (round 179
  shipped those time tools) but the prompt-engineering nudge
  isn't there yet — future iter.

### Added (round 189)

- **`muse mcp config-add` CLI** — flag-driven (non-interactive,
  scriptable) entry adder for `~/.muse/mcp.json`. Round 175's
  `config-show` and round 182's `config-doctor` covered inspection;
  this command closes the editing loop without hand-editing the
  JSON. Supports stdio entries (`--command` / `--arg` repeatable
  / `--cwd` / `--env KEY=VALUE` repeatable) and remote entries
  (`--url` / `--transport streamable|sse` / `--header KEY=VALUE`
  repeatable), plus `--description`, `--disabled`, and `--dry-run`
  (prints merged JSON without writing). Auto-infers transport
  from which flag is set; explicit `--transport` always wins.
  Atomic writes via `mkdirSync(recursive: true)` then
  `writeFileSync` of the merged shape. Duplicate names are
  rejected with a non-zero exit and a clear message. 5 new vitest
  cases (cli 40 → 45): stdio entry round-trips through disk;
  streamable URL with multiple headers; `--dry-run` preserves the
  existing file; duplicate name rejected; missing `--command` and
  `--url` rejected with `must specify either` error. Live dogfood
  verified: created a fresh tmp config, added stdio + streamable
  entries, `config-show` printed both correctly, `config-doctor`
  reported `OK` for both, duplicate-name attempt errored as
  expected. Caveat: the `@clack/prompts` interactive flow (round
  175 design note) is still deferred — flag-driven shipped first
  because it's testable and CI-scriptable.

### Changed

- **`packages/tools/src/muse-tools.ts` decomposition continues**.
  606 → 233 LOC. Three-round combined reduction: 1193 → 233
  (-80%). New `muse-tools-data.ts` (377 LOC) holds the
  data/encoding builders (`createMathEvalTool`, `createHashTextTool`,
  `createCsvParseTool`, `createBase64Tool`) plus their private
  helpers (`evaluateArithmetic`, `parseCsvRecords`, `padBase64`)
  and constants (`MATH_EXPRESSION`, `HASH_TEXT_ALGORITHMS`,
  `CSV_PARSE_*`, `BASE64_MAX_TEXT_LENGTH`). `muse-tools.ts` now
  carries only `createJsonQueryTool` + `createUrlPartsTool` +
  `createRegexExtractTool` plus the `createMuseTools` factory
  composition; same 17-tool public surface, byte-identical
  output ordering. Behavior-preserving — smoke:live's
  `time_now`-using plan-execute test still passes through real
  Gemini and the math tool's evaluator round-trips unchanged.

### Removed

- **All Reactor-migration artifacts**. Muse is now a fresh
  personal-JARVIS project, no longer framed as a port of an
  existing system. Deleted `docs/migration-plan.md` (1623-line
  iteration log), `docs/audits/reactor-*` audits,
  `docs/superpowers/plans/2026-05-06-reactor-migration-*` plans,
  `.claude/rules/migration-loop.md`, `.claude/rules/redaction.md`
  (Reactor-redaction rules), `.claude/commands/migrate-iteration.md`,
  `.claude/commands/audit-parity.md`, `.claude/agents/parity-auditor.md`,
  `scripts/verify-reactor-{db,route}-parity.mjs`, the
  `verify:reactor-{db,routes}` package.json scripts, and
  `packages/db/test/reactor-db-parity-script.test.ts`. CLAUDE.md
  drops the "Don't migrate Reactor's Spring module boundaries"
  rule + all migration-plan / migration-loop / redaction pointers;
  AGENTS.md, README.md, README.ko.md, CONTRIBUTING.md, and the
  remaining `.claude/rules/*.md` files lose their Reactor-leaning
  language. The CLI's `muse spec --json` description is now
  "Print the fixed runtime stack" (was "...migration stack"). New
  rule `.claude/rules/iteration-loop.md` reframes the
  per-iteration discipline as continuous personal-JARVIS
  development.

### Added

- **Open-source baseline files**: `LICENSE` (MIT), `CODE_OF_CONDUCT.md`
  (Contributor Covenant 2.1), `CONTRIBUTING.md`, `SECURITY.md`. Root
  `package.json` carries `license` / `homepage` / `repository` / `bugs`
  fields.
- **Korean auto-extract prompt** for the user-memory hook.
  `pickAutoExtractSystemPrompt(userPrompt)` switches to a Korean system
  prompt when the user message is ≥30% Hangul; English remains the
  conservative default. JSON keys stay snake_case ASCII; values stay in
  the user's native language.
- **CE step 1.e — LLM-summarized fan-in**.
  `OrchestrationRunOptions.summarizeWorkerOutput?: (workerId, output) =>
  Promise<string>` replaces each worker's verbose output with an LLM-
  generated summary before the parent concat. Composes with
  `maxOutputCharsPerWorker`. `/api/multi-agent/orchestrate` accepts a
  `summarize: boolean` body flag; the route builds a Gemini-style
  summarizer from the configured `ModelProvider` (256-token cap, 15s
  timeout, fail-open to raw output).
- **`muse mcp config-doctor` CLI** — per-entry validation that doesn't
  bail on the first malformed entry. Prints
  `<name>\t<STATUS>\t<transport>\t<findings>` per row, exits 1 when any
  entry has `error` status. Soft findings include URL validity for
  streamable/sse transports.
- **`muse mcp config-path` / `config-show`** — file-based ergonomics
  surface for `~/.muse/mcp.json`, no API server required.
- **Voice mode design doc** in `docs/design/voice-mode.md`.
  Phases A/B/D/E shipped (provider interfaces, OpenAI Whisper STT +
  TTS adapters, `/api/voice/*` routes, `<VoicePanel>` Web component).
  Phase C contract written for the next iter to pick up.
- **`~/.muse/mcp.json` Claude-Desktop-style external MCP config loader**.
  Supports stdio (`command`/`args`) and streamable/sse (`url`/`headers`).
  Disabled entries (`disabled: true`) silently skipped; missing file is
  not an error. The boot script seeds entries into the runtime store
  before listening.
- **MCP `roots` capability**. Muse's MCP client now advertises the
  capability and serves a `roots/list` handler. Configurable via
  `MUSE_MCP_CLIENT_ROOTS` (csv of absolute paths).
- **`GET /api/health` alias** under the `/api/*` prefix.
- **Notion tasks adapter**. `NotionTasksProvider` mirrors the round 128
  Notion notes adapter against `api.notion.com/v1` for the tasks domain.
  Opt-in via `MUSE_NOTION_TASKS_*` env vars.
- **Context Engineering primitives** (rounds 157-170):
  working-budget compaction trigger, persona snapshot injection,
  tool-output context-aware trimming, typed user-memory slots
  (preferences / schedule / vetoes / goals), `ContextReferenceStore`
  with `muse.context.fetch` / `muse.context.list` MCP server,
  deterministic per-worker output cap on the multi-agent fan-in.

### Changed

- **Default model auto-detection**. `/api/chat` no longer requires
  `MUSE_MODEL` to be set explicitly — the provider is inferred from
  the available API key (`GEMINI_API_KEY` / `OPENAI_API_KEY` /
  `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY`). Boot-time warning on
  missing-credentials.
- **ESLint flat config + `typescript-eslint/recommended`** wired
  across the monorepo. All 11 rules at `error`; `pnpm lint` blocks
  on any violation.
- **`packages/tools/src/muse-tools.ts` decomposition**. 1193 → 606 LOC.
  Time/datetime tools moved to `muse-tools-time.ts` (357 LOC),
  text-formatting tools moved to `muse-tools-text.ts` (253 LOC),
  shared parsers in `muse-tools-helpers.ts` (27 LOC). Public
  `createMuseTools()` surface byte-identical.

### Fixed

- `/api/health` 404 when accessed under the `/api/*` prefix.
- Multi-agent fan-in could blow the parent context on N parallel
  verbose workers — now bounded by `maxOutputCharsPerWorker`.
- Stale lint warnings (80 → 0) across the monorepo, mostly dead
  barrel-re-export imports.
