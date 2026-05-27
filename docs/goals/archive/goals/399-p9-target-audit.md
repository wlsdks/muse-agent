# 399 — P9 target-completion audit (the P→P seam check)

## Why

P9-b1 + P9-b2 are both `[x]` and no `P9 audit —` line existed —
the Step-4 trigger. Per the iteration-loop contract this
iteration's sole mandate is to re-run every P9 CAPABILITIES check
together AND exercise P9 as one end-to-end production flow against
the falsifiable test.

## Verify

- All P9 deterministic backing checks re-run green TOGETHER:
  `@muse/mcp` objective-evaluator + objective-evaluation-loop +
  personal-objectives-store = 17/17; `@muse/api` objectives-tick +
  objectives-daemon + situational-briefing-tick +
  situational-briefing-daemon = 15/15.
- New seam: `apps/api/test/p9-seam.test.ts` 3/3.
- `pnpm --filter @muse/api test` 190 pass; tsc strict clean (ran
  proactively); `pnpm check` green across all workspaces (apps/cli
  683, all packages); `pnpm lint` 0/0; `pnpm guard:core` clean.
- The live qwen3:8b decision was already verified by goal 398's
  real round-trip (met/unmet/unmeetable) and is cited; the seam
  test uses a deterministic strict-JSON model stand-in so it is
  reproducible — the same way the P0–P8 audits handled live-LLM
  (deterministic composition + a separately-cited live check). No
  smoke:live this iteration.

## Status

PASS. P9's bullets ARE a composed production pipeline: the
env-gated `startObjectivesDaemonIfConfigured` builds the concrete
`createModelObjectiveEvaluator` + `createMessagingObjectiveActuator`
and feeds them to the P9-b1 `startObjectivesTick` rider, which
drives `runDueObjectives` over the real on-disk objectives store.
Each isolated test covered one link with the others faked;
`p9-seam.test.ts` exercises the WHOLE chain composed exactly as
the daemon-set function wires it (only the model verdict — a
deterministic strict-JSON stand-in — and the HTTP boundary faked):

1. `met` verdict → the concrete messaging actuator POSTs
   "✅ Objective met: …" over a real `TelegramProvider` and the
   objective is durably `done` in the real store;
2. `unmet` → no channel POST, the objective stays `active` with
   `attempts=1` + `nextEvalAt` (backoff persisted);
3. `unmeetable` → "⚠ Objective needs you: … — <reason>" escalation
   POSTed and the objective durably `escalated`.

This is the genuine seam none of the isolated tests covered (they
each faked the other links). No drift; no bullet reopened. P9 (the
delegated-autonomy loops actually run in production) is genuinely
delivered end-to-end.

**P0, P1, P2, P3, P4, P5, P6, P7, P8, P9 are now ALL delivered +
audited** — including the three loop-authored targets (P7, P8, P9)
and the [UNVERIFIED-LIVE] that the honesty machinery caught (397)
then cleared via a verified round-trip (398). Per the
OUTWARD-TARGETS contract the next iteration self-extends the map
again toward the north star.

## Decisions

- A seam test IS warranted (as for P5/P6/P7/P8): P9 is a composed
  pipeline whose join — daemon-wired concrete evaluator/actuator →
  rider → `runDueObjectives` → real channel + durable store —
  carried real risk the per-link tests skipped. apps/api depends
  on @muse/mcp + @muse/messaging, so it is the correct
  layering-respecting home for the composition.
- The live-LLM decision is verified once, separately (398's real
  qwen3:8b round-trip), and the seam test is deterministic — a
  committed seam test that re-invoked qwen3:8b would be
  nondeterministic (the documented local-Qwen variance) and is not
  how any prior audit handled live-LLM. Citing 398 + a
  deterministic strict-JSON stand-in is the honest, reproducible
  pattern.
- No CAPABILITIES line and no bullet flipped: per Step 4 the audit
  verifies already-flipped bullets compose; deliverable is the
  README ledger `P9 audit — … — PASS` line. `test(api)` mirrors
  the P1/P2/P7 audit commits.
