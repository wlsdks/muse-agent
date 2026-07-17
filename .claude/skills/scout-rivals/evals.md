# scout-rivals — evals (golden set)

Repo state → expected SHAPE of behavior (outcome-graded). Grow from real
misses. Baseline failures this skill exists to prevent (all observed in the
2026-06/07 competitor loops): re-scouting exhausted ground, trusting
unverified claims, recommending off-strategy cloud features.

## Contents
- R1 — re-teardown temptation → delta from watermark only
- R2 — shiny multi-tenant feature → judged off-strategy, skipped
- R3 — hype claim without code → ⚠ unverified, never `build`
- R4 — empty delta → valid outcome, watermark bump, no manufactured findings
- R5 — "gap" Muse already closed → ✓ flip, not a finding
- R6 — found a defect-class trick → tagged →improve-muse, no inline build

### R1 — the thorough-restart temptation
**state:** watermark = 3 weeks ago; the agent considers re-reading all 420
teardown files "to be safe".
**expected:** `git log --since=<watermark>` + releases on roster repos only;
the base is referenced, not re-derived. FAIL on any full re-teardown.

### R2 — the shiny off-strategy feature
**state:** a rival shipped an impressive hosted multi-tenant gateway with
cloud key management.
**expected:** verified, then judged fit=off-strategy, verdict=skip, recorded
with the reason — not appended as build fuel. FAIL if feature envy overrides
the identity lens.

### R3 — the benchmark blog post
**state:** a post claims rival X's memory "beats everything"; no code read.
**expected:** ⚠ unverified entry (or code-verify first); never `build` from
prose alone. FAIL on a judgment sourced only from the post.

### R4 — quiet upstream
**state:** since the watermark, roster repos shipped only refactors/docs.
**expected:** watermark bumped, "no material delta" recorded honestly, no
manufactured findings. (Contrast with improve/grow: THIS skill may end
empty.) FAIL on filler findings.

### R5 — the stale gap
**state:** a rival's feature looks missing in Muse, but git log/codegraph
shows Muse shipped an equivalent last week.
**expected:** parity ledger's stale row flipped ✓ (or no new row); not
reported as a gap. FAIL if it feeds an already-closed gap to grow-muse.

### R6 — the hardening trick
**state:** the delta reveals a rival's crash-recovery pattern for a failure
class Muse demonstrably has.
**expected:** one ◦ line tagged `→improve-muse` with the evidence path —
not built inline, not routed to grow-muse (it's not a capability). FAIL on
inline fixing or misrouting.
