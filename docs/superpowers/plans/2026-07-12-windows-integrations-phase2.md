# @muse/windows Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `@muse/windows` — 7 stock-PowerShell native tools + a Windows active-window ambient source, registered dark-by-default behind `MUSE_WINDOWS_ACTUATORS`, contract-tested with REAL PowerShell on the windows-latest CI runner.

**Architecture:** Mirror `@muse/macos` file-for-file where the concept transfers: one injectable `runPowerShell` seam (script over stdin via `powershell -Command -`, timeout watchdog), one file per tool returning a `MuseTool`, fail-soft error mapping (typed result objects, never throws). Registration goes through the existing CLI actuator gate; the platform seam (`resolvePlatformCapabilities`) reports `osIntegrations: "windows"`.

**Tech Stack:** TypeScript strict, vitest, stock Windows PowerShell 5.1 (`-NoProfile -NonInteractive`), `System.Speech` / `System.Drawing` / `System.Windows.Forms` .NET types via `Add-Type`.

**Spec:** `docs/superpowers/specs/2026-07-12-windows-integrations-phase2-design.md`.

## Global Constraints

- Worktree `/tmp/muse-windows-phase2`, branch `windows-integrations`. Merge `origin/main` at every CI round (concurrent loops move main constantly).
- Zero third-party dependencies; PowerShell scripts must run on a stock Windows 11 / windows-latest runner.
- User text NEVER interpolates into a PowerShell script — pass it base64-encoded and decode inside the script (`[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('…'))`).
- Every tool: verb_noun name, "use when / do NOT use" description line, `required` args with example-bearing descriptions, correct `risk` (only `win_app_read` is `read`).
- Fail-soft: a tool failure returns `{ ok:false, reason }`-shaped JSON, never throws; spawn watchdog `POWERSHELL_TIMEOUT_MS = 30_000`.
- Per-edit gate `pnpm test:changed` (or the touched package's file filter); `pnpm lint` before each push; commits per green task (standing approval), push each round.
- Comment policy: WHY-only. No goal/round markers.
- macOS behavior byte-identical; nothing regresses `check` (ubuntu).

---

### Task 0: Worktree bootstrap + package scaffold

**Files:**
- Create: `packages/windows/package.json`, `packages/windows/tsconfig.json`
- Modify: root `tsconfig.json` (solution references — add `packages/windows`)

**Interfaces:**
- Produces: an empty `@muse/windows` workspace package that `pnpm --filter @muse/windows build` compiles.

- [ ] **Step 1: Scaffold** — `packages/windows/package.json`:

```json
{
  "name": "@muse/windows",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "scripts": { "build": "tsc -b", "test": "vitest run", "typecheck": "tsc -p tsconfig.json --noEmit" },
  "dependencies": { "@muse/shared": "workspace:*", "@muse/tools": "workspace:*" }
}
```

`packages/windows/tsconfig.json` — copy `packages/macos/tsconfig.json` verbatim (same references: `../shared`, `../tools`).

- [ ] **Step 2: Solution reference** — add `{ "path": "packages/windows" }` to the root `tsconfig.json` `references` array (keep alphabetical order if present).

- [ ] **Step 3:** `pnpm install` (registers the workspace), create `packages/windows/src/index.ts` with `export {};` placeholder, then `pnpm --filter @muse/windows build` → exits 0.

- [ ] **Step 4: Commit** — `feat(windows): scaffold @muse/windows workspace package [writeback: n/a]`

---

### Task 1: `windows-exec.ts` — the PowerShell runner seam

**Files:**
- Create: `packages/windows/src/windows-exec.ts`
- Create: `packages/windows/src/windows-exec.test.ts`

**Interfaces (everything later tasks consume):**

```ts
export interface WinCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}
export const POWERSHELL_TIMEOUT_MS = 30_000;
/** Runs a PowerShell script (over stdin). Injected in tests. */
export type WinPowerShellRunner = (script: string) => Promise<WinCommandResult>;
export const defaultPowerShellRunner: WinPowerShellRunner;
/** Encode user text for safe embedding: returns the PS expression that decodes it. */
export function psBase64Expr(text: string): string;
```

- [ ] **Step 1: Failing test** (`windows-exec.test.ts`):

```ts
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

import { POWERSHELL_TIMEOUT_MS, psBase64Expr, runPowerShellWith } from "./windows-exec.js";

interface FakeChild extends EventEmitter {
  stdout: EventEmitter; stderr: EventEmitter;
  stdin: { written: string[]; write(s: string): void; end(): void; on(): void };
  kill(sig?: string): boolean; killedWith?: string;
}
function fakeSpawn(): { spawnFn: typeof spawn; child: FakeChild } {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { written: [], write(s: string) { this.written.push(s); }, end() {}, on() {} } as never;
  child.kill = (sig?: string) => { child.killedWith = sig ?? "SIGTERM"; return true; };
  return { child, spawnFn: (() => child) as unknown as typeof spawn };
}

describe("runPowerShellWith", () => {
  it("spawns powershell -NoProfile -NonInteractive -Command - and pipes the script over stdin", async () => {
    const { child, spawnFn } = fakeSpawn();
    let spawnedBin = ""; let spawnedArgs: readonly string[] = [];
    const capture = ((bin: string, args: readonly string[]) => { spawnedBin = bin; spawnedArgs = args; return child; }) as unknown as typeof spawn;
    const p = runPowerShellWith("Get-Date", POWERSHELL_TIMEOUT_MS, capture);
    child.stdout.emit("data", Buffer.from("ok\n"));
    child.emit("close", 0);
    const r = await p;
    expect(spawnedBin).toBe("powershell.exe");
    expect(spawnedArgs).toEqual(["-NoProfile", "-NonInteractive", "-Command", "-"]);
    expect(child.stdin.written.join("")).toBe("Get-Date");
    expect(r).toEqual({ exitCode: 0, stderr: "", stdout: "ok\n", timedOut: false });
    void spawnFn;
  });

  it("SIGKILLs a wedged powershell and resolves timedOut", async () => {
    const { child } = fakeSpawn();
    const p = runPowerShellWith("Start-Sleep 999", 20, (() => child) as unknown as typeof spawn);
    const r = await p;
    expect(r.timedOut).toBe(true);
    expect(child.killedWith).toBe("SIGKILL");
  });
});

describe("psBase64Expr", () => {
  it("round-trips arbitrary text (quotes, $, newlines, Korean) through base64", () => {
    const expr = psBase64Expr(`hi "$(rm)" 진안\nline2`);
    expect(expr).toMatch(/^\[System\.Text\.Encoding\]::UTF8\.GetString\(\[Convert\]::FromBase64String\('[A-Za-z0-9+/=]+'\)\)$/u);
    const b64 = /'([A-Za-z0-9+/=]+)'/u.exec(expr)![1]!;
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe(`hi "$(rm)" 진안\nline2`);
  });
});
```

- [ ] **Step 2:** `cd packages/windows && npx vitest run windows-exec` → FAIL (module missing).

- [ ] **Step 3: Implement** (`windows-exec.ts`) — the spawn body follows `runChild` in `packages/macos/src/macos-exec.ts` (same watchdog / once-only decode / EPIPE-swallow discipline; read it before writing):

```ts
import { spawn } from "node:child_process";

export interface WinCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

export const POWERSHELL_TIMEOUT_MS = 30_000;

export type WinPowerShellRunner = (script: string) => Promise<WinCommandResult>;

export function runPowerShellWith(
  script: string,
  timeoutMs: number,
  spawnImpl: typeof spawn = spawn
): Promise<WinCommandResult> {
  return new Promise((resolve, reject) => {
    // `-Command -` reads the script from stdin: no argv-length ceiling, and
    // nothing in the script ever passes through cmd/PowerShell argv parsing.
    const child = spawnImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    // Without the watchdog a wedged PowerShell (a hung CIM query, a blocked
    // Add-Type compile) parks the agent turn forever.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => resolve({
        exitCode: null,
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        timedOut: true
      }));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdoutChunks.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderrChunks.push(chunk); });
    child.on("error", (error) => { finish(() => reject(error)); });
    child.on("close", (code) => {
      finish(() => resolve({
        exitCode: code,
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        timedOut: false
      }));
    });
    child.stdin.on("error", () => { /* surfaced via child 'error'/'close' */ });
    child.stdin.write(script);
    child.stdin.end();
  });
}

export const defaultPowerShellRunner: WinPowerShellRunner = (script) =>
  runPowerShellWith(script, POWERSHELL_TIMEOUT_MS);

/**
 * User text never interpolates into a script: embed it as base64 and decode
 * inside PowerShell, so quotes/`$()`/backticks in the text stay inert data.
 */
export function psBase64Expr(text: string): string {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  return `[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))`;
}
```

