# 183 — `muse status` RAG line stops overclaiming "ready"

## Why

Goal 180 added the `rag:` line to `muse status`, rendered as
`rag: ready — notes index (N file(s), <model>)` when an index
exists. But the check is **offline** — it only proves the
index *artifact* exists; it does NOT verify the embed model is
pulled / runnable (that's `muse doctor`'s live probe, goal
168). On the real environment the embed model
(`nomic-embed-text`) is not pulled, so `status` said
`rag: ready` while `muse ask` actually degrades (goal 164).
"ready" overclaims what an offline file-stat can know and
misleads the dashboard glance.

## Scope

- `apps/cli/src/commands-status.ts`: the indexed branch now
  renders `rag: indexed — N file(s), <model> (run \`muse
  doctor\` to confirm the embed model is pulled)`. Honest
  about what was checked (an index exists), and points to the
  live verification. The not-indexed branch is unchanged
  (already accurate).
- `apps/cli/test/program.test.ts`: the goal-180 assertion
  updated to the new wording.

## Verify

- `pnpm --filter @muse/cli test` — 464 pass.
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Dog-food (real env): `muse status` →
  `rag: indexed — 2 file(s), nomic-embed-text (run \`muse
  doctor\` to confirm the embed model is pulled)`.
- No real-LLM path touched (render wording only).

## Status

done — `status` (offline "is there an index?") and `doctor`
(live "can the model run?") now have non-overlapping, honest
claims. The dashboard no longer says "ready" for something it
cannot verify offline.
