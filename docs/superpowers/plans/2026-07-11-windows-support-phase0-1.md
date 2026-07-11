# Windows Support Phase 0+1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Muse core (CLI + API + local Ollama) works on Windows via boot-time platform resolution, proven by a permanent `windows-latest` CI job.

**Architecture:** One pure, injectable `resolvePlatformCapabilities()` seam in `@muse/shared`; per-surface win32 branches (audio, secrets chain, daemon autostart) that reproduce today's darwin behavior exactly; macOS-only integrations stay fail-soft-absent. CI on `windows-latest` is the sole platform-behavior judge (no Windows machine available).

**Tech Stack:** TypeScript strict, vitest, pnpm workspaces, GitHub Actions, PowerShell `Media.SoundPlayer` (audio), `schtasks` (autostart).

**Spec:** `docs/superpowers/specs/2026-07-11-windows-support-design.md` (approved 2026-07-11).

## Global Constraints

- Work in worktree `/tmp/muse-windows-support`, branch `windows-support`. Never edit `/Users/jinan/side-project/Muse` for this plan.
- **No behavior change on macOS.** Every darwin path resolves exactly today's choices (`afplay`, keychain, launchd plist).
- Per-edit test gate is `pnpm test:changed` (vitest related). Never run the full suite or `pnpm check` locally — CI runs `pnpm check`.
- Rebuild an edited package before testing a dependent one: `pnpm --filter @muse/<name> build`.
- Lint gate: `pnpm lint` must stay 0 errors. Comment policy: WHY-only, no WHAT narration, no goal/round markers.
- Conventional Commits; commit after each green task; push to `origin windows-support` (standing approval; never force-push).
- win32 code paths are unit-tested from macOS via injected `platform` / runner params (existing injectable-runner idiom). Anything only provable on real Windows is labeled **CI-verified only** in user-facing text.
- Node 24, pnpm via corepack, `--frozen-lockfile` in CI.

---

### Task 0: Worktree bootstrap

**Files:** none (environment only)

- [ ] **Step 1: Install deps in the worktree**

Run: `cd /tmp/muse-windows-support && pnpm install --frozen-lockfile`
Expected: exits 0 (workspace `node_modules` populated — the worktree starts without one).

- [ ] **Step 2: Sanity-build shared + cli**

Run: `cd /tmp/muse-windows-support && pnpm --filter @muse/shared build && pnpm --filter @muse/cli build`
Expected: exits 0.

---

### Task 1: Windows CI job + draft PR (the truth gate)

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: a `check-windows` job that every later task must keep green; a draft PR `windows-support → main` whose `pull_request` trigger runs CI on each push.

- [ ] **Step 1: Add the windows job**

Append to `jobs:` in `.github/workflows/ci.yml` (keep the existing `check` job untouched; lint runs once on ubuntu, so the windows job runs only `pnpm check`):

```yaml
  check-windows:
    runs-on: windows-latest
    timeout-minutes: 90
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm check
```

- [ ] **Step 2: Commit and push the branch**

```bash
cd /tmp/muse-windows-support
git add .github/workflows/ci.yml
git commit -m "ci: add windows-latest check job (Windows support phase 0)"
git push -u origin windows-support
```

- [ ] **Step 3: Open a draft PR so CI runs per push**

