# macOS control — design

Goal, in the owner's words: Muse should control macOS **more smoothly and more
perfectly than a human, safely**. Everything Apple sanctions is in scope.

This document is grounded in measurements taken on the owner's machine, not in
citations. Where a number appears, it was measured here.

## Measured baseline (2026-07-20, this machine)

| path | measured | side effect |
|---|---|---|
| `osascript -e 'return 1'` | 38 ms | — |
| 10 statements in ONE `osascript` spawn | 54 ms total (5.4 ms/stmt) | — |
| System Events query, warm | ~160 ms | — |
| plain CLI (`pmset`) | 31 ms | — |
| **Contacts count via AppleScript** | **3,273 ms** | **launches Contacts.app** |
| **same via Contacts.framework (Swift)** | **131–175 ms** | none |
| Reminders read via AppleScript (cold) | 4,395 ms | **launches Reminders.app** |
| AX read: 13 apps, 18 windows, titles + positions | **190 ms, 681 bytes (~170 tokens)** | none |
| `screencapture` full screen | 165 ms, **1.9 MB** | none |

Three conclusions fall straight out of the table:

1. **Native framework beats AppleScript by ~19x** for the same data, and does
   not drag a GUI app onto the user's screen.
2. **Batching is ~7x** — per-call cost is process spawn, not script complexity.
3. **AX window state is ~2,800x cheaper than a screenshot** (681 B vs 1.9 MB)
   for answering "what is on screen right now".

## Policy (owner decisions, 2026-07-20)

Everything Apple sanctions is allowed, with one carve-out:

- **Allowed**: `osascript`/JXA, Shortcuts CLI, native Apple frameworks
  (EventKit, Contacts, ScreenCaptureKit, AppKit), **and AX READS** — window
  lists, positions, sizes, app state.
- **Excluded**: **AX INPUT** — synthesising clicks and keystrokes.

The split is deliberate and is not the same call the repo made before. Prior
art overwhelmingly uses AX (`mac-use-mcp`, `computer-use-mcp`, `MacOS-MCP`,
`automac-mcp` are all AX-based), so "excluded" was never the industry norm —
it was a fragility judgement. That judgement holds for INPUT and not for READS:

- A read has nothing to undo. A synthesised click has no undo at all.
- Reads survive a moved window; coordinate-based clicks go stale.
- Reads are the only route to apps that ship no scripting dictionary — Apple
  removed `.sdef` from 32 of its own apps as of Ventura, and that number only
  grows.
- The known TCC-cache staleness bug (`AXIsProcessTrusted()` caching a stale
  answer after a signature re-validation) degrades a read into an error, which
  is recoverable. The same bug during an input sequence leaves a half-finished
  action.

**Correction, from Apple's own text (checked against the SDK headers, not a
blog).** An earlier draft of this design implied AX reads carry a lighter
permission cost than AX control. They do not. `AXUIElement.h`'s overview says
assistive applications use these functions "to communicate with **and control**"
other apps, and `kAXErrorAPIDisabled` is defined for the API as a whole — Apple
documents ONE trust gate, with no read-only tier. `AXIsProcessTrustedWithOptions`
is the only documented check.

So the read/input split is Muse's own risk policy, not an Apple permission
boundary. It still holds — a read has no side effect to undo — but it must be
stated honestly: enabling AX reads asks the user for the SAME Accessibility
permission that would allow control, and the restraint is ours to enforce in
code. The user-facing consent copy must say that, not imply macOS is enforcing
a narrower grant.

## What Apple actually documents (and what it does not)

Checked against Apple's own man pages, headers, and developer.apple.com — not
third-party writeups. This matters because several widely-repeated claims turn
out to be undocumented, and a design must not lean on them.

**DOCUMENTED — safe to rely on:**

- **`osascript` argv.** `man osascript`: *"Any arguments following the script
  will be passed as a **list of strings** to the direct parameter of the 'run'
  handler"*, and *"to pass arguments to a STDIN-read script, you must
  explicitly specify `-` for the script name."* This is exactly the mechanism
  used below, in exactly the documented form.
- **`quoted form of`** (TN2065) — Apple's documented shell-quoting idiom. Note
  Apple frames it as a shell *parsing* fix; the word "injection" never appears.
