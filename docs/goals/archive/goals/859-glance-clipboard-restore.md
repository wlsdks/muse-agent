## 859 — fix: `muse glance` no longer destroys the user's clipboard

## Why

`muse glance` captures the selected text by issuing a synthetic Cmd+C
(`keystroke "c" using {command down}`) and then reading `the clipboard`.
That **overwrites whatever the user had copied** — on EVERY run. For a
daily-driver ambient-glance, silently nuking the clipboard (a URL, a
password, a snippet the user was about to paste) is a real, repeated
data-loss bug.

## Slice — snapshot + restore the clipboard around the copy

`apps/cli` commands-glance.ts `OSASCRIPT_SOURCE`:
- Before the Cmd+C, snapshot the current clipboard text into
  `savedClipboard` (guarded by `try`, defaults to "missing value").
- After reading `selectedText`, restore: `if savedClipboard is not
  "missing value" then set the clipboard to savedClipboard`.
- The const is now exported so a contract test can pin the ordering.

Non-text clipboard content (an image / file) is an AppleScript
limitation and isn't preserved — but text, the overwhelmingly common
case, is no longer destroyed.

## Verify

`apps/cli` commands-glance.test.ts (+1, 10 total):
- a contract test asserts `OSASCRIPT_SOURCE` saves the clipboard
  (`set savedClipboard to (the clipboard as text)`) BEFORE the Cmd+C
  and restores it (`set the clipboard to savedClipboard`) AFTER —
  by index ordering, not just presence.
- **Mutation-proven**: removing the restore line fails the contract
  test (restore index −1 / not after the copy).
- `pnpm check` EXIT 0, `pnpm lint` 0/0.

## Decisions

- **Structural contract test, by design.** The clipboard side-effect is
  a macOS AppleScript runtime behaviour that can't be exercised in CI
  (no GUI clipboard, and it'd be flaky). Per testing.md ("snapshot-test
  prompt text and tool protocols when behavior matters"), the honest
  verification is to pin the generated AppleScript's save-before /
  restore-after structure and mutation-prove it — which this does. The
  fix itself is real; the check is structural.
- **Text-only restore.** A fully type-preserving clipboard save/restore
  in AppleScript is unreliable (images/RTF); the text path covers the
  common loss and degrades safely (`try`-guarded, "missing value"
  sentinel ⇒ no restore attempted) rather than erroring.
- No new dependency.