```bash
gh pr create --draft --title "feat: Windows support (phase 0+1 — CI gate + platform seam)" \
  --body "$(cat <<'EOF'
Per docs/superpowers/specs/2026-07-11-windows-support-design.md.

- Phase 0: windows-latest CI job + triage until green
- Phase 1: platform seam (@muse/shared), audio win32, secrets chain, schtasks autostart, doctor posture, README

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed; `gh pr checks --watch` shows both `check` and `check-windows` running.

---

### Task 2: Phase 0 triage — drive `check-windows` to green

**Files:** unknown until CI reports; fixes follow the recipes below, each as its own narrow commit.

**Interfaces:**
- Consumes: failing-job logs via `gh run view <run-id> --log-failed` (or `gh pr checks`).
- Produces: green `check-windows`; possibly `.gitattributes`.

**The loop (bounded):** read failed log → classify against the recipe table → apply the *narrowest* fix → `pnpm test:changed` locally → commit + push → wait for CI → repeat. **Bound: if one package/test area still fails after 3 targeted rounds, quarantine it** (skip that test on win32 with `it.skipIf(process.platform === "win32")` + a `TODO(windows):` note in the PR description — never delete a test) and move on. Record every quarantine in the PR body.

**Fix recipes by failure class:**

| Symptom in log | Fix |
|---|---|
| Path assertions failing on `\` vs `/` | In the test, build expected paths with `path.join`/`path.sep`, or normalize actual with `.split(sep).join("/")`. Don't change product code that already uses `path.join`. |
| Hardcoded `/tmp` or `/usr/...` in tests | Replace with `os.tmpdir()` / fixture-relative paths. Product code asserting `/usr/bin/security` etc. is darwin-only by design — gate the *test* with `it.skipIf(process.platform === "win32")` only if it executes the real binary. |
| CRLF/EOL snapshot or byte-hygiene failures | Create `.gitattributes` at repo root with `* text=auto eol=lf`, commit, and note that contributors must re-checkout. |
| `spawn EINVAL` / shell-string usage in `scripts/*.mjs` | Replace `exec("cmd string")` with `execFile`/`spawn` + argv array; replace `rm -rf` shell calls with `fs.rmSync(p, { recursive: true, force: true })`. |
| `EPERM`/file-lock on unlink of open files (Windows can't delete open files) | Close handles before `rm`; in tests, wrap cleanup in try/catch (`force: true`). |
| Symlink creation fails (no privilege on runner) | Avoid symlinks in tests; copy instead. |
| Case-sensitivity import mismatch | Fix the import path casing to match the file exactly. |

- [ ] **Step 1:** Run the loop until `gh pr checks` shows `check-windows` ✓.
- [ ] **Step 2:** Final commit of this task updates the PR body with the triage summary (what broke, what was fixed, any quarantines).

---

### Task 3: `resolvePlatformCapabilities` in `@muse/shared`

**Files:**
- Create: `packages/shared/src/platform-capabilities.ts`
- Create: `packages/shared/src/platform-capabilities.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces (consumed by Tasks 4–7):

```ts
export type PlatformOs = "darwin" | "win32" | "linux" | "other";
export interface PlatformCapabilities {
  readonly os: PlatformOs;
  readonly secretsChain: readonly ("env" | "keychain" | "store")[];
  readonly audioPlayer: "afplay" | "powershell" | "aplay" | null;
  readonly daemonAutostart: "launchd" | "schtasks" | "none";
  readonly osIntegrations: "macos" | "none";
}
export function resolvePlatformCapabilities(platform?: NodeJS.Platform): PlatformCapabilities;
```

- [ ] **Step 1: Write the failing test** (`packages/shared/src/platform-capabilities.test.ts`)

```ts
import { describe, expect, it } from "vitest";

import { resolvePlatformCapabilities } from "./platform-capabilities.js";

describe("resolvePlatformCapabilities", () => {
  it("darwin reproduces today's choices exactly", () => {
    expect(resolvePlatformCapabilities("darwin")).toEqual({
      audioPlayer: "afplay",
      daemonAutostart: "launchd",
      os: "darwin",
      osIntegrations: "macos",
      secretsChain: ["env", "keychain", "store"]
    });
  });

  it("win32 gets powershell audio, schtasks autostart, no keychain, no macOS integrations", () => {
    expect(resolvePlatformCapabilities("win32")).toEqual({
      audioPlayer: "powershell",
      daemonAutostart: "schtasks",
      os: "win32",
      osIntegrations: "none",
      secretsChain: ["env", "store"]
    });
  });

  it("linux keeps aplay and has no autostart manager yet", () => {
    expect(resolvePlatformCapabilities("linux")).toEqual({
      audioPlayer: "aplay",
      daemonAutostart: "none",
      os: "linux",
      osIntegrations: "none",
      secretsChain: ["env", "store"]
    });
  });

  it("an unknown platform degrades to no audio player", () => {
    const caps = resolvePlatformCapabilities("freebsd");
    expect(caps.os).toBe("other");
    expect(caps.audioPlayer).toBeNull();
    expect(caps.daemonAutostart).toBe("none");
  });

  it("defaults to process.platform", () => {
    expect(resolvePlatformCapabilities().os).toBe(process.platform === "darwin" ? "darwin" : resolvePlatformCapabilities().os);
    expect(() => resolvePlatformCapabilities()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /tmp/muse-windows-support && pnpm --filter @muse/shared test -- platform-capabilities`
Expected: FAIL — cannot resolve `./platform-capabilities.js`.

- [ ] **Step 3: Implement** (`packages/shared/src/platform-capabilities.ts`)

```ts
/**
 * Boot-time platform seam: every OS-dependent choice (audio player, secrets
 * chain, daemon autostart, OS-integration availability) resolves through this
 * one pure function so win32 branches are unit-testable from any OS and
 * `muse doctor` can report the posture honestly.
 */

