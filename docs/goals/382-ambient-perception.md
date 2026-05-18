# 382 — Ambient perception loop (P3)

## Why

OUTWARD-TARGETS P3 audit: today only `muse glance` exists — a
manual, one-shot, macOS-only CLI print of the frontmost
app/window/selection that never reaches the agent. P3-b1 wants a
*gated perception daemon* that periodically snapshots ambient
signals and injects them as run context unasked, such that an
ambient change measurably alters a subsequent agent answer.

This is a substantial bullet; it is decomposed honestly into a
no-flip mechanism slice then a production-wiring slice (the
377 s1 / 378 s2,s4 precedent — the parent bullet stays `[ ]`
until the wiring slice delivers the end-to-end surface check, so
neither half is half-shipped).

## Slices

- s1 (mechanism — THIS, no flip): `packages/agent-core/src/
  ambient-context.ts` — the perception→context-injection seam,
  mirroring the proven `applyActiveContext` / `applyUserMemory`
  transform shape:
  - `AmbientSnapshot` (app / window / selected / clipboard /
    notifications — all optional, all operator-environment-derived
    and therefore UNTRUSTED) + `AmbientSnapshotProvider`.
  - `renderAmbientContextSection` — `[Ambient Context]` block;
    every field passes the same `stripUntrustedTerminalChars` +
    whitespace-collapse sanitiser the other context surfaces use,
    so a `\n[System Override]\n…` splice or ESC/DEL bytes in a
    window title / clipboard cannot forge a prompt section.
  - `applyAmbientContext(context, snapshot, enabled)` — **gated**:
    a no-op unless `enabled` is explicitly true (ambient capture
    is privacy-sensitive — opt-in only, never default-on) and the
    snapshot renders non-empty.
  - `resolveAmbientSnapshot(provider, enabled)` — **fail-open**: a
    disabled/absent provider or a thrown snapshot yields
    `undefined`; perception never breaks a run.
  Verified by `packages/agent-core/test/ambient-context.test.ts`
  (gating off/empty; injection + metadata; an ambient change
  measurably changes the rendered context; injection-bearing field
  sanitised; resolver fail-open).
- s2 (production wiring — flips P3-b1, next): wire
  `applyAmbientContext` into the live agent-runtime context
  pipeline behind an opt-in runtime option, back it with a gated
  osascript-driven perception daemon (reusing
  `parseOsascriptGlance`), and prove the mandated check — an
  ambient change measurably alters a subsequent agent answer
  (integration). Touches the request/response path → that slice
  runs the real local-Ollama-Qwen round-trip.

## Verify

- `packages/agent-core/test/ambient-context.test.ts` 7/7 (run
  directly) and within `pnpm --filter @muse/agent-core test`
  (562 pass, +7, no regression).
- `pnpm check` green across all workspaces (apps/cli 681, all
  packages); `pnpm lint` 0/0; `pnpm guard:core` clean.
- s1 does NOT touch the live request/response path (the transform
  is exported but not yet wired into `agent-runtime.ts`), so no
  smoke:live applies this slice. s2 will.

## Status

P3-b1 mechanism shipped and verified; **P3-b1 NOT flipped** — the
parent bullet stays `[ ]` until s2's production-wiring slice
delivers the end-to-end surface check. Recorded as a deferred
split in the README Rejected ledger. No CAPABILITIES line this
slice (a mechanism slice is not an end-to-end bullet delivery,
per the contract's no-flip-mechanism discipline).

## Decisions

- Gated OFF by default is a hard requirement, not a nicety:
  screen / clipboard / notification capture is privacy-sensitive,
  so `applyAmbientContext` is a strict no-op unless the caller
  explicitly opts in. This also means s2's live wiring leaves
  `smoke:live` (which never opts in) behaviourally unchanged.
- Ambient fields are untrusted input on the same threat footing as
  calendar invite titles / inbox text — the renderer reuses the
  established per-module `sanitizeInline`
  (`stripUntrustedTerminalChars` + `\s+`→" ") so a window title or
  clipboard cannot splice a fake `[System Override]` section or
  smuggle terminal control bytes.
- Fail-open resolver mirrors `applyInboxContext` /
  `resolveActiveContextSnapshot`: perception is an enhancement,
  never a correctness dependency — an Accessibility-permission
  denial must degrade to "no ambient block", never an error.
- `feat(agent-core)`: a new perceivable capability surface enters
  the package even though it is not yet wired live — consistent
  with how 378 s2/s4 mechanism slices were typed.
