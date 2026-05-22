# 704 — P15 target-completion audit (the P→P seam check)

## Why

P0–P14 are audited; P15 (gated agentic web actions) is the next oldest
completed target with no `P15 audit —` line. Per the iteration-loop
PROCEDURE Step 4, the sole mandate is to re-run every P15
`CAPABILITIES.md` check TOGETHER AND exercise P15 against its
falsifiable test ("action → gate → only on confirm does it fire;
absent ⇒ no external effect").

## Verify (all re-run green TOGETHER)

- `@muse/mcp` web-action.test.ts 4/4 — `performWebActionWithApproval`:
  CONFIRM → exactly one real request carrying the method+body + a
  `performed` action-log entry; DENY / gate-throw (timeout) /
  never-autonomous → 0 HTTP. Contract-faithful: it records the actual
  request shape, never a fake "did it" flag.
- `@muse/cli` commands-web-action.test.ts 2/2 — `muse web-action`
  confirm → done (HTTP fires); deny → no HTTP, exit 1.
- `pnpm check:capabilities` ✓; lint clean (no source change).

## Seam / end-to-end

The surface → orchestration → gate → HTTP chain composes in
commands-web-action.test.ts (the real `muse web-action` command with an
injected gate + a recording fetch). The gate semantics (deny / throw /
absent ⇒ no HTTP) are proven contract-faithfully in web-action.test.ts.
The bullet's own falsifiable test IS the contract-faithful HTTP-fake
check — no live external POST is run (that would violate the local /
free constraint and the safety stance against firing real
state-changing requests in a test/audit).

## Status

**PASS.** P15's gated web action is genuinely fail-closed end-to-end: a
state-changing request fires ONLY on explicit confirmation, and deny /
timeout / never-autonomous produce no external effect — proven across
both the orchestration (contract-faithful) and the CLI surface. No
drift; no bullet reopened. A `P15 audit — … — PASS` line is appended to
the `docs/goals/README.md` Rejected ledger.

## Decisions

- **No live external POST** — the bullet's check is explicitly a
  contract-faithful HTTP fake (never a fake registry); firing a real
  state-changing web request in an audit is both against the
  local/free constraint and unsafe (banking/payments are out of scope,
  and any real POST has a blast radius). The recording-fetch tests are
  the correct end-to-end here.
- **No new seam test** — the orchestration check + the CLI surface
  check already compose the whole chain; a redundant test would be
  inward churn.
- **Audit is steering upkeep** — `docs(loop)`, not a counted iteration;
  no source change.

## Remaining

- **P16 audit pending** — the LAST of the P11–P16 actuator map
  (smart-home). After it, the whole actuator-breadth map is audited and
  the next iteration extends `OUTWARD-TARGETS.md` toward the north star.
