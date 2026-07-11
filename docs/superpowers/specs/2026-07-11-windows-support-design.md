# Windows support — Phase 0+1 design

**Date:** 2026-07-11 · **Branch:** `windows-support` (worktree `/tmp/muse-windows-support`)
**Approved scope:** Phase 0 (Windows CI truth gate) + Phase 1 (platform seam).
**Verification environment:** GitHub Actions `windows-latest` only — no physical
Windows machine is available, so CI is the sole judge for anything
platform-behavioral.

## Goal

A user on Windows who clones the repo and runs `pnpm install && pnpm build`
gets a working Muse core — CLI + API server + local Ollama round-trip — with
macOS-only integrations silently absent (fail-soft), and `muse doctor`
honestly reporting what is and isn't active on this OS. No per-OS build
artifacts: the same code resolves its platform adapters at boot from
`process.platform`.

## Non-goals (explicitly out of scope)

- `@muse/windows` integration package (PowerShell/WinRT counterpart to
  `@muse/macos` — Notes/Reminders/Contacts mirrors, ambient source). Phase 2,
  separate cycle.
- Windows desktop companion app (`apps/desktop` is Swift/NSPanel; a Windows
  build is a separate project — Tauri or similar to be evaluated then).
- Distribution/download page with per-OS buttons. Belongs with Phase 3
  packaging work.
- Real Windows sandboxing in `crates/runner` (AppContainer/Job objects). The
  runner already falls back to unsandboxed-with-warning off macOS; that
  behavior is kept and surfaced via doctor.
- `smoke:live` / eval batteries on Windows CI — no Ollama on the runner.
  Tier-1 gate is build + unit tests.

## Current state (scanned 2026-07-11)

- Pure-Node portable already: `agent-core`, `model`, `memory`, `recall`,
  `stores`, `tools`, `apps/api`, `apps/web`.
- `win32` branches already exist: clipboard read
  (`clipboard-reader.ts` → `powershell Get-Clipboard`), copy
  (`chat-ink-run.ts` → `clip`), binary lookup (`where` vs `which`), file open
  (`commands-show.ts` → `start`), MCP manager `PATHEXT` handling.
- macOS-coupled seams with **no** win32 path:
  - `packages/secrets/src/sources/keychain.ts` — fixed `/usr/bin/security`.
  - Audio playback — `afplay` (darwin) / `aplay` (else); no win32 branch
    (`voice-playback.ts`, `commands-brief.ts`, `commands-listen.ts`).
  - Daemon registration — launchd LaunchAgent only
    (`commands-daemon-launchagent.ts`, `commands-daemon-register.ts`).
  - `packages/macos` (osascript-backed tools/mirrors) and
    `packages/proactivity/src/macos-ambient-source.ts` — both designed
    fail-soft; consumers must not assume presence.
- CI: single `ubuntu-latest` job in `.github/workflows/ci.yml` (Node 24).

## Architecture: one explicit platform seam

A small module in `@muse/shared` (the dependency-leaf package every
consumer already reaches) exporting a boot-time-resolved descriptor:

```ts
interface PlatformCapabilities {
  readonly os: "darwin" | "win32" | "linux";
  readonly secretsSource: "keychain" | "credential-manager" | "encrypted-store";
  readonly audioPlayer: string | null;      // afplay | aplay | powershell …
  readonly daemonManager: "launchd" | "schtasks" | "none";
  readonly osIntegrations: boolean;          // @muse/macos-class tools available
}
resolvePlatformCapabilities(platform?: NodeJS.Platform): PlatformCapabilities
```

Rules:

- **Pure + injectable.** The resolver is a pure function of a platform string
  so every branch is unit-testable from macOS. Callers take the descriptor
  (or a runner) via options, matching the existing injectable-runner pattern
  (`MacOsascriptRunner`, `ArgvRunner`).
- **Fail-soft, reported.** A capability absent on this OS disables its
  surface quietly at runtime, and `muse doctor` gains a platform section that
  prints the resolved descriptor — honesty surface, not silent divergence.
- **No behavior change on macOS.** darwin resolution reproduces today's
  choices exactly; existing scattered `process.platform` checks migrate to
  the seam only where Phase 1 touches them anyway (no big-bang refactor).

## Phase 0 — Windows CI truth gate

1. Add a `windows-latest` job to `ci.yml` (same Node 24 + pnpm setup,
   `pnpm check`). Rust job for `crates/runner` (`cargo test`) if the existing
   CI covers it on Linux.
2. Triage failures. Expected classes: POSIX assumptions in `scripts/*.mjs`
   (shell strings, `rm -rf`, path separators), hardcoded `/` joins, tests
   asserting `/usr/bin/...` paths, symlink/EOL issues (`.gitattributes` may
   need `* text=auto eol=lf`).
3. Gate: `pnpm check` green on windows-latest. This job becomes required and
   permanent — it is the regression fence for everything after.

## Phase 1 — platform seam completion

Each slice lands with unit tests (win32 branches tested via injected
platform/runner on macOS) and must keep both CI jobs green.

1. **`resolvePlatformCapabilities`** module + tests; `muse doctor` platform
   posture section.
2. **Secrets:** add a Windows credential source. Preferred: PowerShell
   `Get-StoredCredential`-free approach — `cmdkey` cannot read passwords, so
   the realistic v1 is **encrypted-store fallback on win32** (already the
   documented alternative in `cli-product.md`), with a
   `credential-manager` source added only if a dependency-free read path
   proves viable (DPAPI via PowerShell `CredRead` P/Invoke snippet). Fail
   order on win32: credential-manager (if shipped) → encrypted store; never
   silently plaintext.
3. **Audio:** win32 playback branch (PowerShell `MediaPlayer`/`SoundPlayer`
   invocation) behind the same watchdog used by `afplay`/`aplay`; `muse
   listen` recording documents sox-on-Windows and degrades with a clear
   message when `rec`/player is missing.
4. **Daemon:** `schtasks /create` registration path mirroring the
   LaunchAgent contract (register/unregister/status), same fail-soft
   reporting in doctor. Injectable runner; asserted via argv-shape unit
   tests.
5. **Docs:** README "Windows" section — supported (core), not-yet
   (integrations/desktop), install steps (pnpm, Ollama for Windows).

## Verification

- **Per-slice:** `pnpm test:changed` locally; win32 code paths covered by
  unit tests with injected `platform`/runners (no Windows machine needed).
- **Per-push:** both CI jobs (`ubuntu-latest` + `windows-latest`) green.
- **Honesty rule:** anything only provable on real Windows (audio actually
  audible, schtasks actually firing) is labeled **CI-verified only** in the
  README/doctor output — we do not claim live-verified behavior we cannot
  observe.

## Risks

- **windows-latest breakage volume unknown.** Phase 0 exists to measure it;
  if triage exceeds a few days, we re-scope (e.g., exclude a pathological
  package from the Windows job with a tracked TODO rather than stall).
- **Runner has no Ollama** — model round-trip untested on Windows. Accepted:
  the Ollama HTTP client is platform-neutral; risk is documented, not
  hand-waved.
- **Concurrent autonomous loops** touch main continuously; the worktree
  branch may drift. Mitigation: small slices, frequent rebase onto
  `origin/main`.
- **EOL/git config** on contributor machines (CRLF) can break snapshot
  tests; `.gitattributes` normalization is part of Phase 0 triage if it
  bites.