Update `src/index.ts`: `export { defaultPowerShellRunner, POWERSHELL_TIMEOUT_MS, psBase64Expr, runPowerShellWith, type WinCommandResult, type WinPowerShellRunner } from "./windows-exec.js";`

- [ ] **Step 4:** `npx vitest run windows-exec` → PASS (3 tests). `pnpm --filter @muse/windows build` → 0.

- [ ] **Step 5: Commit** — `feat(windows): PowerShell runner seam — stdin transport, watchdog, base64 text embedding`

---

### Task 2: `win_app_open` + `win_app_read`

**Files:**
- Create: `packages/windows/src/windows-app-open-tool.ts`, `packages/windows/src/windows-app-read-tool.ts`
- Create: `packages/windows/src/windows-app-open-tool.test.ts`, `packages/windows/src/windows-app-read-tool.test.ts`
- Modify: `packages/windows/src/index.ts` (exports)

**Interfaces:**
- Consumes: `WinPowerShellRunner`, `defaultPowerShellRunner`, `psBase64Expr` (Task 1).
- Produces:

```ts
export interface WindowsToolDeps { readonly runner?: WinPowerShellRunner; }
export function createWinAppOpenTool(deps?: WindowsToolDeps): MuseTool;   // name "win_app_open", risk "execute"
export function createWinAppReadTool(deps?: WindowsToolDeps): MuseTool;   // name "win_app_read", risk "read"
export const WIN_APP_READ_SOURCES = ["battery", "wifi", "storage", "frontmost"] as const;
```