export type PlatformOs = "darwin" | "win32" | "linux" | "other";

export interface PlatformCapabilities {
  readonly os: PlatformOs;
  readonly secretsChain: readonly ("env" | "keychain" | "store")[];
  readonly audioPlayer: "afplay" | "powershell" | "aplay" | null;
  readonly daemonAutostart: "launchd" | "schtasks" | "none";
  readonly osIntegrations: "macos" | "none";
}

export function resolvePlatformCapabilities(
  platform: NodeJS.Platform = process.platform
): PlatformCapabilities {
  if (platform === "darwin") {
    return {
      audioPlayer: "afplay",
      daemonAutostart: "launchd",
      os: "darwin",
      osIntegrations: "macos",
      secretsChain: ["env", "keychain", "store"]
    };
  }
  if (platform === "win32") {
    return {
      audioPlayer: "powershell",
      daemonAutostart: "schtasks",
      os: "win32",
      osIntegrations: "none",
      secretsChain: ["env", "store"]
    };
  }
  if (platform === "linux") {
    return {
      audioPlayer: "aplay",
      daemonAutostart: "none",
      os: "linux",
      osIntegrations: "none",
      secretsChain: ["env", "store"]
    };
  }
  return {
    audioPlayer: null,
    daemonAutostart: "none",
    os: "other",
    osIntegrations: "none",
    secretsChain: ["env", "store"]
  };
}
```

Add to `packages/shared/src/index.ts`:

```ts
export { resolvePlatformCapabilities, type PlatformCapabilities, type PlatformOs } from "./platform-capabilities.js";
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @muse/shared test -- platform-capabilities`
Expected: PASS (5 tests).

- [ ] **Step 5: Build + commit**

```bash
pnpm --filter @muse/shared build
git add packages/shared/src/platform-capabilities.ts packages/shared/src/platform-capabilities.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): resolvePlatformCapabilities — one boot-time platform seam"
git push
```

---

### Task 4: Audio playback on win32 (wav + PowerShell SoundPlayer)

**Files:**
- Modify: `apps/cli/src/voice-playback.ts` (defaultSpeakerShells at :162, playAudioWithWatchdog at :103, synthesizeAndPlay at :37)
- Modify: `apps/cli/src/commands-brief.ts:154`, `apps/cli/src/commands-listen.ts:279` (player selection sites)
- Test: `apps/cli/src/voice-playback.test.ts` (extend the existing file; create if absent)

**Interfaces:**
- Consumes: nothing new (self-contained; `resolvePlatformCapabilities` is documentation-level here — the invocation resolver below is the executable form).
- Produces (used by commands-brief/listen):

```ts
export interface PlayerInvocation { readonly cmd: string; readonly args: readonly string[]; }
export function resolveAudioPlayerInvocation(platform: NodeJS.Platform, filePath: string): PlayerInvocation;
export function playInvocationWithWatchdog(invocation: PlayerInvocation, spawnFn?: typeof spawn): Promise<void>;
```

**Why wav on win32:** PowerShell `Media.SoundPlayer` plays ONLY wav. The TTS layer already supports `wav` (`AUDIO_FORMATS`), so `synthesizeAndPlay` defaults the *requested* format to `wav` on win32 when the caller didn't specify one; mp3 default is unchanged elsewhere.

- [ ] **Step 1: Write the failing tests** (append to `apps/cli/src/voice-playback.test.ts`)

```ts
import { describe, expect, it } from "vitest";

