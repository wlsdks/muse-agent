# Loop journals — logging convention (multi-loop, concurrent-safe)

Muse runs **~4 autonomous loops concurrently** (TOOL hardening, cognition, test-hardening, docs, …).
Each loop auto-commits. So the logging structure has ONE hard requirement: **no two loops ever
append to the same mutable file.** A shared journal (the old `loop-digest.md`) collides on every
fire and pollutes the "skill-version ↔ fire-outcome" correlation. This convention fixes that.

> Origin: 2026 multi-agent observability practice — *structured logs with agent IDs + isolated
> paths* are the fundamental control that "makes failures attributable and keeps parallel edits
> from corrupting each other." See loop-creator CHANGELOG v1.14.0 for sources.

## The rules

1. **One append-only journal per loop, keyed by a stable slug** — `docs/goals/loops/<slug>.md`.
   The slug is the loop's *theme* (`tool-hardening`, `cognition`, `test-hardening`, `docs`), NOT a
   package (a loop spans many packages) and NOT a date (dates explode the filename). Date / fire# /
   version live **inside** the entry, not in the filename.
2. **Fixed entry schema** (newest at bottom):
   ```
   ## fire N · YYYY-MM-DD · skill vX.Y.Z · <commit-sha>
   meta: value-class=micro-fix|new-capability|wiring|refactor · pkg=@muse/… · kind=… · verdict=PASS|FAIL · firesSinceDrill=N
   ratchet: testFiles … · fabrication 0 · <eval delta>
   - 무엇: …
   - 왜: …
   - 리뷰지점: …
   - 리스크: …
   lesson: <reusable one-line takeaway>   # ONLY on rollback / no-ship / drill-catch fires
   ```
   The `meta:` line is **grep-able structured metadata** — the date / 작업(kind·value-class·pkg) /
   version the loop needs to *count* and to correlate version↔outcome. The **diversity ratchet keys
   on `(pkg, kind)`** (value-class is theme-constant, so descriptive only — see loop-creator
   `loop-engineering.md` §4.5-9). The optional `lesson:` line distils a reusable takeaway from a
   FAILURE fire (rollback / no-ship / drill-catch) so the next loop can grep it instead of repeating
   the mistake (ReasoningBank, §4.5-13) — omit it on a clean PASS. This is the "날짜-작업-버전 규격," formalized.
3. **`backlog.md` stays a LEAN shared queue** — the one genuinely-shared artifact (loops read it to
   pick `◦` candidates and to dedup "already-fixed/avoid"). It holds **open `◦`/`★`/`⏳` items + a
   one-line `✓ Fixed (dedup ledger)`** — NOT the multi-line Done detail. **Per-fire Done detail goes
   to the loop's journal**, never to backlog (that was the bloat source). Backlog write-back per
   fire = move the picked `◦` to a one-line `✓` ledger entry; the full story is the journal entry.
4. **`INDEX.md` is the thin aggregator** — one line per loop (slug · theme · last fire · last commit
   · status). Each loop updates ONLY its own line (or it's regenerated on demand), so the index
   never becomes a contended append point.
5. **Disjoint paths = no merge race.** Because each loop touches only its own journal + its own
   INDEX line + (rarely) one backlog queue line, four loops auto-committing in parallel produce no
   line-level conflict. Conflicts move to genuine merge time, where there are none.

## Why not the alternatives

- **One shared journal** → every fire conflicts; version↔outcome correlation is polluted (observed:
  a TOOL fire's RATCHET tally got interleaved with a cognition fire's). Rejected.
- **One file per fire** (`<date>-<task>.md`) → thousands of files, churn, no per-loop history view. Rejected.
- **Per-package files** → a loop spans many packages; you'd write a fire across N files. Rejected — slug-per-LOOP.

## Files

- `tool-hardening.md`, `cognition.md`, … — per-loop journals (this is the source of truth for a
  loop's history).
- `INDEX.md` — aggregator.
- `../loop-digest.md` — **legacy tombstone**; loops still pointing there are pre-v1.14.0 and must be
  re-registered.

## Optional machine-readable arm

For analysis (PASS-rate over time, value-class distribution, the cold-eval's commit spot-check),
the `meta:` line is already grep-able. A loop MAY also append a JSONL twin
(`docs/goals/loops/<slug>.jsonl`, one object per fire) if it wants structured queries without
parsing markdown — not required, but the schema maps 1:1.
