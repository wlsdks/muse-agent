# @muse/windows

Owns Muse's native Windows control tools: in-process `MuseTool`s that drive stock Windows
PowerShell for app open/read, clipboard, screenshot, media-key, and system-setting actions. It is
a package rather than a folder because every tool shares one PowerShell execution primitive and
timeout contract, mirroring the split `@muse/macos` makes for macOS.

## Public surface

- `runPowerShellWith`, `defaultPowerShellRunner`, `psBase64Expr`, `POWERSHELL_TIMEOUT_MS`,
  `WinCommandResult`, `WinPowerShellRunner` — the shared PowerShell execution primitive every tool
  is built on; scripts are delivered over stdin so nothing passes through argv parsing.
- `createWinAppOpenTool` — opens an app, URL, or file.
- `createWinAppReadTool`, `parseReadOutput`, `WIN_APP_READ_SOURCES` — reads visible app/window state.
- `createWinClipboardSetTool`, `createWinSayTool` — clipboard write and text-to-speech.
- `createWinScreenshotTool`, `defaultScreenshotPath`, `resolveWindowsScreenshotPath` — screenshot
  capture to a sandboxed path.
- `createWinMediaControlTool`, `keyEventScript`, `WIN_MEDIA_ACTIONS` — media-key control.
- `createWinSystemSetTool`, `WIN_SYSTEM_SETTINGS` — system-setting toggles.

## Depends on

- `@muse/shared` — common primitives, including the injectable timeout-bounded command runner.
- `@muse/tools` — the `MuseTool` contract this package implements.

## Rules that bind this package

Every `WindowsToolDeps.runner` is injectable so unit tests fake the PowerShell transport instead of
spawning a real process; the win32 CI runner exercises the real path. Unlike `@muse/macos`'s
`system-resource-observation` subpath, this package has no internal `process.platform` guard — it
assumes a Windows host and relies on the caller to gate tool registration by platform. Scripts are
passed via stdin (`-Command -`), never interpolated into argv, to avoid PowerShell argv-parsing
injection. Execution here spawns `powershell.exe` directly through `node:child_process`, not
through `crates/runner`.

## Tests

```bash
pnpm --filter @muse/windows test
```
