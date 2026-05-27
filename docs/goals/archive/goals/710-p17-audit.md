# 710 — P17 target-completion audit (PROCEDURE Step 4): conversational actuation composes end-to-end; locked the previously-uncovered assembly→exposure seam

## Why

All three P17 bullets were `[x]` (706 email tool, 707+708 web/home
tools, 709 live `muse ask --with-tools --actuators` wiring) with no
`P17 audit —` line in the README ledger. Per iteration-loop PROCEDURE
Step 4, that makes the target-completion audit this iteration's sole
mandate: re-run every delivering check TOGETHER and exercise P17 as one
end-to-end user flow, then record PASS or REOPEN.

## What the audit did

- **Re-ran all P17 checks together, green:** apps/api
  p17-{email,web-action,home-action}-tool-agent-seam.test.ts (291 api
  tests) + @muse/cli actuator-tools.test.ts (1215 cli tests) +
  @muse/autoconfigure extraTools test (148→149).
- **Exercised the end-to-end seam.** The pieces were each proven in
  isolation, but the COMPOSITION — `createMuseRuntimeAssembly({
  extraTools })` → `createPersonalToolExposurePolicy` →
  `planForContext({ localMode })` → the actuator reaching the model —
  was covered by NO test (the cli test builds a raw `ToolRegistry`; the
  autoconfigure test only checked registry membership). Verified the
  real chain: an `execute`-risk actuator injected via `extraTools` is
  exposed to the model ONLY under `localMode` (the
  `--actuators` path sets it) AND only when relevant to the prompt;
  without `--actuators` it stays hidden (fail-safe).

## Result — PASS

No drift; no bullet reopened. P0–P17 are now complete + audited. Added
one regression test (`@muse/autoconfigure` autoconfigure.test.ts —
"exposes an execute-risk extraTool actuator … only under localMode and
only when relevant") that locks the assembly→exposure seam so a future
change to the exposure policy or the `extraTools` wiring that silently
stops surfacing actuators (or surfaces them without `--actuators`) fails
a test instead of shipping.

## Verify

- `@muse/autoconfigure` test 149/149 (incl. the new seam test).
- `pnpm check`: EXIT=0 (all workspaces). `pnpm lint`: 0/0.
- The three localMode/relevance outcomes are distinct (true / false /
  false), so the test is not a tautology.

## Decisions

- **Locked the seam in @muse/autoconfigure, not apps/cli** — the
  composition risk lives at the assembly + exposure-policy boundary
  (does an `extraTools` execute-risk tool actually reach the model?),
  which is autoconfigure's responsibility; the cli test already proves
  the gate threads through a real agent run.
- **No live LLM round-trip** — P17 added no model request/response
  behavior; the agent runs use a deterministic sequence provider and the
  exposure check is pure policy. `smoke:live` is not the relevant gate
  here.
