# Goal 889 — `muse memory show` splits veto/goal preferences into their own headings

## Outward change

`muse memory show` now renders `veto:`- and `goal:`-prefixed
preferences under distinct **Vetoes (never suggest)** and **Goals**
headings (prefix stripped), instead of lumping them into one raw
"Preferences" list. A user can now audit at a glance *what Muse will
refuse to suggest* and *what it steers toward* — the two
highest-stakes categories — rather than scanning a flat list of
`veto:coffee: …` / `goal:fitness: …` raw keys.

## Why this, now

`buildMusePersona` already splits preferences into Preferences /
Vetoes / Goals — the persona block tells the model to "respect
vetoes absolutely" and "steer toward goals". But `formatMemoryShow`
(the `muse memory show` renderer) dumped every preference under a
single heading with the raw `veto:`/`goal:` prefixes intact. So the
view the user inspects to audit their own memory disagreed with how
Muse actually consumes it — and the most important entries (the
absolute "never" list) were buried. A real correctness/UX seam
between two views of the same stored field; the smallest verifiable
fix on a fresh surface.

## How

`formatMemoryShow` normalises `record.preferences` (handles both the
`Record` and `{key,value}[]` shapes via the existing
`normalizeKeyValue`), buckets each entry by its `veto:` / `goal:`
prefix, strips the prefix, and emits three `appendKeyValueSection`
calls (Preferences / Vetoes / Goals). `appendKeyValueSection`
already skips an empty section, so the Vetoes/Goals headings appear
only when populated.

## Verification

`apps/cli` `human-formatters.test.ts`: a record with a plain pref +
a `veto:coffee` + a `goal:fitness` renders the three distinct
headings with prefixes stripped (`coffee: …`, `fitness: …`) and
asserts the raw `veto:coffee` / `goal:fitness` keys do NOT leak; a
record with only plain prefs emits no Vetoes/Goals headings.
Mutation-proven: reverting to the single lumped
`appendKeyValueSection(…, record.preferences)` fails the split case.
No LLM path → no smoke:live; Ollama down regardless. `pnpm check`
exit 0, `pnpm lint` 0/0.

## Decisions

- Mirrored `buildMusePersona`'s exact `veto:` / `goal:` prefix
  convention rather than inventing a new one — the whole point is
  audit parity between the show view and the persona the model sees.