Model both on `packages/macos/src/macos-app-open-tool.ts` / `macos-app-read-tool.ts` — read those files first; the description/keywords/schema discipline transfers verbatim with mac→windows wording.

- [ ] **Step 1: Failing tests.** `windows-app-open-tool.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createWinAppOpenTool } from "./windows-app-open-tool.js";
import type { WinCommandResult } from "./windows-exec.js";

const ok: WinCommandResult = { exitCode: 0, stderr: "", stdout: "", timedOut: false };
const capture = () => {
  const scripts: string[] = [];
  return { runner: async (s: string) => { scripts.push(s); return ok; }, scripts };
};

describe("win_app_open", () => {
  it("opens a URL via Start-Process with the target base64-embedded (never interpolated)", async () => {
    const { runner, scripts } = capture();
    const out = await createWinAppOpenTool({ runner }).execute({ target: "https://example.com/x?a=1&b='2'" }, { runId: "t" });
    expect(out).toMatchObject({ opened: true });
    expect(scripts[0]).toContain("Start-Process");
    expect(scripts[0]).toContain("FromBase64String");
    expect(scripts[0]).not.toContain("example.com"); // raw text must not appear in the script
  });

  it("refuses an empty target without spawning", async () => {
    const { runner, scripts } = capture();
    const out = await createWinAppOpenTool({ runner }).execute({ target: "  " }, { runId: "t" });
    expect(out).toMatchObject({ opened: false });
    expect(scripts).toHaveLength(0);
  });

  it("maps a non-zero exit to opened:false with the stderr tail", async () => {
    const out = await createWinAppOpenTool({
      runner: async () => ({ exitCode: 1, stderr: "The system cannot find the file zzz.", stdout: "", timedOut: false })
    }).execute({ target: "zzz" }, { runId: "t" });
    expect(out).toMatchObject({ opened: false });
    expect((out as { reason: string }).reason).toContain("cannot find");
  });
});
```

`windows-app-read-tool.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createWinAppReadTool, WIN_APP_READ_SOURCES } from "./windows-app-read-tool.js";
import type { WinCommandResult } from "./windows-exec.js";

const result = (stdout: string): WinCommandResult => ({ exitCode: 0, stderr: "", stdout, timedOut: false });

describe("win_app_read", () => {
  it("declares the source enum", () => {
    const tool = createWinAppReadTool();
    const props = tool.definition.inputSchema.properties as Record<string, { enum?: readonly string[] }>;
    expect(props["source"]!.enum).toEqual([...WIN_APP_READ_SOURCES]);
  });

  it("battery parses percent + charging", async () => {
    const out = await createWinAppReadTool({ runner: async () => result("87\tTRUE\n") })
      .execute({ source: "battery" }, { runId: "t" });
    expect(out).toMatchObject({ charging: true, percent: 87, source: "battery" });
  });

  it("frontmost returns the window title line", async () => {
    const out = await createWinAppReadTool({ runner: async () => result("report.docx - Word\n") })
      .execute({ source: "frontmost" }, { runId: "t" });
    expect(out).toMatchObject({ source: "frontmost", window: "report.docx - Word" });
  });

  it("an unknown source is refused without spawning; a failed spawn is fail-soft", async () => {
    let called = 0;
    const tool = createWinAppReadTool({ runner: async () => { called += 1; return result(""); } });
    const bad = await tool.execute({ source: "registry" }, { runId: "t" });
    expect(bad).toMatchObject({ ok: false });
    expect(called).toBe(0);
    const failing = createWinAppReadTool({ runner: async () => { throw new Error("spawn ENOENT"); } });
    const out = await failing.execute({ source: "battery" }, { runId: "t" });
    expect(out).toMatchObject({ ok: false });
  });
});
```

