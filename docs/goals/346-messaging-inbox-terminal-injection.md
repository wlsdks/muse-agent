# 346 — `muse messaging inbox` printed attacker-controlled text raw to the terminal

## Why

Diversified off the relative-time grammar into safety. The
codebase has an established posture (stated verbatim in the
goal-089 `parseOsascriptGlance` comment): untrusted external
text that is "printed straight to the terminal — strip
ESC/C0/C1/DEL ... the same boundary treatment the feeds /
inbox / search surfaces apply." The agent-context inbox
(`inbox-context.ts:128`) does apply
`stripUntrustedTerminalChars`. But the **CLI display** path was
missed:

`apps/cli/src/commands-messaging.ts` `inbox` rendered
```ts
return `  ${time}  ${sender}: ${entry.text}`;
```
where `entry.text` / `entry.sender` / `entry.source` are
**attacker-controlled** — anyone who can message the bot
(Telegram / Slack / Discord) sets them — and were interpolated
**raw** into `io.stdout`. A sender whose message body contains
ANSI escapes (`ESC[2J` clear-screen, `ESC]0;…BEL` set
terminal-title, OSC-8 hyperlink spoofing, cursor / false-output
injection) **hijacks the user's terminal** the moment they run
`muse messaging inbox`. A JARVIS that reads your Telegram into
your terminal must not let a sender control that terminal. The
file imported nothing from `@muse/shared` — no sanitisation at
all on this boundary.

## Scope

`apps/cli/src/commands-messaging.ts`:

- New exported pure `formatInboxLine(entry)` — applies the
  established `stripUntrustedTerminalChars(v).replace(/\s+/gu,
  " ").trim()` treatment (identical to `inbox-context.ts`) to
  `text`, `sender`, and `source` before composing the
  human-readable line. Exported as a pure helper so the
  security boundary is directly unit-testable (the goal-089
  `parseOsascriptGlance` pattern), and the `inbox` action is now
  just `inbound.map(formatInboxLine)`.
- The `--json` path is untouched: it goes through
  `helpers.writeOutput` (JSON.stringify escapes control bytes to
  `\u00xx` — they never reach the terminal as active escapes),
  so the fix is correctly scoped to the human-readable listing.

Behaviour-preserving for clean messages (whitespace-collapse +
trim only — same as every other inbox surface); only
control/ESC bytes and multi-line sprawl change.

## Verify

- New `apps/cli/src/commands-messaging.test.ts` (the command
  had **no test**): 4 cases. A message body with
  `ESC[2J ESC]0;… BEL …` → the formatted line has **no** C0/
  C1/DEL byte (code-point predicate, ESC/BEL built via
  `String.fromCharCode` — goal-227 safe) and the visible words
  survive; multi-line body collapses to one line; an
  ESC-prefixed `source` with no sender → control byte gone
  (attack neutralised) while the inert leftover param text is
  harmlessly retained — a wrong first assertion here was
  corrected to the *true* security contract
  (`stripUntrustedTerminalChars` removes the ESC, not the now-
  inert `[31m`); clean text is byte-identical (no regression).
- `pnpm --filter @muse/cli test` — 585 pass (+4; new file).
  `pnpm check` — every workspace green (apps/cli 589 incl. the
  test/ glob, apps/api 161, all packages). `pnpm lint` —
  exit 0. The goal-227 enforcement test (328) stays green; the
  new test file self-scans clean.
- No real-LLM request/response path touched (deterministic
  terminal-output sanitisation). The deterministic suite —
  including the explicit no-control-byte assertion — is the
  rigorous verification.

## Status

done — `muse messaging inbox` now strips ESC/C0/C1/DEL from
attacker-controlled inbound `text` / `sender` / `source` before
printing, closing a terminal-injection hole so a Telegram /
Slack / Discord sender can no longer hijack the user's terminal.
The untrusted-text-to-terminal boundary treatment is now
consistent between the agent-context inbox and the CLI inbox
listing.
