# 605 — `buildAgentCard` now dedupes persona names so a merged-from-multiple-sources spec list can't emit the same `persona:X` twice

## Why

`packages/agent-specs/src/index.ts:buildAgentCard` builds the A2A
`AgentCard` for the running Muse instance. Tools are deduped by
name with a `seenTools.has(...)` early-continue (line 304-315) — a
config that lists the same tool twice surfaces it once in the
discovered capabilities, with "first occurrence wins."

The persona loop right below it (line 316-327) carried no such
guard:

```ts
const personas: AgentCapability[] = [];
for (const spec of options.specs ?? []) {
  if (!spec) continue;
  personas.push({
    description: spec.description?.length ? spec.description : spec.name,
    inputSchema: null,
    kind: "persona",
    name: `persona:${spec.name}`
  });
}
```

Callers that merge specs from multiple sources (DB rows + a config
file + a runtime override — exactly the shape a multi-source
personal-assistant deployment grows into) can hand the builder two
specs sharing a name. Pre-fix the card emitted
`persona:calendar` twice; the discovered AgentCard then advertised
the same capability under two indices, confusing any A2A consumer
that maps capability-name → handler.

Step-8 redirect: not finite-guard (595/596), not 0o600 (598/599),
not boolean-spelling (585/587/597), not timeout (600), not regex-
coverage (601), not Invalid-Date (602), not CLI empty-id (603),
not memory-cap (604). Defect class is "two parallel loops where
one dedupes and the other doesn't" — fresh.

## Slice

- `packages/agent-specs/src/index.ts:buildAgentCard`:
  - Added a `seenPersonas = new Set<string>()` mirror of the
    tools loop's `seenTools` map. The persona name is computed
    once into a local `name` variable and skipped if already
    seen; otherwise added to the set and pushed. Same "first
    occurrence wins" semantic as the tools path — a duplicate's
    description / inputSchema is dropped, not merged.
- `packages/agent-specs/test/agent-specs.test.ts`:
  - One new test in the `buildAgentCard (A2A)` describe.
    Passes two specs both named `calendar` with different
    descriptions. Asserts exactly one persona capability in the
    output AND that the description came from the first spec.
    Pre-fix the assertion `expect(personas).toHaveLength(1)`
    fails — the loop produced 2 entries.

## Verify

- `@muse/agent-specs` suite green (15 passed, +1 vs baseline 14,
  0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): removing the
  `seenPersonas` set + the early-continue check makes the new
  test fail with `expected length 1 received length 2` — the
  exact pre-fix symptom. Fix restored, suite back to 15/15.
- `pnpm check` EXIT=0 (apps/api 258 passed, apps/cli 1041
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean (no zero-width / control
  chars in either touched file); `git status` shows only the
  two intended files plus this goal doc.
- No LLM request-response wire path touched; `smoke:live` does
  not apply. AgentCard discovery isn't HTTP-exercised by
  `smoke:broad` either.

## Status

Done. The A2A `AgentCard` builder's dedup behavior is now
consistent across both capability families:

| Capability path  | Before                                         | After                                |
| ---------------- | ---------------------------------------------- | ------------------------------------ |
| `tool`           | deduped by name (first occurrence wins)        | unchanged                            |
| `persona`        | **NOT deduped** — duplicates surfaced twice    | deduped (first occurrence wins)      |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness /
contract-consistency `fix:` on the A2A card builder, recorded
honestly with this backlog row — not a false metric.

## Decisions

- **First occurrence wins**, not "last write wins" or "merge."
  Matches the tools-side semantic exactly. A future maintainer
  scanning the two loops side-by-side will see they behave the
  same way, which makes the contract memorable. The alternative
  (last-write-wins) would let a downstream config silently
  override an upstream one, which is the opposite of the tools'
  "priority list = order" contract documented at line 297-299.
- **Dedup key is `persona:${spec.name}`, not just `spec.name`.**
  The set is already namespaced by the persona prefix, so even
  if a future capability type collides on the bare name (e.g. a
  hypothetical `prompt:calendar`) the persona set wouldn't
  spuriously block it.
- **Empty-name spec is not specially handled.** The pre-fix loop
  would push `persona:` (empty suffix) for a spec with `name: ""`.
  The new loop keeps that behavior — first occurrence wins, even
  if the name is empty. Validating `spec.name` is the registry's
  job, not the card builder's, and there are no tests pinning
  empty-name handling either way. Out of scope for this iter.
- **Mutation choice.** Reverted exactly the two lines that gate
  the duplicate (the `if (seenPersonas.has(name)) continue;` + the
  `seenPersonas.add(name)`). The mutation reproduces the exact
  pre-fix shape — that's the realistic regression a maintainer
  might introduce while "simplifying the loop back to a one-liner."
- **Test fixture reuses the existing test's spec shape**
  (including the `priority: 0` field already present in the
  sibling tests at lines 305-307). Avoids touching an unrelated
  type and keeps the fixture style consistent across the suite.

## Remaining risks

- **Name normalization** — `getByName` (line 91) and the dedup
  key both treat names as raw, case-sensitive strings. Two
  specs `Calendar` and `calendar` are distinct here. Whether
  that's a feature (case-sensitive identifiers) or a latent bug
  is unsettled; the InMemoryAgentSpecRegistry's `save` path
  doesn't lowercase either. Out of scope — separate iteration.
- **`evictOverflow` ordering** (line 135-147 of index.ts) sorts
  by `updatedAt.getTime()` without a tiebreaker. Two specs
  saved in the same millisecond have unstable eviction order.
  Same defect class as 593/594 (in-memory list ordering parity);
  Step-8 would push that to a separate iter.
- **`scoreAgentSpec` substring matching** (line 213) matches
  keyword needles as substrings — a keyword "cal" matches "calendar"
  AND "calculate" AND "biological." Likely intentional but worth a
  documentation note; out of scope here.