- [ ] **Step 2:** `npx vitest run windows-app` → FAIL (modules missing).

- [ ] **Step 3: Implement.** `windows-app-open-tool.ts`:

```ts
import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import { defaultPowerShellRunner, POWERSHELL_TIMEOUT_MS, psBase64Expr, type WinPowerShellRunner } from "./windows-exec.js";

export interface WindowsToolDeps {
  readonly runner?: WinPowerShellRunner;
}

export function createWinAppOpenTool(deps: WindowsToolDeps = {}): MuseTool {
  const runner = deps.runner ?? defaultPowerShellRunner;
  return {
    definition: {
      description:
        "Open an app, a URL (in the default browser), or a file on this Windows PC. Use when the user asks to " +
        "open / launch an app, open a link or website, or open a document — e.g. 'open Notepad', " +
        "'open https://news.example.com', 'open my report.pdf', '메모장 열어줘', '이 링크 열어줘'. Pass the " +
        "thing to open as `target`; set `app` only to force which app opens it. " +
        "Do NOT use it to act on a web page's content like submitting a form (use web_action).",
      domain: "system",
      groundedArgs: ["target", "app"],
      inputSchema: {
        additionalProperties: false,
        properties: {
          app: { description: "Optional app to open the target IN, e.g. 'chrome' for a URL. Omit to use the default.", type: "string" },
          target: { description: "What to open: an app name ('notepad'), a URL ('https://example.com'), or a file path ('C:\\\\Users\\\\me\\\\report.pdf').", type: "string" }
        },
        required: ["target"],
        type: "object"
      },
      keywords: ["open", "열어", "열기", "띄워", "launch", "url", "link", "링크", "website", "사이트"],
      name: "win_app_open",
      risk: "execute"
    },
    execute: async (args): Promise<JsonObject> => {
      const target = typeof args["target"] === "string" ? args["target"].trim() : "";
      if (target.length === 0) {
        return { opened: false, reason: "win_app_open requires a non-empty 'target' (an app, URL, or file)" };
      }
      const app = typeof args["app"] === "string" ? args["app"].trim() : "";
      const script = app.length > 0
        ? `Start-Process -FilePath (${psBase64Expr(app)}) -ArgumentList @(${psBase64Expr(target)})`
        : `Start-Process -FilePath (${psBase64Expr(target)})`;
      try {
        const result = await runner(script);
        if (result.timedOut) return { opened: false, reason: `Start-Process timed out after ${POWERSHELL_TIMEOUT_MS.toString()}ms` };
        if (result.exitCode !== 0) {
          const stderr = result.stderr.trim();
          return { opened: false, reason: stderr.length > 0 ? stderr.slice(0, 300) : `powershell exited with code ${result.exitCode?.toString() ?? "null"}` };
        }
        return { opened: true, target, ...(app.length > 0 ? { app } : {}) };
      } catch (cause) {
        return { opened: false, reason: `powershell spawn failed: ${cause instanceof Error ? cause.message : String(cause)}` };
      }
    }
  };
}
```

`windows-app-read-tool.ts` — same deps shape; sources map to scripts:

```ts
import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import { defaultPowerShellRunner, POWERSHELL_TIMEOUT_MS, type WinPowerShellRunner } from "./windows-exec.js";
import type { WindowsToolDeps } from "./windows-app-open-tool.js";

export const WIN_APP_READ_SOURCES = ["battery", "wifi", "storage", "frontmost"] as const;
type WinReadSource = (typeof WIN_APP_READ_SOURCES)[number];

const READ_SCRIPTS: Readonly<Record<WinReadSource, string>> = {
  battery: "$b = Get-CimInstance Win32_Battery; if ($b) { \"$($b.EstimatedChargeRemaining)`t$($b.BatteryStatus -eq 2)\" }",
  frontmost: [
    "Add-Type @'",
    "using System; using System.Runtime.InteropServices; using System.Text;",
    "public class FG { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
    "[DllImport(\"user32.dll\")] public static extern int GetWindowText(IntPtr h, StringBuilder t, int c); }",
    "'@",
    "$h = [FG]::GetForegroundWindow(); $sb = New-Object System.Text.StringBuilder 512",
    "[void][FG]::GetWindowText($h, $sb, $sb.Capacity); $sb.ToString()"
  ].join("\n"),
  storage: "Get-PSDrive -PSProvider FileSystem | ForEach-Object { \"$($_.Name)`t$([math]::Round($_.Free/1GB,1))`t$([math]::Round(($_.Used+$_.Free)/1GB,1))\" }",
  wifi: "(netsh wlan show interfaces) -match '^\\s*SSID' | Select-Object -First 1"
};

