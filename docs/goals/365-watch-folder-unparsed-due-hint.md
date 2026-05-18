# 365 — watch-folder --as-task silently swallowed an unparseable due: hint

## Why

The `muse watch-folder --as-task` path turns any file dropped in the
watched inbox into a tracked task, parsing a `due:` / `마감:` /
`deadline:` line into the task's `dueAt` (goal 364 covered the
`extractDueHint` keyword parser). The dueAt-resolution glue that sits
between `extractDueHint` and `parseTaskDueAt` had a real
trust/correctness wart on this JARVIS ambient-ingestion path:

```ts
const hint = extractDueHint(raw);
let dueAt: string | undefined;
if (hint) {
  const parsed = parseTaskDueAt(hint, () => new Date());
  if (parsed instanceof Error) {
    dueAt = undefined;          // <-- hint found but UNPARSEABLE, silently dropped
  } else { dueAt = parsed; }
}
if (!dueAt) {
  dueAt = new Date(Date.now() + defaultLead * 60_000).toISOString();
}
```

A user who drops a file containing `due: next freday` (typo) gets a
task **silently** due in `+defaultLead` minutes (default +60m), with
no log line indicating the due hint was found but not understood. The
user believes Muse scheduled the task for "next friday"; it is in
fact due in an hour. Empirically confirmed: `parseTaskDueAt` returns
an `Error` for `"next freday"` / `"tomorrw 9am"` / `"gibberish xyz"`,
so this silent-degrade branch fires on any typo'd hint. For a
proactive agent, silently mis-scheduling an ambient-ingested task
with zero feedback is a correctness/trust gap, not a cosmetic one.

The glue also lived inside the `fs.watch` action closure, so the
resolution logic was **not directly unit-testable**.

## Scope

`apps/cli/src/commands-watch-folder.ts`:

- New pure, exported `resolveInboxDueAt(raw, defaultLeadMinutes, now)
  → { dueAt: string; unparsedHint?: string }`. `unparsedHint` is set
  only when a due-line was present but `parseTaskDueAt` rejected it.
  `now` is injected (action passes `() => new Date()`), so the
  fallback instant is deterministic and testable. dueAt outcomes are
  **byte-identical** to the old inline logic (parsed → parsed value;
  typo → `now + lead`; no hint → `now + lead`); the only behaviour
  change is additive.
- The `--as-task` action now calls the helper and, when
  `unparsedHint` is set, emits
  `  due hint "<hint>" not understood — using default +<lead>m` to
  stderr before creating the task — so a typo'd due no longer
  degrades silently.

New tests in `apps/cli/src/commands-watch-folder.test.ts`
(`resolveInboxDueAt` describe, 3 cases): understood hint (English +
Korean `마감`) → parsed dueAt, no flag; typo'd / gibberish hint →
`now + lead` **plus** `unparsedHint`; absent hint → `now + lead`,
no flag (with a non-default lead to pin the arithmetic). Every
expected value was empirically verified against the built module
before asserting.

## Verify

- `pnpm --filter @muse/cli test` — 624 pass (+8 over the goal-364
  baseline: 5 `extractDueHint` + 3 `resolveInboxDueAt`).
- `pnpm check` — every workspace green (apps/cli 627 incl. the
  `test/` glob, apps/api 165, all packages).
- `pnpm lint` — exit 0.
- goal-227/328 byte scan clean on both touched files (the em-dash in
  the stderr string is normal printable text, used pervasively in
  this file's command descriptions; the goal-328 enforcement test
  stays green).
- No real-LLM request/response path touched — deterministic date /
  string resolution plus an stderr note. The deterministic suite,
  with pre-write empirical verification, is the rigorous
  verification.

## Status

done — a typo'd `due:` / `마감:` line in a watched-inbox file no
longer silently mis-schedules the ingested task to the default lead;
the watcher now warns, and the dueAt-resolution logic is a pure,
directly-tested helper instead of untestable closure glue.
