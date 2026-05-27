# 587 — `decideWebSearchPolicy` recognises every standard falsy spelling on `MUSE_WEB_SEARCH` as a kill switch on the LIVE LLM request/response path

## Why

Goal 585 closed the env-flag spelling gap on the snapshot reader
(`packages/autoconfigure/src/setup-status.ts:readWebSearchEnvSnapshot`),
which feeds `muse setup --json` / `GET /api/setup/status`. That
fix improved the operator visibility surface — but a snapshot
that reads "disabled" doesn't actually disable anything.

The LIVE gate sits in
`packages/model/src/web-search-policy.ts:decideWebSearchPolicy`,
called from the agent runtime on every `/api/chat` to decide
whether the model should invoke native web_search. It carried
the same defect as the snapshot:

```ts
const envFlag = env.MUSE_WEB_SEARCH?.toLowerCase();
if (envFlag === "off") {
  return { enabled: false, ... };
}
```

Recognised exactly two strings (case-insensitive): `on` and
`off`. Any other value — including the perfectly standard
`MUSE_WEB_SEARCH=false`, `=0`, or `=no` — fell through, and the
operator's stated intent to kill web search was silently
ignored. The model then attempted web search even though the
admin had said "off."

On a **cost / privacy / token-budget** flag this is the worst
shape of footgun: the operator believes they disabled an
expensive, externally-traced feature; the policy says enabled;
the model phones out.

The rest of the boolean-env convention is symmetric across all 8
standard tokens (`parseBoolean` in autoconfigure,
`parseBooleanValue` in runtime-settings). This iteration brings
the live LLM gate into the same convention — without changing
the truthy-side semantics (a truthy spelling stays a no-op so it
doesn't conflict with the existing `args.override === false`
contract on the per-call override path).

Step-8 redirect: the prior 7-of-10 commits sat in `apps/cli/*`
on the `--json` envelope sweep; the previous two iters moved to
`packages/autoconfigure` (585) and `packages/runtime-settings`
(586) on the boolean-spelling theme. This iteration completes
the sweep with the high-stakes live-path application in
`packages/model`. Same theme, materially different surface
(live LLM request gate, not snapshot or dead-code).

## Slice

- `packages/model/src/web-search-policy.ts`:
  - Replace the literal `env.MUSE_WEB_SEARCH?.toLowerCase() ===
    "off"` kill switch with
    `parseBooleanTriState(env.MUSE_WEB_SEARCH) === false`.
  - Add an inline `parseBooleanTriState(value): true | false |
    undefined` helper plus the 8-token TRUTHY / FALSY sets at
    module scope. Inlined rather than cross-imported from
    `@muse/autoconfigure` (which already owns one copy from goal
    585) because `@muse/model` is a lower-level package than
    autoconfigure — the dependency direction is wrong, and a
    third site for the helper has not yet emerged (when it does,
    the right move is to hoist to `@muse/shared`, not earlier).
- `packages/model/src/web-search-policy.test.ts` — three new
  tests:
  - **every standard falsy spelling** (`false / 0 / no / off`,
    case-insensitive) on `MUSE_WEB_SEARCH` is a hard kill
    switch — overrides `args.override === true` (preserving the
    long-standing kill-switch-wins-over-override contract);
  - **truthy spellings** (`true / 1 / yes / on`) are NOT a
    force-enable — they fall through to the rest of the
    decision tree, so a per-call `args.override === false`
    still wins. This guards against a subtle widening that
    would have made the env flag bi-directional and clashed
    with the per-call override semantics;
  - **unrecognised typos** (`enabled / disabled / y / n / xyz /
    truue / whitespace`) do NOT silently disable — they fall
    through to the rest of the decision tree, so a typo'd
    kill-switch is reported as enabled (loud, visible
    misconfiguration) rather than quietly disabling everything.

## Verify