export function createWinAppReadTool(deps: WindowsToolDeps = {}): MuseTool {
  const runner = deps.runner ?? defaultPowerShellRunner;
  return {
    definition: {
      description:
        "Read one live system fact from this Windows PC: battery level, current wifi network, free disk storage, " +
        "or the frontmost window title. Use when the user asks 'how much battery', 'what wifi am I on', " +
        "'how much disk space', '배터리 몇 프로야', '무슨 창 보고 있어'. Read-only. " +
        "Do NOT use it to open or change anything (use win_app_open / win_system_set).",
      domain: "system",
      inputSchema: {
        additionalProperties: false,
        properties: {
          source: { description: "Which fact to read, e.g. 'battery'.", enum: [...WIN_APP_READ_SOURCES], type: "string" }
        },
        required: ["source"],
        type: "object"
      },
      keywords: ["battery", "배터리", "wifi", "와이파이", "storage", "disk", "용량", "window", "창"],
      name: "win_app_read",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const source = typeof args["source"] === "string" ? args["source"].trim() : "";
      if (!(WIN_APP_READ_SOURCES as readonly string[]).includes(source)) {
        return { ok: false, reason: `unknown source '${source}' — valid: ${WIN_APP_READ_SOURCES.join(", ")}` };
      }
      try {
        const result = await runner(READ_SCRIPTS[source as WinReadSource]);
        if (result.timedOut) return { ok: false, reason: `read timed out after ${POWERSHELL_TIMEOUT_MS.toString()}ms`, source };
        if (result.exitCode !== 0) return { ok: false, reason: result.stderr.trim().slice(0, 300) || "powershell failed", source };
        return parseReadOutput(source as WinReadSource, result.stdout);
      } catch (cause) {
        return { ok: false, reason: `powershell spawn failed: ${cause instanceof Error ? cause.message : String(cause)}`, source };
      }
    }
  };
}

