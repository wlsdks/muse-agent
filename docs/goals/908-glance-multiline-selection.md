# Goal 908 — `muse glance` keeps a multi-line selection whole (was truncating to the first line)

## Outward change

`muse glance` (frontmost app + window + selected text — Muse's ambient
screen awareness) now captures a multi-line text selection in full.
Before, selecting a paragraph and running `muse glance` returned only
the **first line** of the selection; every line after it was silently
discarded. So "what am I looking at / what did I just select" — the
whole point of the glance — gave a truncated answer for the most
common selection shape (more than one line).

## Why this, now

P20 ambient perception. The osascript returns
`app\nwindow\nselectedText`, and the selected text routinely spans
multiple lines (a copied paragraph, a code block, an address). The
parser split on every newline and read only `lines[2]`, dropping
`lines[3..n]`. App and window are single-line, so the bug was confined
to the selection — but the selection is the highest-value field for an
agent reasoning about the user's current context. A perception surface
that truncates its richest signal is a real daily-driver defect.

## How

One-line fix in the pure `parseOsascriptGlance`: `selected` is now
`norm(lines.slice(2).join("\n"))` — everything from the third line
onward — instead of `norm(lines[2])`. The existing `norm` already
collapses whitespace (incl. the rejoined newlines) to a single
terminal-safe line, so a multi-line selection is preserved as one
flattened line rather than truncated. App (`lines[0]`) and window
(`lines[1]`) are unchanged — neither contains embedded newlines.

## Verification

`apps/cli` `commands-glance.test.ts` (`npx vitest run --root apps/cli
commands-glance.test.ts`, 11 passing): new case — `Safari\nDocs\nfirst
line\nsecond line\nthird` → `selected: "first line second line third"`
(whole selection, whitespace-collapsed). All prior cases (single-line,
missing-value, CRLF/whitespace collapse, terminal-control stripping)
stay green. Mutation-proven: reverting to `norm(lines[2])` fails the
multi-line test; restored green. `pnpm lint` 0/0; apps/cli alone fully
green (147 files / 1624 tests) — the 2 failures under parallel
`pnpm check` are the known voice-playback `/tmp` race flake (passes in
isolation). Pure parser, no LLM path → no smoke:live (Ollama down
regardless).

## Decisions

- Joined the tail with `\n` and let `norm` flatten it, rather than
  preserving newlines in the `selected` field — `glance` output is
  printed straight to the terminal and fed to the model as one line,
  and the whitespace-collapse is the same untrusted-text boundary the
  window title already gets. Whole content, terminal-safe shape.
