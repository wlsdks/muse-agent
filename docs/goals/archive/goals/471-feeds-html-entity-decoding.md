# 471 — `muse feeds` decodes HTML entities in RSS/Atom titles instead of showing them literally

## Why

`parseFeedBody` (`apps/cli` `feeds-store.ts`) is the ingest for
the `muse feeds` ambient-awareness surface (goal 092). Its
`XMLParser` was configured with only
`ignoreAttributes/attributeNamePrefix/trimValues` — no
`htmlEntities`. fast-xml-parser then decodes the 5 predefined XML
entities (`&amp;` `&lt;` …) but **leaves HTML named and numeric
entities literal**. A direct probe of the live parser config
confirmed (not assumed):

```
<title>Apple&#8217;s plan &amp; Google&rsquo;s reply &mdash; news&hellip;</title>
→ "Apple&#8217;s plan & Google&rsquo;s reply &mdash; news&hellip;"
```

So real-world feeds — whose titles routinely carry `&rsquo;`
(smart quote), `&#8217;`, `&mdash;`, `&hellip;`, `&amp;` — render
**literally** in `muse feeds today` and persist that way in
`~/.muse/feeds.json`. This is a concrete, extremely-reachable
user-facing UX degradation in an existing feature (essentially
every mainstream RSS/Atom feed uses these in headlines), distinct
from the recent run of numeric-parse-hardening siblings.

`feeds-store.ts`'s parser/merge logic had no assertion expecting
the *old* literal-entity output, so the fix introduces no wrong
premise; the genuine entity-decoding behaviour was untested.

## Slice

- `apps/cli/src/feeds-store.ts` — add `htmlEntities: true` to the
  feed `XMLParser`. A probe confirmed it decodes the common
  real-world set (`&#8217;`/`&rsquo;`→’, `&mdash;`→—,
  `&hellip;`→…, `&amp;`→&) **single-pass** (`&amp;amp;` →
  `&amp;`, not `&`, so no double-decode hazard) and the existing
  XML-predefined-entity behaviour is unchanged. The post-parse
  `sanitizeFeedText` boundary (`stripUntrustedTerminalChars` +
  whitespace collapse) still runs on the *decoded* string, so a
  publisher cannot smuggle an ESC/NUL via `&#27;`/`&#0;` — the
  terminal-safety posture is preserved, not weakened.
- `apps/cli/src/feeds-store.test.ts` — extended (existing 8 tests
  untouched) with a `parseFeedBody — HTML-entity decoding`
  describe: RSS title named+numeric decode, Atom title +
  `&amp;`-escaped link-query decode, and a defence-in-depth case
  proving `Safe&#27;&#0;Title` → `SafeTitle` (the decoded
  control chars are still stripped).

## Verify

- New 3 tests green; the 8 pre-existing `parseFeedBody` tests
  still green (no wrong premise — the only prior entity
  assertion, `&amp;`→`&`, is unchanged); full `@muse/cli` suite
  green (762, 0 failed); tsc strict (cli) EXIT=0.
- **Clean-mutation-proven** (Edit-based): removing
  `htmlEntities: true` makes the two decode tests fail with the
  precise pre-fix symptom (`expected 'Apple&#8217;s plan &
  Google&rsquo;s reply &mdash; news&hellip;' to be 'Apple’s plan
  & Google’s reply — news…'` — literal entities reaching the
  surface) while every other test stays green; fix restored,
  suite back to 11 green.
- `pnpm check` EXIT=0, every workspace green — no regression;
  `pnpm lint` 0/0; `pnpm guard:core` clean (no IMMUTABLE-CORE
  touched); byte-scan clean (the control-char defence-in-depth
  case is asserted via decoded-output equality, no raw control
  bytes in the test source); `git status` shows only the two
  intended files.
- Pure XML parsing — no LLM / model request-response wire path;
  `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9).

## Status

Done. `muse feeds today` and `~/.muse/feeds.json` now show
`Apple’s plan & Google’s reply — news…` instead of
`Apple&#8217;s plan & Google&rsquo;s reply &mdash; news&hellip;`,
so the ambient-awareness surface presents human-readable
headlines for the entities essentially every real feed uses. The
untrusted-text terminal-safety boundary is unchanged (decoded
control chars are still stripped post-parse).

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; an existing-feature UX `fix:`,
recorded honestly with this backlog row — not a false metric.

## Decisions

- `htmlEntities: true` (one parser option) rather than a
  hand-rolled post-parse entity decoder: the library already
  does it correctly and single-pass; a custom decoder would be
  re-derived surface and a double-decode/security risk the
  built-in avoids.
- Asserted the control-char defence via decoded-output equality
  (`toBe("SafeTitle")`) instead of `.not.toContain(<raw ESC>)`:
  keeps the test source free of raw control bytes (byte-scan
  clean) while still proving the boundary holds end-to-end.
- Did not also strip HTML *tags* from `<description>`: the 5 XML
  entities (incl. `&lt;`/`&gt;`) were already decoded before
  this change, so any tag exposure is pre-existing and out of
  this goal's tight scope — folding it in would be unrelated
  surface.
