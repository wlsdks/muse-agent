import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

import { POWERSHELL_TIMEOUT_MS, psBase64Expr, runPowerShellWith } from "./windows-exec.js";

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { written: string[]; write(s: string): void; end(): void; on(): void };
  kill(sig?: string): boolean;
  killedWith?: string;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    written: [] as string[],
    write(s: string) { this.written.push(s); },
    end() { /* noop */ },
    on() { /* noop */ }
  } as FakeChild["stdin"];
  child.kill = (sig?: string) => { child.killedWith = sig ?? "SIGTERM"; return true; };
  return child;
}

describe("runPowerShellWith", () => {
  it("spawns powershell -NoProfile -NonInteractive -Command - and pipes the script over stdin", async () => {
    const child = fakeChild();
    let spawnedBin = "";
    let spawnedArgs: readonly string[] = [];
    const capture = ((bin: string, args: readonly string[]) => {
      spawnedBin = bin;
      spawnedArgs = args;
      return child;
    }) as unknown as typeof spawn;
    const pending = runPowerShellWith("Get-Date", POWERSHELL_TIMEOUT_MS, capture);
    child.stdout.emit("data", Buffer.from("ok\n"));
    child.emit("close", 0);
    const result = await pending;
    expect(spawnedBin).toBe("powershell.exe");
    expect(spawnedArgs).toEqual(["-NoProfile", "-NonInteractive", "-Command", "-"]);
    expect(child.stdin.written.join("")).toBe("Get-Date");
    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "ok\n", timedOut: false });
  });

  it("SIGKILLs a wedged powershell and resolves timedOut", async () => {
    const child = fakeChild();
    const result = await runPowerShellWith("Start-Sleep 999", 20, (() => child) as unknown as typeof spawn);
    expect(result.timedOut).toBe(true);
    expect(child.killedWith).toBe("SIGKILL");
  });

  it("rejects on a spawn error (no powershell on PATH)", async () => {
    const child = fakeChild();
    const pending = runPowerShellWith("x", 1_000, (() => child) as unknown as typeof spawn);
    child.emit("error", new Error("spawn powershell.exe ENOENT"));
    await expect(pending).rejects.toThrow(/ENOENT/u);
  });
});

describe("psBase64Expr", () => {
  it("round-trips arbitrary text (quotes, $, newlines, Korean) through base64", () => {
    const text = `hi "$(rm)" 진안\nline2`;
    const expr = psBase64Expr(text);
    expect(expr).toMatch(/^\[System\.Text\.Encoding\]::UTF8\.GetString\(\[Convert\]::FromBase64String\('[A-Za-z0-9+/=]+'\)\)$/u);
    const b64 = /'([A-Za-z0-9+/=]+)'/u.exec(expr)![1]!;
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe(text);
  });
});
