# 342 — a non-finite recall knob silently emptied "recall across everything"

## Why

The non-finite-`??` sweep (336 `executionTimeoutMs`, 337
`maxRetryCount`, 338 proactive `leadMinutes`/window) has a clear
sibling in the flagship semantic-recall feature (goal 091).
`episodic-recall.ts` resolved every tuning knob as
`Math.max(<floor>, options.X ?? <default>)` — in **both**
`InMemoryEpisodicRecallProvider` and
`StoreBackedEpisodicRecallProvider` (10 sites + a `maxFetched`):

```ts
this.topK = Math.max(1, options.topK ?? 3);
this.minScore = Math.max(0, options.minScore ?? 0.15);
this.maxQueryChars = Math.max(64, options.maxQueryChars ?? 4_096);
this.recencyWeight = Math.max(0, options.recencyWeight ?? …);
this.recencyHalfLifeDays = Math.max(0.01, options.recencyHalfLifeDays ?? …);
this.maxFetched = Math.max(1, options.maxFetched ?? 200);
```

`??` only catches `null`/`undefined`, and **`Math.max(n, NaN)`
is `NaN`** (the exact goal-337 pattern). A non-finite knob
(env/config misconfig — `Number("")`) makes the field `NaN`,
and the consumers fail silently and variously:

- `scored.slice(0, this.topK)` with `topK = NaN` → `slice`
  coerces `NaN` → `0` → **`[]`**: recall returns **nothing**
  despite real matches — the catastrophic one (silent-dead
  flagship feature, class of 317/318/337/338).
- `baseSim < this.minScore` with NaN → always `false` → the
  score gate never filters (unranked noise).
- `computeRecencyBoost(…, NaN, NaN)` → `NaN` scores → garbage
  ordering.
- `query.length > this.maxQueryChars` with NaN → cap silently
  disabled.

## Scope

`packages/agent-core/src/episodic-recall.ts`:

- Add one module-private `finiteOr(value, fallback)` helper
  (`typeof === "number" && Number.isFinite ? value : fallback`)
  with a short WHY comment (the `Math.max(n, NaN)` → silent-dead
  rationale is non-derivable).
- Replace all 11 `options.X ?? default` knob resolutions
  (5 fields × 2 provider classes + `maxFetched`) with
  `finiteOr(options.X, default)`. The outer `Math.max(floor, …)`
  is kept, so behaviour is **identical** for every finite input
  (incl. 0 / negative — still clamped by the floor as before)
  and for `undefined`/`null`; only `NaN`/`±Infinity` now fall
  back to the default instead of poisoning the field. DRY:
  one helper, mechanical substitution.

## Verify

- `pnpm --filter @muse/agent-core test` — 540 pass (was 539;
  +1). New test: an `InMemoryEpisodicRecallProvider` built with
  `topK / minScore / maxQueryChars / recencyWeight /
  recencyHalfLifeDays` all `NaN` still returns the matching
  episode (`matches.length > 0`, correct `sessionId`) — pre-fix
  it returned `undefined` (silent-dead). Existing top-K /
  unrelated-query / user-scope / store-backed recall suites
  stay green (finite inputs unchanged).
- `pnpm check` — every workspace green (agent-core 540,
  apps/cli 581, apps/api 161, all packages). `pnpm lint` —
  exit 0. The goal-227 enforcement test (328) stays green.
- No real-LLM request/response path touched (deterministic
  knob resolution + token-overlap recall). The deterministic
  regression is the rigorous verification (a live run can't
  manufacture a misconfigured knob) — same stance as the
  non-finite sweep siblings.

## Status

done — episodic recall's tuning knobs now fall back to their
defaults on a non-finite value, so a misconfigured knob can no
longer `Math.max(n, NaN)`-poison `topK` into silently returning
zero recall results (or corrupt the score/recency math). The
non-finite-`??` class is now closed across the scheduler
(336/337), proactive loop (338), and episodic recall (342).