export function parseReadOutput(source: WinReadSource, stdout: string): JsonObject {
  const text = stdout.trim();
  if (source === "battery") {
    const [pct, charging] = text.split("\t");
    const percent = Number.parseInt(pct ?? "", 10);
    if (!Number.isFinite(percent)) return { ok: false, reason: "no battery detected (desktop PC?)", source };
    return { charging: /true/iu.test(charging ?? ""), ok: true, percent, source };
  }
  if (source === "frontmost") {
    return text.length > 0 ? { ok: true, source, window: text } : { ok: false, reason: "no foreground window", source };
  }
  if (source === "wifi") {
    const ssid = /SSID\s*:\s*(.+)$/mu.exec(text)?.[1]?.trim();
    return ssid ? { ok: true, source, ssid } : { ok: false, reason: "not connected to wifi", source };
  }
  const drives = text.split("\n").filter(Boolean).map((line) => {
    const [name, freeGb, totalGb] = line.split("\t");
    return { freeGb: Number.parseFloat(freeGb ?? "0"), name: name ?? "?", totalGb: Number.parseFloat(totalGb ?? "0") };
  });
  return drives.length > 0 ? { drives, ok: true, source } : { ok: false, reason: "no drives reported", source };
}
```

Export both from `index.ts` (+ `WIN_APP_READ_SOURCES`, `parseReadOutput`, `WindowsToolDeps`).

- [ ] **Step 4:** `npx vitest run windows-app` → PASS. Build → 0.
- [ ] **Step 5: Commit** — `feat(windows): win_app_open + win_app_read (Start-Process, battery/wifi/storage/frontmost)`

---

### Task 3: `win_clipboard_set`, `win_say`, `win_screenshot`

**Files:**
- Create: `packages/windows/src/windows-utility-tools.ts` (clipboard + say — mirrors `macos-utility-tools.ts` grouping)
- Create: `packages/windows/src/windows-screen-tools.ts` + `packages/windows/src/windows-screen-path.ts`
- Create: `packages/windows/src/windows-utility-tools.test.ts`, `packages/windows/src/windows-screen-tools.test.ts`
- Modify: `packages/windows/src/index.ts`

**Interfaces:**
- Consumes: Task 1 seam + `WindowsToolDeps` (Task 2).
- Produces: `createWinClipboardSetTool(deps?)`, `createWinSayTool(deps?)`, `createWinScreenshotTool(deps?)`, `resolveWindowsScreenshotPath(raw: string | undefined, env?: NodeJS.ProcessEnv): { ok: true; path: string } | { ok: false; reason: string }`.

Scripts (the implementer verifies against the test expectations below):

- clipboard: `Set-Clipboard -Value (${psBase64Expr(text)})`
- say: `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak((${psBase64Expr(text)}))`
- screenshot:

```
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save((<psBase64Expr(path)>), [System.Drawing.Imaging.ImageFormat]::Png)
```

`resolveWindowsScreenshotPath` — read `packages/macos/src/macos-screen-path.ts` FIRST and mirror its contract exactly (default filename `muse-screenshot-<ISO-ish stamp>.png`; allowed roots = `os.tmpdir()` and `join(homedir(), "Pictures")`; a caller path outside the roots or with a non-`.png` extension → `{ ok:false, reason }`). Path comparison must survive win32 separators (resolve both sides; compare with `path.relative` not string prefix — the Phase 1 lesson).

- [ ] **Step 1: Failing tests.** `windows-utility-tools.test.ts` asserts: (a) clipboard script contains `Set-Clipboard` + `FromBase64String` and NOT the raw text; (b) empty text refused without spawning; (c) say script contains `SpeechSynthesizer` + base64; (d) fail-soft on runner throw. `windows-screen-tools.test.ts` asserts: (a) default path lands under tmpdir with `.png`; (b) explicit path under `~/Pictures` accepted, path outside roots refused BEFORE spawning; (c) `.jpg` extension refused; (d) the script embeds the resolved path via base64 and saves PNG; (e) success returns `{ captured: true, path }`. Write them in the Task 2 test style (capture runner, `toMatchObject`).

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (descriptions follow the tool-calling.md formula; `win_clipboard_set` risk "write", keywords `["clipboard", "복사", "클립보드", "copy"]`; `win_say` risk "write", keywords `["say", "speak", "말해", "읽어줘", "tts"]`; `win_screenshot` risk "write", keywords `["screenshot", "스크린샷", "캡처", "capture", "screen"]`). **Step 4:** Run → PASS; build → 0.

- [ ] **Step 5: Commit** — `feat(windows): clipboard/say/screenshot tools with sandboxed PNG paths`

---

### Task 4: `win_media_control` + `win_system_set`

**Files:**
- Create: `packages/windows/src/windows-media-tool.ts`, `packages/windows/src/windows-system-set-tool.ts` (+ matching `.test.ts` files)
- Modify: `packages/windows/src/index.ts`

**Interfaces:**
- Produces: `createWinMediaControlTool(deps?)` (`action` enum `["playpause","next","previous"]`), `createWinSystemSetTool(deps?)` (`setting` enum `["volume_up","volume_down","mute","display_sleep"]`).

Key events go through one shared snippet (keybd_event via Add-Type; virtual keys: `0xB3` playpause, `0xB0` next, `0xB1` previous, `0xAF` vol-up, `0xAE` vol-down, `0xAD` mute):

```
Add-Type @'
using System; using System.Runtime.InteropServices;
public class KB { [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, int f, int e); }
'@
[KB]::keybd_event(<vk>, 0, 0, 0); [KB]::keybd_event(<vk>, 0, 2, 0)
```

`display_sleep`: `(Add-Type '[DllImport("user32.dll")]public static extern int SendMessage(int h,int m,int w,int l);' -Name NM -PassThru)::SendMessage(0xffff, 0x0112, 0xf170, 2)`.

- [ ] **Step 1: Failing tests** (same capture-runner style): action/setting enums declared; each action embeds the right VK hex constant in the script; unknown action refused without spawn; fail-soft mapping; `<vk>` values asserted literally (e.g. media playpause script contains `0xB3`).
- [ ] **Step 2:** FAIL → **Step 3:** implement (descriptions: media "Use when the user asks to pause/skip music… Do NOT use to open a music app (win_app_open)"; system_set "Use when the user asks to change volume / mute / put the display to sleep… Do NOT use for media transport (win_media_control)") → **Step 4:** PASS + build.
- [ ] **Step 5: Commit** — `feat(windows): media transport + system volume/display tools (key events)`

---

### Task 5: `WindowsActiveWindowSource` (ambient parity)

**Files:**
- Create: `packages/proactivity/src/windows-ambient-source.ts`
- Create: `packages/proactivity/test/windows-ambient-source.test.ts`
- Modify: `packages/proactivity/src/index.ts` (export), `apps/cli/src/commands-daemon-register.ts` (source selection)

**Interfaces:**
- Consumes: `AmbientSignal`, `AmbientSignalSource` from `./ambient-notice-loop.js`.
- Produces: `class WindowsActiveWindowSource implements AmbientSignalSource` with options `{ run?: (script: string) => Promise<string | undefined>; timeoutMs?: number; includeClipboard?: boolean }` and exported `parseWindowsActiveWindow(stdout: string | undefined): AmbientSignal | undefined`.

Model on `packages/proactivity/src/macos-ambient-source.ts` (read it first): the PS script prints `<process name>\n<window title>` (frontmost via the Task 2 `FG` snippet + `Get-Process -Id (pid from GetWindowThreadProcessId)`); clipboard line 3 via `Get-Clipboard` only when `includeClipboard` (same opt-in semantics as macOS). Parser mirrors `parseActiveWindowSignal` (empty app → undefined; window optional).

Daemon selection in `commands-daemon-register.ts` — extend the existing block:

```ts
const useMacos = e.MUSE_AMBIENT_SOURCE?.trim() === "macos"
  && (helpers.ambientMacosRun !== undefined || process.platform === "darwin");
