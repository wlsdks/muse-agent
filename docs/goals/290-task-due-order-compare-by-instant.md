# 290 — "what's due soonest" ordered tasks by raw ISO string, not instant

## Why

`compareTasksByDueDate` (`@muse/mcp`) is the canonical task
ordering — goals 255/256 made `muse today` and the
`muse.tasks.list` MCP tool sort with it, on the premise that for a
personal JARVIS "what's due soonest?" is the only question that
matters. It ordered the both-have-`dueAt` case with:

```ts
if (leftDue !== rightDue) return leftDue.localeCompare(rightDue);
```

`PersistedTask.dueAt` is a free-form `string?`. The REST route
normalises via `parseTaskDueAt` → canonical `…Z`, but **not every
write path does**: a hand-edited `~/.muse/tasks.json`, an `import`,
or the MCP add tool can store any ISO form. Lexicographic ISO
order is wrong across:

- **mixed precision** — `"…09:00:00.500Z"` (a *later* instant)
  sorts **before** `"…09:00:00Z"` (`'.'` 0x2E < `'Z'` 0x5A);
- **timezone offset** — `"…18:00:00+09:00"` (= `09:00Z`, an
  *earlier* instant) sorts **after** `"…10:00:00Z"`.

So `muse today` would surface the **wrong task as most urgent** —
a silent-wrong on the flagship triage surface. This is the exact
raw-string-ISO antipattern goal 281 fixed in the inbox-injection
cursor; `compareTasksByDueDate` is its untreated sibling on a
higher-traffic path.

## Scope

`packages/mcp/src/personal-tasks-store.ts` —
`compareTasksByDueDate`:

- Compare `Date.parse` instants when both `dueAt` are present and
  parseable (earliest instant first); equal instants fall through
  to the existing createdAt-desc tiebreaker. An unparseable value
  retains the prior `localeCompare` deterministic order (no new
  "sink" behaviour for malformed data). One short WHY comment
  records the free-form-string / mixed-format rationale.

Every other branch is byte-for-byte unchanged: only-one-`dueAt`
(±1), no-`dueAt` sink, and the `createdAt` tiebreaker (which
compares store-generated canonical `toISOString()` values, so
`localeCompare` there is correct and untouched).

## Verify

- `pnpm --filter @muse/mcp test` — 344 pass (was 343; +1). New
  regression: mixed `…09:00:00.500Z` vs `…09:00:00Z` and a
  `+09:00` offset that is the earliest instant but string-sorts
  last → ordered by true instant, with the two equal-instant
  entries breaking to createdAt-desc. The existing
  most-imminent-first / undated-sink / dueAt-tie tests stay green
  (all canonical `…Z`, so instant order == the prior
  lexicographic result — behaviour-preserving).
- `pnpm check` — every workspace green (mcp 344, apps/cli 561,
  apps/api 160, all packages). `pnpm lint` — exit 0.
- No real-LLM request/response path touched (pure deterministic
  comparator). A live Qwen run cannot reproduce a
  mixed-precision / offset `dueAt` ordering on demand, so the
  deterministic regression is the rigorous verification — same
  stance as its direct sibling goal 281 and 261 / 274–289.

## Status

done — task triage ("what's due soonest", `muse today`,
`muse.tasks.list`) now orders by the real due *instant*, so a
mixed-precision or timezone-offset `dueAt` from an import or a
hand-edited store can no longer surface the wrong task as most
urgent. Canonical-ISO ordering is unchanged.
