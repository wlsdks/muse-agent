# 740 — fix: a typo'd MUSE_RESPONSE_LOCALES no longer silently disables locale-gated response filters

## Why

`responseLocales` (packages/autoconfigure/src/response-filters.ts)
turns `MUSE_RESPONSE_LOCALES` into the set of active response locales
that gates which casual-lure-strip and greeting-strip filters run, and
picks the redaction-replacement default:

```ts
const raw = parseCsv(env.MUSE_RESPONSE_LOCALES) ?? ["ko", "en"];
// → filter to {ko, en}
```

`parseCsv` only returns `undefined` (→ default both) when the value is
absent/blank. A value that is SET but contains no recognized locale —
a typo like `english`, or an unsupported `fr,de` — parses to a
non-empty array whose entries all get filtered out, yielding an
**empty set**. Consequences, all silent:

- `buildCasualLureFilters` / `buildGreetingStripFilters` both gate on
  `locales.has("ko")` / `locales.has("en")` → with an empty set they
  add NOTHING, so a config typo turns those quality/safety filters
  fully off.
- the sanitized-text redaction default checks
  `has("en") && !has("ko")` → with an empty set it flips to the Korean
  `(보안 처리됨)` replacement regardless of the user's actual language.

A typo in a locale list should never quietly disable filters.

## Slice

`responseLocales`: when the resolved set is empty (no recognized
locale), fall back to the default `{ko, en}` — i.e. treat "no
recognizable locale" exactly like "unset". Exported for direct testing.

## Verify

- `@muse/autoconfigure` response-filters.test.ts (new): default both
  when unset; single explicit locale honored; case/whitespace tolerant;
  unrecognized entries dropped while valid ones survive (`fr,ko,de` →
  `{ko}`); and the fix — `english` / `fr,de` / whitespace-only all fall
  back to `{ko, en}`. **Mutation-proven** — removing the empty-set
  fallback fails the typo case.
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0 (standalone). Deterministic
  config logic — no model path, no `smoke:live`.

## Decisions

- **Fall back to both, not to a single locale** — "unset" already means
  both, and an unrecognized value is closest to "the user didn't
  express a valid preference," so it should behave identically.
- **No legitimate use case is broken** — disabling filters is done via
  the per-filter `*_ENABLED` flags, never by setting the locale list to
  a non-locale; so falling back on all-invalid can't override a
  deliberate intent.