- **EventKit auth is a moving target.** `requestAccess(to:completion:)` is
  **deprecated** as of macOS 14; `requestFullAccessToEvents` /
  `requestFullAccessToReminders` are current, and `EKAuthorizationStatus`
  replaced `.authorized` with `.fullAccess`/`.writeOnly`. The helper must use
  the current API. `CNContactStore.requestAccess` is NOT deprecated.
- **`NSAppleEventsUsageDescription`** and the
  `com.apple.security.automation.apple-events` entitlement, including that no
  entitlement is needed for same-team-ID targets.
- **`AXIsProcessTrustedWithOptions`** with `kAXTrustedCheckOptionPrompt`.
- **`shortcuts run`** with `-i`/`-o` and `-` for stdin/stdout; exits 0/1.

**NOT DOCUMENTED — do not assert these as Apple guidance:**

- Apple nowhere recommends argv over interpolation *as a security practice*.
  Its only documented mitigation is `quoted form of`. Our argv rule is a
  stronger choice we are making, and should be described that way.
- `responsibility_spawnattrs_setdisclaim` — no Apple documentation at all.
  Every source is third-party. A TCC-attribution design that depends on it is
  building on a private symbol; treat as a nice-to-have, not a foundation.
- The numeric value/string for `-1743`. The `errAEEventNotPermitted` symbol
  page exists but Apple's value and discussion fields are empty. Our
  `isPermissionError` already hedges by matching both the code and wording —
  keep that hedge.
- No AX read/write permission tiering (see the correction above).
- `osascript` argv limits — no documented count, length, or encoding limits.
  Measured here instead: unicode (Hangul, emoji), embedded quotes and
  backslashes, empty strings, and a 5,000-char argument all round-trip
  byte-identical.
- `shortcuts run` has no documented timeout, size limit, or per-failure exit
  code. A shortcut that asks for input **blocks** the CLI — so any shortcut
  Muse invokes must be input-complete, and the call needs our own timeout.

## The four problems to fix

### P1 — Injection: stop building AppleScript from strings

14 sites interpolate model-derived strings into AppleScript via
`escapeAppleScript()` (`macos-exec.ts:41`). The escape itself is not obviously
broken — a break-out payload was executed against it and produced no side
effect — but escaping is the wrong shape of defence. A tool of exactly this
class (`browser-tools-mcp`, an MCP server building AppleScript from untrusted
input) shipped a CVSS 9.8 command injection through the same pattern.

`osascript` takes a real argv. Verified here: a fixed script with
`on run argv`, handed a hostile `x" & (do shell script "touch …") & "` as an
argument, returned the payload as inert data with no side effect. The script
text never contains the value, so there is nothing to escape.

**Rule**: AppleScript source is a fixed, checked-in template. Every
model-derived value arrives through `run argv`. `escapeAppleScript` stays only
for genuinely static composition, and gets a comment saying so.

### P2 — Latency and GUI intrusion: a native helper

`mac_app_read`'s Contacts / Mail / Reminders / Calendar / Notes branches drive
AppleScript at the GUI app. Five of the ten `tell application` sites have no
`is running` guard, so a background read **launches the app onto the user's
screen** and costs 3–4.4 s. `macos-media-tool.ts` already solves this correctly
(`if it is running then … else return "not running"`); the pattern was simply
not applied consistently.

Two fixes, in order:

- **Immediate**: add the `is running` guard to the five unguarded sites. Small,
  and it stops the worst user-visible symptom today.
- **Structural**: a bundled Swift helper (`muse-mac-helper`) for EventKit,
  Contacts, and ScreenCaptureKit. Measured 19x faster and it never touches a
  GUI app. A probe binary built here was 55 KB.

The helper also fixes TCC attribution: today an Automation prompt is charged to
whatever launched the CLI (Terminal in dev, Muse.app when bundled), so a user
grants the same permission repeatedly. A codesigned helper spawned through a
`disclaim` shim owns its own TCC identity — grant Contacts once, to
`muse-mac-helper`, forever.

`osascript` and `shortcuts run` remain the long-tail path. This is additive.

### P3 — Data fragmentation: Apple apps are the single source of truth