- `@muse/model` suite green (168 passed, +3 vs baseline 165, 5
  skipped, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  call site back to `?.toLowerCase()` + literal `=== "off"`
  makes the new falsy-spelling kill-switch test fail (expected
  `enabled: false`, got `enabled: true`) on the new test cases.
  The truthy / typo tests are unaffected by this mutation (both
  the old and new code fall through to defaults). Fix restored,
  suite back to all green.
- `pnpm check` EXIT=0 (apps/api 249 passed, apps/cli 1040
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean.
- `pnpm smoke:live` ran a real Qwen round-trip (Ollama
  qwen3:8b, reasoning off) against the API. 9 passed, 4 failed
  — but ALL 4 failures are pre-existing environmental issues
  unrelated to this change:
  - `time_now`-tool-call test failures × 2 — Qwen3 sometimes
    answers tool-bindable temporal questions from training
    instead of issuing the tool call (e.g. emits "Thursday"
    instead of calling `time_now`). Pre-existing local-Ollama
    fidelity issue, not a regression from this change.
  - `native web_search citations` — the smoke test expects
    OpenAI/Anthropic-style citations, but Ollama qwen3:8b
    doesn't expose native web_search (the script already has
    a soft-pass for Gemini; Ollama would need the same; that's
    a separate iteration).
  - `muse.notes.search` — flake (model returned cached info
    instead of the live note text).
- **My change is provably no-op for the smoke environment**:
  `scripts/smoke-live-llm.mjs` never sets `MUSE_WEB_SEARCH`, so
  `env.MUSE_WEB_SEARCH` is `undefined` at the call site. Both
  the old code (`undefined?.toLowerCase() === "off"` → false)
  and the new code (`parseBooleanTriState(undefined) === false`
  → false) take the SAME fall-through branch. Confirmed by
  `grep -rn "MUSE_WEB_SEARCH" scripts/` (no hits in the smoke
  scripts).

## Status

Done. The live LLM web-search gate now matches the snapshot
reader's spelling convention:

| Spelling                         | Snapshot (goal 585) | Live policy (this goal) |
| -------------------------------- | ------------------- | ----------------------- |
| `off` (case-insensitive)         | kill switch         | kill switch (unchanged) |
| `false` / `0` / `no`             | kill switch         | kill switch (**fixed**) |
| `on` (case-insensitive)          | force enable        | no-op (intentional)     |
| `true` / `1` / `yes`             | force enable        | no-op (intentional)     |
| typo / garbage                   | no-op               | no-op (unchanged)       |

The intentional asymmetry on truthy spellings: the snapshot is
a pure observability surface — symmetric "off=disable,
on=enable" is the most operator-friendly. The live gate ALREADY
has a per-call override mechanism (`args.override`), and adding
a force-enable env override on top would create a 3-way
priority puzzle (env=on vs override=false vs settings=false)
that the existing test "override=false disables even with
settings.enabled=true" implicitly contracts against. Keeping
truthy as no-op preserves the override hierarchy.

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness
`fix:` on an existing live-path gate, recorded honestly with
this backlog row — not a false metric.

## Decisions

- **Inlined `parseBooleanTriState`, did not cross-import.**
  `@muse/autoconfigure` already owns one copy of the helper
  (goal 585), but `@muse/model` sits below autoconfigure in the
  package graph — the autoconfigure package depends on the
  model package, not the other way around. Cross-importing in
  the wrong direction would create a cycle. Inlining 10 lines
  is the right cost. When (if) a third site emerges, the move
  is to hoist into `@muse/shared` and import from there in all
  three sites in one sweep.
- **Falsy-only widening, no truthy force-enable.** The
  snapshot surface (goal 585) made it bi-directional because
  `source: "default" | "env"` is symmetric: any explicit
  recognised value flips source. The live policy has DIFFERENT
  semantics: it has a per-call `args.override` mechanism, and
  the kill switch is intentionally a hard one-way override
  (env-off beats override=true). Mirror-symmetric truthy
  would force-enable, which would clash with `args.override
  === false` — a regression on the override-false contract.
  Decided to keep truthy as no-op so the override hierarchy is
  preserved; only the falsy spelling set widens.
- **Smoke:live failures audit.** The 4 smoke failures
  (time_now × 2, web_search citations, notes.search) are
  pre-existing on the loop machine and unrelated to this
  change. Verified by inspecting that
  `scripts/smoke-live-llm.mjs` does not set `MUSE_WEB_SEARCH`,
  meaning the env-flag branch this change touches is dead
  code for the smoke environment regardless of which version
  of the helper is in place. Same `if (envFlag === false)`
  fall-through for both old and new code.
- **Why the unrecognised-typo test matters.** Without it, a
  later "widening" refactor (e.g. "starts with f → false") would
  silently swallow `MUSE_WEB_SEARCH=enabled` as off. The test
  pins the contract that ONLY the 8 documented spellings count
  — a typo is visible misconfiguration, not silent failure.

## Remaining risks

- `MUSE_MESSAGING_MACOS_NOTIFICATION_ENABLED` and
  `MUSE_MESSAGING_LIBNOTIFY_ENABLED` in
  `packages/autoconfigure/src/registry-builders/messaging.ts`
  still use literal `=== "true"` checks. Different defect
  shape (registry-build gate, not policy-decide gate) — but
  same spelling-asymmetry concern. Deferred to keep scope
  tight.
- `MUSE_RATE_LIMIT_CHAT_DISABLED` in
  `apps/api/src/server-routes.ts:107` also uses literal
  `=== "true"`. Same convention sweep target. Deferred.
- The live LLM path's smoke coverage for the env-flag kill
  switch could be strengthened in a follow-up iter: add a
  smoke step that sets `MUSE_WEB_SEARCH=false` at API start
  and asserts the chat response contains no citations on a
  web-search-leaning prompt. The unit test mutation-proves
  the parser; a smoke step would mutation-prove the end-to-end
  enforcement.