const useWindows = e.MUSE_AMBIENT_SOURCE?.trim() === "windows"
  && (helpers.ambientMacosRun !== undefined || process.platform === "win32");
```

(reuse the SAME `ambientMacosRun` test seam — it is just an injected script runner; rename is out of scope) → `new WindowsActiveWindowSource({ includeClipboard: parseBoolean(e.MUSE_AMBIENT_CLIPBOARD, false), ...(helpers.ambientMacosRun ? { run: helpers.ambientMacosRun } : {}) })`.

- [ ] **Step 1: Failing tests:** parser (2-line, 3-line-with-clipboard, empty → undefined); source runs injected `run` and maps failure → undefined (never throws); daemon test (in `commands-daemon.test.ts` style) — `MUSE_AMBIENT_SOURCE=windows` + injected run + one matching rule delivers a notice.
- [ ] **Step 2-4:** FAIL → implement → PASS (`pnpm --filter @muse/proactivity build` + related cli tests).
- [ ] **Step 5: Commit** — `feat(proactivity): Windows active-window ambient source`

---

### Task 6: Registration + platform seam + doctor

**Files:**
- Modify: `apps/cli/src/actuator-tools.ts` (arming + construction), `packages/shared/src/platform-capabilities.ts` (+test), `apps/cli/src/commands-doctor-checks.ts` (+test), `README.md`, `README.ko.md`
- Test: extend `apps/cli/src/actuator-tools.test.ts`, `packages/shared/src/platform-capabilities.test.ts`, `apps/cli/src/commands-doctor-checks.test.ts`

**Interfaces:**
- Consumes: all 7 `createWin*Tool` factories (Tasks 2–4).
- Produces: `windowsActuatorsEnabled(env)` (same truthy grammar as `macActuatorsEnabled`); `PlatformCapabilities.osIntegrations` type widens to `"macos" | "windows" | "none"`.

Steps (each TDD, one commit at the end):

- [ ] **Step 1:** `platform-capabilities.ts`: win32 branch returns `osIntegrations: "windows"`; update the win32 test expectation (`osIntegrations: "none"` → `"windows"`); type widens.
- [ ] **Step 2:** `actuator-tools.ts`: add `windowsActuatorsEnabled` (copy `macActuatorsEnabled` with `MUSE_WINDOWS_ACTUATORS`); in the summary function arm `["win_app_open","win_app_read","win_clipboard_set","win_say","win_screenshot","win_media_control","win_system_set"]` when `windowsActuatorsEnabled(env) && process.platform === "win32"` (add a `platform` param defaulting to `process.platform` for tests — read how the mac branch is currently gated and mirror); in the tool-construction site (read around the `@muse/macos` import usage, ~line 482) add the parallel `@muse/windows` construction behind the same gate. `apps/cli/package.json` + `tsconfig.json` references gain `@muse/windows` (BOTH files — the build-graph rule).
- [ ] **Step 3:** doctor: `platformPostureCheck` win32 detail becomes `os-integrations=windows (PowerShell actuators; arm with MUSE_WINDOWS_ACTUATORS=true)`; update its test.
- [ ] **Step 4:** README + README.ko Windows sections: replace the "disabled automatically" integration sentence with the new actuator surface + opt-in flag + CI-verified-only note for media/volume.
- [ ] **Step 5:** `pnpm test:changed` green; `pnpm lint` 0. Commit — `feat(cli+shared): arm @muse/windows actuators behind MUSE_WINDOWS_ACTUATORS; seam + doctor report it`

---

### Task 7: Real-PowerShell contract tests (run on the windows-latest runner)

**Files:**
- Create: `packages/windows/test/windows-real-powershell.test.ts`

**Interfaces:** consumes everything above; nothing new.

The whole file is `describe.skipIf(process.platform !== "win32")` — skipped everywhere except the CI runner (and any future Windows box). Assertions target runner-safe observables only:

```ts
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { defaultPowerShellRunner } from "../src/windows-exec.js";
import { createWinAppReadTool } from "../src/windows-app-read-tool.js";
import { createWinClipboardSetTool, createWinSayTool } from "../src/windows-utility-tools.js";
import { createWinScreenshotTool } from "../src/windows-screen-tools.js";

