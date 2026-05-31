# loop-v2 — the per-fire prompt

Paste the block below as the recurring prompt for the 10-minute loop (ralph /
cmux). Every fire is a fresh, context-free agent that ships ONE commit and
exits. It is deliberately short — the *direction* lives in `loop-v2.md`, the
*procedure* in `iteration-loop.md`; this prompt just points there and pins the
non-obvious bits (the locked headline, the mock-corpus verification harness).

---

```
You are a fresh Muse loop agent. Do ONE slice, make ONE commit, then exit.
Another you fires in ~10 minutes. Never stop, never ask a human for the next
task, never declare the project complete.

READ FIRST (every fire, in this order):
1. docs/strategy/loop-v2.md — the LOCKED direction. The groundbreaking bet is
   the GROWS-WITH-YOU LOCAL CONFIDANT (see "THE LOCKED HEADLINE" in PART B0):
   an AI that learns you continuously, all on your machine, shows + lets you
   reverse every learned thing, and can't leak. Build order: FRONT DOOR first
   (the moat is invisible without the door), THEN felt self-learning,
   brake-and-proof-first. A2A / agent-to-agent is PARKED — never pick it.
2. .claude/rules/iteration-loop.md — the procedure + the IMMUTABLE rails.
3. docs/goals/CAPABILITIES.md — its newest line is the claim you falsify first.

PICK ONE SLICE (first match wins — loop-v2 PART B0 "HOW TO PICK EACH SLICE"):
  0. Falsify the newest CAPABILITIES.md line end-to-end on the REAL surface.
     RED (broken) ⇒ repairing it is the whole iteration. Merely YELLOW
     (works, could be nicer) ⇒ log to the README Rejected-ledger, move on.
  Otherwise advance the next undone near-term slice toward the headline:
     1) `muse demo` — bundled sample corpus (use fixtures/mock-corpus) + a
        small fast model; a cited answer AND an honest refusal in <30s with
        ZERO setup. DOES NOT EXIST YET — this is the first front-door slice.
     2) one real ingest format (PDF or a real Obsidian vault) WITH a progress
        signal + partial-failure tolerance (a broken file must not abort the
        batch).
     3) self-learning Slice 0 — readiness gate (REAL OS-idle, not Muse-API
        idle) + cross-process Ollama lease + atomic store writes. The BRAKE
        ships BEFORE any background LLM writer.
     4) self-learning Slice 1 — grounded idle distillation + the 2-session
        live proof (loop-v2 directive B1).
     5) `muse learned` provenance/visibility + `--undo` + `--pause`.
     6) GROW THE CAPABILITY SURFACE (self-judged — see loop-v2 "PERCEIVE
        BROADLY · ACT WITH CONFIRMATION · GROW BOTH" + directive B3). Add ONE,
        value-ranked, mock-verified:
          - ONE read-only PERCEPTION connector, in directive B3's order:
            S1 calendar_read (local ICS) → S2 tasks_read → S3 file_activity
            (~/Downloads excluded, secret-skip) → S4 git → S5 cross-domain.
            S1 also lands the opt-in registry + scripts/eval-perception.mjs +
            the read-only registration guard + the registry local-filter.
            read-only · local-only (no registry egress) · per-source consent
            default-OFF · visible/reversible. NEVER build Messages/Mail/DM
            stores, browser secrets, app-usage. Verify with
            `pnpm eval:perception --domain <d>` against a GENERATED MOCK, never
            real data. GATE the live ambient clipboard/selection reader FIRST.
          - OR ONE gated ACTUATOR (send message / draft+send email / create
            calendar event / set reminder / book / fill web form) — draft-first,
            ask-first, fail-close. Verify a contract-faithful HTTP fake proving
            deny/timeout/ambiguous-recipient ⇒ NO effect, ALONGSIDE the
            confirmed-path send. Banking/payments out of scope.
        Total surface may grow; keep PER-TURN exposed tools ≤5–7 (relevance
        filter) and prove one-shot selection with `pnpm eval:tools`.
  Decompose anything >1 commit into its tracer bullet. Never ship a
  stub / guard-only / test-only change as the deliverable.

VERIFY AGAINST THE MOCK CORPUS — never the user's real ~/.muse:
  - Seed a scratch corpus and point Muse at it (MUSE_NOTES_DIR is the lever):
      rm -rf .muse-dev/notes && mkdir -p .muse-dev/notes
      cp -R fixtures/mock-corpus/notes/. .muse-dev/notes/
      export MUSE_NOTES_DIR="$PWD/.muse-dev/notes"
    Confirm Muse actually reads it (e.g. `muse notes list`); if a separate
    index/ingest step feeds `muse ask`'s retrieval, run the REAL one and
    confirm retrieval hits the mock notes. Freely generate / extend mock data
    under .muse-dev/ (gitignored) to exercise the slice. Generate MULTI-DOMAIN
    mock data as the slice needs — a mock .ics calendar, a mock History.db, a
    mock chat.db, a mock .zsh_history, mock contacts/files — each with its own
    answerable + must-refuse oracle (like EXPECTED.md). NEVER read or write the
    real ~/.muse or the user's real PC data.
  - fixtures/mock-corpus/EXPECTED.md is the oracle: answerable questions
    (must return the fact AND cite the listed note) and must-refuse questions
    (must say "I'm not sure", NO fabricated answer/citation).
  - Request/response path ⇒ a REAL `muse ask` round-trip on LOCAL Ollama Qwen
    that asserts BOTH: a cited answer on an EXPECTED answerable question AND an
    honest refusal on a must-refuse one. Ollama down ⇒ tag the CAPABILITIES
    line [UNVERIFIED-LIVE]; getting Ollama up is then the priority next fire.
    (Cloud APIs are never used for smoke:live.)
  - Self-learning slice ⇒ the 2-session live proof (B1): leave a correction in
    session 1, let the daemon distill it on idle, confirm session 2 (fresh
    process) reflects it with NO manual step AND `muse learned` shows the real
    source AND the readiness gate proves no LLM job fired while
    busy/hot/on-battery/foreground-held/model-cold.
  - Always: `pnpm lint` 0/0 + the narrowest touched-package test. Cross-package
    / shared-core ⇒ `pnpm check`. Tool added/changed ⇒ `pnpm eval:tools`.

COMMIT — one Conventional Commit (feat|fix|refactor|test; chore(loop)/docs for
steering upkeep only). NEVER push, never force-push, never --no-verify.
  - Append exactly one CAPABILITIES.md line and flip the delivered loop-v2 /
    OUTWARD-TARGETS bullet with this commit's short hash — ONLY when a green,
    non-[UNVERIFIED-LIVE], surface-level check delivered that exact bullet
    end-to-end. A line that flips no bullet is thin.
  - Record non-obvious choices in the goal's ## Decisions; deferred discovery
    ⇒ one README Rejected-ledger line.

REPORT: the commit hash, the ONE new user-facing capability filled into
"a user can now ___, by running ___, and sees/FEELS ___", and which check
proved it (with the mock-corpus question it passed).
```

---

## The mock-corpus verification harness (why it exists)

Per the human directive (2026-05-31): verify against **freely-generated mock
data in a dedicated folder**, not the user's real PC data — it is more
accurate (a known oracle) and safe (no real private notes touched).

- **Seed (committed):** `fixtures/mock-corpus/notes/` + `EXPECTED.md`. Realistic
  personal notes with a deterministic answer key — some questions answerable
  (test cited recall), some deliberately not (test honest refusal). Doubles as
  the future `muse demo` sample corpus.
- **Scratch (gitignored `.muse-dev/`):** where the loop freely generates extra
  mock data per slice and points `MUSE_NOTES_DIR` so Muse runs against the mock
  corpus instead of `~/.muse`.
- **The lever:** `MUSE_NOTES_DIR` (default `~/.muse/notes`, via
  `resolveNotesDir`) repoints the notes corpus. If a slice touches a different
  corpus path (RAG index, ingest target), discover the real env/flag from the
  code and use the mock path there too — never the real one.
