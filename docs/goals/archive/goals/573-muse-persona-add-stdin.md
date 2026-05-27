# 573 — `muse persona add <id>` reads preamble from piped stdin when positional args are omitted

## Why

Step-8 redirect from the strict-parse cluster (570/571/572)
onto a fresh defect class — CLI ergonomics on `muse persona
add`. The goal-557 implementation requires the preamble to
be typed as variadic positional args:

```bash
muse persona add tony Sardonic, confident, Tony Stark.
```

That works for one-line preambles. For anything realistic —
a JARVIS preamble with multiple sentences, a paragraph,
embedded quotes, newlines — the shell-escaping is painful:

```bash
muse persona add tony "Speak like Tony Stark: sardonic, confident, but precise.
Reply in 1-3 sentences.
Address the user by name."
```

…with backslash-escaping for nested quotes, or a heredoc
fight. The `muse ask` command already solved this for
queries via piped stdin (`cat doc.md | muse ask "summarize"`
). Aligning `muse persona add` to the same idiom closes a
real UX friction:

```bash
cat tony-preamble.txt | muse persona add tony
echo "Be terse." | muse persona add brief
```

## Slice

- `apps/cli/src/commands-persona.ts` — changed the
  `<preamble...>` positional from required to optional
  (`[preamble...]`). The action now joins positional
  args first; if the result is empty after trim, falls
  back to `io.readPipedStdin ?? readPipedStdin` from
  `./program.js`. The same injection pattern goal-557
  added to test `io` is honoured (every test harness
  supplies a `readPipedStdin: async () => ""` stub via
  `captureOutput()`, so the existing assertions remain
  unaffected). Imported `readPipedStdin` directly from
  `./program.js`.
- `apps/cli/src/commands-persona.ts` — updated the
  "preamble must not be empty" stderr message to hint
  about the stdin escape valve:
  `(pass it as an argument or pipe via stdin: 'cat
  preamble.txt | muse persona add <id>')`.
- `apps/cli/test/program.test.ts` — extended the existing
  `muse persona add` test:
  - Pinned the new hint substring (`"pipe via stdin"`)
    in the empty-preamble error.
  - Added a stdin happy-path assertion: a 3-paragraph
    preamble with embedded newlines piped via a stubbed
    `readPipedStdin` round-trips through the store
    verbatim.

## Verify

- New assertions green within the existing
  `muse persona add` test; full `@muse/cli` suite green
  (1027 passed, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): removing the
  `if (preamble.length === 0) { piped = ... }` fallback
  block makes the stdin happy-path assertion fail —
  `Added custom persona long-jarvis` doesn't appear in
  the output and the store has no `long-jarvis` entry.
  Fix restored, suite back to all green.
- `pnpm check` EXIT=0, every workspace green (apps/api 249
  passed, apps/cli 1027 passed); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean; `git status` shows
  only the three intended files.
- Pure CLI input parser — no LLM request-response wire
  path; `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended path is `muse
  persona add` user input, not the model loop.

## Status

Done. The persona create surface now accepts long
preambles via piped stdin, matching the `muse ask` idiom.
A future grep for CLI commands that take a `<...>`
variadic positional but lack stdin fallback could surface
more candidates; deferred to keep scope tight.

No CAPABILITIES line / no OUTWARD-TARGETS flip: a CLI
ergonomics improvement on the existing P0 persona
write-surface, recorded honestly with this backlog row —
not a false metric.

## Decisions

- Positional args take precedence over stdin. Reason:
  matches the `muse ask` idiom byte-for-byte (which uses
  "args + stdin → instruction first, content after"; but
  for persona add the preamble IS the content so combining
  them would just munge the persona). Pick-one is the
  simplest correct behaviour.
- Variadic positional changed from `<preamble...>`
  (required) to `[preamble...]` (optional). Commander
  accepts both shapes; the optional form lets
  `muse persona add tony` succeed when stdin has content
  and the action's manual emptiness check carries the
  "still empty after stdin" failure path. Same pattern
  goal-557 set for the existing positional check.
- The error message hint mentions the EXACT stdin idiom
  (`cat preamble.txt | muse persona add <id>`) rather
  than a generic "use stdin". Concrete examples make
  the escape valve discoverable; abstract hints don't.
- Did NOT add a `--stdin` flag. Reason: the auto-detect
  ("positional empty → try stdin") is simpler and matches
  `muse ask` (which has no `--stdin` flag either). A
  redundant `--stdin` flag would just be ceremony.
- Did NOT extend the same pattern to `muse persona use`
  / `muse persona remove`. Those take an `<id>` argument
  (typically short, no shell-escape pain). Stdin is for
  long-prose preambles; the persona create surface is
  the only place it makes sense.
- The 3-paragraph fixture in the new test asserts that
  embedded newlines round-trip — pre-fix users who tried
  the positional path would have lost newlines (shell
  joining args with spaces). Stdin preserves the file
  bytes verbatim.
- Step-8 sub-defect-class check: CLI ergonomics (stdin
  fallback on a create-surface) is distinct from the
  recent strict-parse cluster (570/571/572), case-
  insensitivity (568/569), envelope-parity (565/566),
  did-you-mean (567), error-UX (564). Fresh defect-class
  slot.