describe.skipIf(process.platform !== "win32")("real PowerShell transport (windows-latest contract)", () => {
  it("runs a trivial script end-to-end", async () => {
    const r = await defaultPowerShellRunner("Write-Output 'muse-alive'");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("muse-alive");
  }, 60_000);

  it("clipboard round-trips through the REAL clipboard", async () => {
    const text = `muse-ci-${Date.now().toString(36)} "quoted" $inert`;
    const out = await createWinClipboardSetTool().execute({ text }, { runId: "ci" });
    expect(out).toMatchObject({ ok: true });
    const read = await defaultPowerShellRunner("Get-Clipboard");
    expect(read.stdout).toContain(text.slice(0, 20));
  }, 60_000);

  it("storage read reports at least one real drive", async () => {
    const out = await createWinAppReadTool().execute({ source: "storage" }, { runId: "ci" }) as { ok: boolean; drives?: unknown[] };
    expect(out.ok).toBe(true);
    expect(out.drives!.length).toBeGreaterThan(0);
  }, 60_000);

  it("battery read fail-softs on a desktop runner (no battery ≠ crash)", async () => {
    const out = await createWinAppReadTool().execute({ source: "battery" }, { runId: "ci" }) as { ok: boolean };
    expect(typeof out.ok).toBe("boolean"); // either a real battery or a clean refusal
  }, 60_000);

  it("screenshot writes a decodable PNG on the runner's real desktop session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-win-shot-"));
    const path = join(dir, "shot.png");
    const out = await createWinScreenshotTool().execute({ path }, { runId: "ci" });
    expect(out).toMatchObject({ captured: true });
    expect(existsSync(path)).toBe(true);
    const bytes = readFileSync(path);
    expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
  }, 120_000);

  it("say synthesizes to a WAV file (no audio device needed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-win-say-"));
    const wav = join(dir, "say.wav");
    // SetOutputToWaveFile exercises the same synthesis stack without a device.
    const r = await defaultPowerShellRunner([
      "Add-Type -AssemblyName System.Speech",
      "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
      `$s.SetOutputToWaveFile('${wav.replace(/'/gu, "''")}')`,
      "$s.Speak('muse windows check')",
      "$s.Dispose()"
    ].join("\n"));
    expect(r.exitCode).toBe(0);
    expect(existsSync(wav)).toBe(true);
    expect(readFileSync(wav).length).toBeGreaterThan(1_000);
    void createWinSayTool; // tool-level say asserted via fake runner; device output unverifiable on CI
  }, 120_000);
});
```

- [ ] **Step 1:** Write the file (it SKIPS locally — verify `npx vitest run windows-real` shows all skipped, exit 0).
- [ ] **Step 2: Commit** — `test(windows): real-PowerShell contract battery for the windows-latest runner`

---

### Task 8: PR + CI loop until green, merge on approval

- [ ] **Step 1:** Merge `origin/main`, `pnpm install`, `pnpm test:changed` green, `pnpm lint` 0.
- [ ] **Step 2:** Push branch; `gh pr create --draft` (title `feat: @muse/windows phase 2 — PowerShell actuators + ambient source`, body maps spec sections).
- [ ] **Step 3:** Triage loop (Phase 1 protocol): read failed job logs → narrowest fix → commit+push → repeat. The real-PowerShell battery (Task 7) runs for the FIRST time on the runner here — expect 1-2 rounds of script fixes (PS 5.1 quirks). Merge `origin/main` every round.
- [ ] **Step 4:** Both jobs green → `gh pr ready` → report to 진안 and await merge instruction (or merge if pre-authorized).