"What are my reminders?" currently has **two answers**: `muse.reminders` reads
`~/.muse/reminders.json` (30 entries today) and `mac_app_read(reminders)` reads
Reminders.app. The mirror is one-way Muse→Apple. Which answer the user gets
depends on which tool the model happened to pick — a correctness bug wearing a
tool-selection costume.

**Decision (owner)**: Apple's apps are the source of truth for reminders,
calendar, notes, contacts. `muse.reminders` is re-pointed at EventKit through
the helper; `~/.muse/reminders.json` is migrated once and retired. The user's
data then lives where they already look at it, and syncs to their phone and
watch for free.

### P4 — Tool surface: 12 mac tools against a 5–7 guidance

`tool-calling.md` caps the exposed set at ~5–7 for a local model. The mac family
alone is 12; with browser + email + home a fully-armed session shows ~28.
Two concretely confusable pairs exist: `mac_screenshot` vs `mac_screen_read`
share the keywords `screen`/`화면`, and the multiplexed `mac_app_read` (16 enum
values) / `mac_system_set` (15) move the failure from wrong-tool to wrong-enum
without removing it.

**Direction**: consolidate by INTENT, not by mechanism, and let the mode/context
filter decide what is exposed per turn. A first cut:

- `mac_observe` — one read tool over AX + native state (windows, apps, focus,
  battery, network, now-playing, clipboard). Accepts a LIST, answered in one
  call. This is where the 170-token AX snapshot lands.
- `mac_control` — reversible local actions (open app, media, volume, say,
  screenshot).
- `mac_configure` — system settings that need a confirm (Focus, wifi,
  bluetooth, sleep, dark mode).
- `mac_shortcut_run` — unchanged; the Shortcuts keystone, and the receiving end
  of App Intents, which is the surface Apple is actually growing.
- outbound (`mac_message_send`) stays separate and gated, per
  `outbound-safety.md`.

### P5 — Undo: snapshot before every mutation

macOS provides no undo for `defaults write`, EventKit deletes, or clipboard
overwrite. Apple Mail's Undo Send is the model worth copying: hold the action
for a few seconds with a visible cancel, then commit.

- files: `NSFileManager.trashItem` (Finder "Put Back"), never `unlink`
- settings: read and store the prior value — including "was unset" — first
- EventKit: capture the full record before delete so it can be recreated
- clipboard: snapshot the previous contents before overwriting
- irreversible/outbound: staged hold-then-commit

Every mutation already lands in the hash-chained action log; the snapshot goes
with it, so "what did it just do to my machine, and can I undo it?" has an
answer.

## Build order

Each step is independently shippable and green on its own.

1. **`is running` guards** on the five unguarded reads. Smallest change, kills
   the 4-second GUI-app-launch symptom today.
2. **argv migration** of the 14 interpolation sites. Structural injection fix,
   verifiable by grepping for AppleScript string concatenation.
3. **`muse-mac-helper`** (Swift, codesigned, disclaim-shimmed): EventKit +
   Contacts first — they are the measured 19x wins and the P3 unblock.
4. **`mac_observe`** over AX + helper state, list-valued. Collapses the
   multi-step "tell me about my Mac" flow into one call.
5. **Reminders/calendar/notes migration** to Apple as source of truth.
6. **Snapshot-before-mutate + staged commit** across the mutating tools.
7. **Tool consolidation** to the four-tool surface.

## Acceptance

Beyond the usual gates, this work is only delivered with:

- **Injection**: a test that feeds each argv-migrated tool a break-out payload
  and asserts no side effect — the exact probe used to validate the mechanism.
- **No GUI intrusion**: a test asserting a background read of a dormant app
  does not launch it (assert the process is still absent afterwards).
- **Latency**: the helper path measured against the AppleScript path, with the
  numbers recorded — a claim of "faster" without a measurement is not accepted.
- **Undo**: for each mutating tool, a test that performs the mutation, invokes
  the recorded undo, and asserts the prior state is restored.
- **Selection**: `pnpm eval:tools` after every tool-surface change, since
  renaming or merging tools is exactly what breaks one-shot selection on a
  local model.
- **AX degradation**: a test that AX-unavailable (permission denied) degrades to
  a clear, actionable message rather than a hang or a silent empty result.
