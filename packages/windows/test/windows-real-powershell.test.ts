import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createWinAppReadTool } from "../src/windows-app-read-tool.js";
import { createWinClipboardSetTool } from "../src/windows-utility-tools.js";
import { createWinScreenshotTool } from "../src/windows-screen-tools.js";
import { defaultPowerShellRunner } from "../src/windows-exec.js";

// The windows-latest runner executes REAL PowerShell — the transport layer the
// macOS package could only ever fake in CI. Assertions target runner-safe
// observables (files, clipboard round-trip, exit codes), never audio/visual state.
describe.skipIf(process.platform !== "win32")("real PowerShell transport (windows-latest contract)", () => {
  it("runs a trivial script end-to-end over stdin", async () => {
    const r = await defaultPowerShellRunner("Write-Output 'muse-alive'");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("muse-alive");
  }, 60_000);

  it("clipboard round-trips through the REAL clipboard, hostile chars inert", async () => {
    const text = `muse-ci-${process.pid.toString(36)} "quoted" $(Get-Date) \`inert\``;
    const out = await createWinClipboardSetTool().execute({ text }, { runId: "ci" });
    expect(out).toMatchObject({ ok: true });
    const read = await defaultPowerShellRunner("Get-Clipboard");
    expect(read.exitCode).toBe(0);
    expect(read.stdout).toContain("$(Get-Date)"); // literal — never evaluated
  }, 60_000);

  it("storage read reports at least one real drive", async () => {
    const out = await createWinAppReadTool().execute({ source: "storage" }, { runId: "ci" }) as { ok: boolean; drives?: readonly unknown[] };
    expect(out.ok).toBe(true);
    expect(out.drives!.length).toBeGreaterThan(0);
  }, 60_000);

  it("battery read fail-softs on a batteryless runner (no crash either way)", async () => {
    const out = await createWinAppReadTool().execute({ source: "battery" }, { runId: "ci" }) as { ok: boolean };
    expect(typeof out.ok).toBe("boolean");
  }, 60_000);

  it("frontmost window read returns a string-or-refusal, never throws", async () => {
    const out = await createWinAppReadTool().execute({ source: "frontmost" }, { runId: "ci" }) as { ok: boolean; window?: string };
    expect(typeof out.ok).toBe("boolean");
    if (out.ok) expect(typeof out.window).toBe("string");
  }, 60_000);

  it("screenshot writes a decodable PNG on the runner's desktop session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-win-shot-"));
    const path = join(dir, "shot.png");
    const out = await createWinScreenshotTool().execute({ path }, { runId: "ci" });
    expect(out).toMatchObject({ captured: true });
    expect(existsSync(path)).toBe(true);
    const bytes = readFileSync(path);
    expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
  }, 120_000);

  it("speech synthesizes to a WAV file (no audio device needed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-win-say-"));
    const wav = join(dir, "say.wav");
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
  }, 120_000);
});