import { resolveAudioPlayerInvocation } from "./voice-playback.js";

describe("resolveAudioPlayerInvocation", () => {
  it("darwin → afplay <file> (unchanged)", () => {
    expect(resolveAudioPlayerInvocation("darwin", "/tmp/a.mp3")).toEqual({ args: ["/tmp/a.mp3"], cmd: "afplay" });
  });

  it("win32 → powershell SoundPlayer with the path single-quote-escaped", () => {
    const inv = resolveAudioPlayerInvocation("win32", "C:\\Users\\o'brien\\out.wav");
    expect(inv.cmd).toBe("powershell");
    expect(inv.args[0]).toBe("-NoProfile");
    expect(inv.args[1]).toBe("-Command");
    expect(inv.args[2]).toContain("Media.SoundPlayer 'C:\\Users\\o''brien\\out.wav'");
    expect(inv.args[2]).toContain("PlaySync()");
  });

  it("linux → aplay <file> (unchanged)", () => {
    expect(resolveAudioPlayerInvocation("linux", "/tmp/a.wav")).toEqual({ args: ["/tmp/a.wav"], cmd: "aplay" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @muse/cli test -- voice-playback`
Expected: FAIL — `resolveAudioPlayerInvocation` not exported.

- [ ] **Step 3: Implement in `voice-playback.ts`**

Add:

```ts
export interface PlayerInvocation {
  readonly cmd: string;
  readonly args: readonly string[];
}

export function resolveAudioPlayerInvocation(plat: NodeJS.Platform, filePath: string): PlayerInvocation {
  if (plat === "darwin") return { args: [filePath], cmd: "afplay" };
  if (plat === "win32") {
    // SoundPlayer is the only dependency-free synchronous player on a stock
    // Windows box; it is wav-only, which is why synthesizeAndPlay requests
    // wav on win32. Single quotes in a PS single-quoted string escape as ''.
    const escaped = filePath.replace(/'/g, "''");
    return {
      args: ["-NoProfile", "-Command", `(New-Object Media.SoundPlayer '${escaped}').PlaySync()`],
      cmd: "powershell"
    };
  }
  return { args: [filePath], cmd: "aplay" };
}

export function playInvocationWithWatchdog(
  invocation: PlayerInvocation,
  spawnFn: typeof spawn = spawn
): Promise<void> {
  return runPlayerWithWatchdog(invocation.cmd, invocation.args, spawnFn);
}
```

Refactor the body of `playAudioWithWatchdog` into a private `runPlayerWithWatchdog(player: string, args: readonly string[], spawnFn)` (identical logic; the only change is `spawnFn(player, [...args], …)` instead of `spawnFn(player, [filePath], …)`), and keep the existing export as a thin wrapper so no caller breaks:

```ts
export async function playAudioWithWatchdog(
  player: string,
  filePath: string,
  spawnFn: typeof spawn = spawn
): Promise<void> {
  return runPlayerWithWatchdog(player, [filePath], spawnFn);
}
```

Replace `defaultSpeakerShells` (voice-playback.ts:162):

```ts
function defaultSpeakerShells(): SpeakerShells {
  return {
    playAudio: (filePath) => playInvocationWithWatchdog(resolveAudioPlayerInvocation(platform, filePath))
  };
}
```

In `synthesizeAndPlay` (:37), default the requested format to wav on win32 when unspecified:

```ts
  const synth = await tts.synthesize({
    text: options.text,
    ...(options.voice ? { voice: options.voice } : {}),
    ...(options.format
      ? { format: options.format }
      : platform === "win32" ? { format: "wav" } : {})
  });
```

- [ ] **Step 4: Update the two other selection sites**

`apps/cli/src/commands-brief.ts:154` — replace

```ts
const player = options.playerCommand ?? (platform() === "darwin" ? "afplay" : "aplay");
```

with (keeping the `playerCommand` override contract: an explicit override still spawns `<override> <file>`):

```ts
const invocation = options.playerCommand
  ? { args: [audioFile], cmd: options.playerCommand }
  : resolveAudioPlayerInvocation(platform(), audioFile);
```

and route the subsequent play call through `playInvocationWithWatchdog(invocation)`. Read the surrounding function first and preserve its error handling; if the site uses a different play helper, adapt minimally — the contract is "selection goes through `resolveAudioPlayerInvocation`".

`apps/cli/src/commands-listen.ts:279` — same substitution pattern for

```ts
const player = platform === "darwin" ? "afplay" : "aplay";
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @muse/cli test -- voice-playback && pnpm test:changed`
Expected: PASS, no related regressions.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/voice-playback.ts apps/cli/src/voice-playback.test.ts apps/cli/src/commands-brief.ts apps/cli/src/commands-listen.ts
git commit -m "feat(cli): win32 audio playback — PowerShell SoundPlayer + wav default"
git push
```

---

### Task 5: Secrets chain skips the keychain source off-darwin

**Files:**
- Modify: `packages/calendar/src/credential-resolver.ts:52`
- Test: extend `packages/calendar/test/credential-resolver.test.ts` (exists; follow its fake-store idiom)

**Interfaces:**
- Consumes: `CalendarSecretSourceOptions` (existing).
- Produces: `CalendarSecretSourceOptions` gains `readonly platform?: NodeJS.Platform` (test seam); default keychain inclusion becomes darwin-only.

**Why:** `resolveSecret` already swallows a failing source, so today Windows would spawn a nonexistent `/usr/bin/security` on every lookup and eat the error. Skipping construction off-darwin is the honest chain (matches `secretSourcesCheck`, which already reports keychain as darwin-only). Explicit `useKeychain: true` still forces inclusion (tests rely on injected mock runners).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

import { createCalendarSecretSources } from "../src/credential-resolver.js";

const fakeStore = { load: async () => undefined, save: async () => {} } as never;

describe("createCalendarSecretSources platform gating", () => {
  it("darwin chain is env → keychain → store (unchanged)", () => {
    const ids = createCalendarSecretSources(fakeStore, { platform: "darwin" }).map((s) => s.id);
    expect(ids).toEqual(["env", "keychain", "calendar-store"]);
  });

  it("win32 chain omits the keychain source", () => {
    const ids = createCalendarSecretSources(fakeStore, { platform: "win32" }).map((s) => s.id);
    expect(ids).toEqual(["env", "calendar-store"]);
  });

  it("explicit useKeychain: true includes it regardless of platform", () => {
    const ids = createCalendarSecretSources(fakeStore, { platform: "win32", useKeychain: true }).map((s) => s.id);
    expect(ids).toContain("keychain");
  });
});
```

(Source ids verified in `packages/secrets/src/sources/*`: `"env"`, `"keychain"`, and the store id is the string passed to `createStoreSource` — `"calendar-store"` here.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @muse/calendar test -- credential-resolver`
Expected: FAIL — `platform` option unknown / win32 chain still has 3 sources.

- [ ] **Step 3: Implement**

In `credential-resolver.ts`, extend the options and gate:

```ts
export interface CalendarSecretSourceOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly keychain?: SecretSource;
  /** Include the OS keychain source. Default: only on darwin (the binary exists nowhere else). */
  readonly useKeychain?: boolean;
  /** Test seam. */
  readonly platform?: NodeJS.Platform;
}
```

```ts
  const includeKeychain = options.useKeychain ?? (options.platform ?? process.platform) === "darwin";
  if (includeKeychain) {
    sources.push(
      options.keychain ?? createKeychainSource({ service: () => CALENDAR_KEYCHAIN_SERVICE })
    );
  }
```

(Also update the module doc-comment's chain description to say the keychain link is darwin-only.)

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @muse/calendar test -- credential-resolver && pnpm test:changed`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/calendar/src/credential-resolver.ts <test file>
git commit -m "fix(calendar): keychain secret source is darwin-only in the default chain"
git push
```

---

### Task 6: Daemon autostart on win32 via schtasks

**Files:**
- Create: `apps/cli/src/commands-daemon-schtasks.ts`
- Create: `apps/cli/src/commands-daemon-schtasks.test.ts`
- Modify: `apps/cli/src/commands-daemon-register.ts` (`--install` handler at :207, `--status` autostart line at :411; `DaemonHelpers` interface)

**Interfaces:**
- Consumes: `DaemonHelpers` (existing test-seam pattern), `ProgramIO`.
- Produces:

```ts
// commands-daemon-schtasks.ts
export const SCHTASKS_TASK_NAME = "MuseDaemon";
export function buildSchtasksCreateArgs(opts: { readonly taskName: string; readonly programArguments: readonly string[] }): readonly string[];
export function buildSchtasksDeleteArgs(taskName: string): readonly string[];
export function buildSchtasksQueryArgs(taskName: string): readonly string[];
```

and `DaemonHelpers` gains:

```ts
  /** Test seam — runs `schtasks` with an argv array on win32 --install/--status. */
  readonly schtasksRun?: (args: readonly string[]) => Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
  /** Test seam — platform override for the --install / --status branches. */
  readonly platform?: NodeJS.Platform;
```

- [ ] **Step 1: Write the failing tests** (`commands-daemon-schtasks.test.ts`)

```ts
import { describe, expect, it } from "vitest";

import { buildSchtasksCreateArgs, buildSchtasksDeleteArgs, buildSchtasksQueryArgs, SCHTASKS_TASK_NAME } from "./commands-daemon-schtasks.js";

describe("schtasks arg builders", () => {
  it("create registers an ONLOGON task with the quoted program line", () => {
    const args = buildSchtasksCreateArgs({
      programArguments: ["C:\\Program Files\\nodejs\\node.exe", "C:\\muse\\cli.js", "daemon"],
      taskName: SCHTASKS_TASK_NAME
    });
    expect(args).toEqual([
      "/Create", "/F", "/SC", "ONLOGON", "/TN", "MuseDaemon",
      "/TR", '"C:\\Program Files\\nodejs\\node.exe" "C:\\muse\\cli.js" daemon'
    ]);
  });

  it("space-free arguments stay unquoted", () => {
    const args = buildSchtasksCreateArgs({ programArguments: ["node", "cli.js", "daemon"], taskName: "T" });
    expect(args[args.indexOf("/TR") + 1]).toBe("node cli.js daemon");
  });

  it("delete and query target the task by name", () => {
    expect(buildSchtasksDeleteArgs("MuseDaemon")).toEqual(["/Delete", "/F", "/TN", "MuseDaemon"]);
    expect(buildSchtasksQueryArgs("MuseDaemon")).toEqual(["/Query", "/TN", "MuseDaemon"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @muse/cli test -- commands-daemon-schtasks`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `commands-daemon-schtasks.ts`**

```ts
/**
 * Windows autostart wiring for the resident `muse daemon` — the schtasks
 * counterpart of the macOS LaunchAgent plist. Pure argv builders: the argv
 * ARRAY goes to execFile (no shell), so paths are inert arguments; quoting
 * below is only what schtasks itself needs inside its /TR program line.
 */

export const SCHTASKS_TASK_NAME = "MuseDaemon";

function quoteForTaskRun(arg: string): string {
  return /\s/.test(arg) ? `"${arg}"` : arg;
}

export function buildSchtasksCreateArgs(opts: {
  readonly taskName: string;
  readonly programArguments: readonly string[];
}): readonly string[] {
  const taskRun = opts.programArguments.map(quoteForTaskRun).join(" ");
  return ["/Create", "/F", "/SC", "ONLOGON", "/TN", opts.taskName, "/TR", taskRun];
}

export function buildSchtasksDeleteArgs(taskName: string): readonly string[] {
  return ["/Delete", "/F", "/TN", taskName];
}

export function buildSchtasksQueryArgs(taskName: string): readonly string[] {
  return ["/Query", "/TN", taskName];
}
```

- [ ] **Step 4: Run to verify builders pass**

Run: `pnpm --filter @muse/cli test -- commands-daemon-schtasks`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire `--install` and `--status`**

In `commands-daemon-register.ts`, add the two `DaemonHelpers` seams from the Interfaces block, a default runner:

```ts
import { execFile } from "node:child_process";
import { buildSchtasksCreateArgs, buildSchtasksQueryArgs, SCHTASKS_TASK_NAME } from "./commands-daemon-schtasks.js";

const defaultSchtasksRun = (args: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile("schtasks", [...args], { timeout: 15_000 }, (error, stdout, stderr) => {
      const exitCode = error && typeof (error as NodeJS.ErrnoException).code !== "string"
        ? ((error as { code?: number }).code ?? 1)
        : error ? 1 : 0;
      resolve({ exitCode, stderr: stderr.toString(), stdout: stdout.toString() });
    });
  });
```

then branch the `--install` handler (:207) BEFORE the plist path:

```ts
      if (options.install) {
        const plat = helpers.platform ?? process.platform;
        const cliEntry = process.argv[1] ?? "muse";
        if (plat === "win32") {
          const run = helpers.schtasksRun ?? defaultSchtasksRun;
          const result = await run(buildSchtasksCreateArgs({
            programArguments: [process.execPath, cliEntry, "daemon"],
            taskName: SCHTASKS_TASK_NAME
          }));
          if (result.exitCode === 0) {
            io.stdout(`muse daemon registered as scheduled task '${SCHTASKS_TASK_NAME}' (runs at logon)\n  remove with:  schtasks /Delete /F /TN ${SCHTASKS_TASK_NAME}\n`);
          } else {
            io.stderr(`schtasks failed (exit ${result.exitCode.toString()}): ${result.stderr.trim() || result.stdout.trim()}\n`);
            process.exitCode = 1;
          }
          return;
        }
        if (plat !== "darwin") {
          io.stderr(`daemon autostart install is supported on macOS (LaunchAgent) and Windows (schtasks) — on this platform run \`muse daemon\` under your init system directly.\n`);
          process.exitCode = 1;
          return;
        }
        // …existing plist branch unchanged (drop its own `const cliEntry` line)…
```

and the `--status` autostart line (:411) becomes platform-aware:

```ts
        const plat = helpers.platform ?? process.platform;
        if (plat === "win32") {
          const run = helpers.schtasksRun ?? defaultSchtasksRun;
          const query = await run(buildSchtasksQueryArgs(SCHTASKS_TASK_NAME));
          io.stdout(query.exitCode === 0
            ? `autostart:    installed (scheduled task ${SCHTASKS_TASK_NAME})\n`
            : `autostart:    not installed (run \`muse daemon --install\`)\n`);
        } else {
          const plistFile = resolveLaunchAgentFile(e);
          io.stdout(existsSync(plistFile)
            ? `autostart:    installed (${plistFile})\n`
            : `autostart:    not installed (run \`muse daemon --install\`)\n`);
        }
```

- [ ] **Step 6: Add the wiring tests** (append to `commands-daemon-schtasks.test.ts` or the existing `commands-daemon.test.ts`, following how that file builds the program + io fakes — read it first and copy its harness idiom)

Assert, driving `muse daemon --install` with `helpers.platform = "win32"` and a capturing `schtasksRun` fake:
1. the fake received exactly `buildSchtasksCreateArgs(...)`'s argv (deep-equal),
2. **no plist file was written** (the darwin path did not run),
3. a failing fake (`exitCode: 1`) sets `process.exitCode = 1` and prints the stderr detail — no partial side-effect.

- [ ] **Step 7: Run tests**

Run: `pnpm --filter @muse/cli test -- commands-daemon && pnpm test:changed`
Expected: PASS, existing daemon tests untouched.

- [ ] **Step 8: Commit**

```bash
git add apps/cli/src/commands-daemon-schtasks.ts apps/cli/src/commands-daemon-schtasks.test.ts apps/cli/src/commands-daemon-register.ts
git commit -m "feat(cli): muse daemon --install registers a schtasks ONLOGON task on win32"
git push
```

---

### Task 7: Doctor platform posture + README Windows section

**Files:**
- Modify: `apps/cli/src/commands-doctor-checks.ts` (add check), `apps/cli/src/commands-doctor.ts` (wire it)
- Modify: `README.md`, `README.ko.md`
- Test: the existing doctor-checks test file (locate with `ls apps/cli/src/commands-doctor*`)

**Interfaces:**
- Consumes: `resolvePlatformCapabilities` from `@muse/shared` (Task 3), `LocalCheck` (existing).
- Produces: `export function platformPostureCheck(platform?: NodeJS.Platform): LocalCheck`.

- [ ] **Step 1: Write the failing test** (in the doctor-checks test file, matching its existing style)

```ts
import { platformPostureCheck } from "./commands-doctor-checks.js";

describe("platformPostureCheck", () => {
  it("darwin reports full posture as ok", () => {
    const check = platformPostureCheck("darwin");
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("audio=afplay");
    expect(check.detail).toContain("autostart=launchd");
    expect(check.detail).toContain("os-integrations=macos");
  });

  it("win32 reports the reduced posture honestly, still ok (fail-soft, not broken)", () => {
    const check = platformPostureCheck("win32");
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("audio=powershell");
    expect(check.detail).toContain("autostart=schtasks");
    expect(check.detail).toContain("os-integrations=none");
    expect(check.detail).toContain("CI-verified only");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @muse/cli test -- commands-doctor`
Expected: FAIL — `platformPostureCheck` not exported.

- [ ] **Step 3: Implement** (in `commands-doctor-checks.ts`)

```ts
import { resolvePlatformCapabilities } from "@muse/shared";

/**
 * Report which platform-dependent surfaces are active on this OS — the honesty
 * line for a non-mac box: absent integrations are DISABLED by design, not
 * broken. Windows support is proven by CI, not by a live machine — say so.
 */
export function platformPostureCheck(platform: NodeJS.Platform = process.platform): LocalCheck {
  const caps = resolvePlatformCapabilities(platform);
  const integrations = caps.osIntegrations === "macos"
    ? "os-integrations=macos (Notes/Reminders/Contacts mirrors available)"
    : "os-integrations=none (macOS-only mirrors disabled on this OS)";
  const provenance = caps.os === "win32" ? " — Windows paths are CI-verified only" : "";
  return {
    detail: `platform=${caps.os}: audio=${caps.audioPlayer ?? "none"}, autostart=${caps.daemonAutostart}, ${integrations}${provenance}`,
    name: "platform posture",
    status: "ok"
  };
}
```

Wire into `commands-doctor.ts` next to the other local checks (read how `secretSourcesCheck` is registered and add `platformPostureCheck()` the same way).

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @muse/cli test -- commands-doctor && pnpm test:changed`
Expected: PASS.

- [ ] **Step 5: README sections**

`README.md` — add a `## Windows` section (adapt placement to the existing TOC):

```markdown
## Windows

Muse core runs on Windows: the CLI, the API server, grounded recall, and the
local Ollama model ([Ollama for Windows](https://ollama.com/download/windows)).
Platform behavior is gated in CI on `windows-latest`; macOS-only integrations
(Apple Notes/Reminders mirrors, Contacts import, ambient window source, the
desktop companion) are disabled automatically — `muse doctor` shows the exact
posture for your OS.

- Autostart: `muse daemon --install` registers a `schtasks` logon task
  (LaunchAgent on macOS).
- Voice output uses PowerShell's wav player; recording needs
  [sox for Windows](https://sourceforge.net/projects/sox/) on PATH.
- Windows paths are CI-verified; report anything odd via issues.
```

`README.ko.md` — the same section in Korean.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/commands-doctor-checks.ts apps/cli/src/commands-doctor.ts <doctor test file> README.md README.ko.md
git commit -m "feat(cli): doctor platform-posture line + Windows README section"
git push
```

---

### Task 8: Finalize — green gate + PR ready

**Files:** PR metadata only.

- [ ] **Step 1: Confirm both CI jobs green on the PR**

Run: `gh pr checks --watch`
Expected: `check` ✓ and `check-windows` ✓ on the final commit. If `check-windows` regressed, return to the Task 2 loop.

- [ ] **Step 2: Lint gate**

Run: `cd /tmp/muse-windows-support && pnpm lint`
Expected: 0 errors, warnings not increased.

- [ ] **Step 3: Mark PR ready + summary**

```bash
gh pr ready
gh pr edit --body "<final summary: what ships, quarantined items, CI-verified-only caveats>"
```

Report to 진안: merged-scope summary, triage findings, quarantine list, and the Phase 2 (`@muse/windows`) / Phase 3 (desktop) hand-off notes.
