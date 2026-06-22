import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WebActionApprovalGate } from "@muse/domain-tools";
import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { registerWebActionCommands, type WebActionCommandDeps } from "./commands-web-action.js";

function recordingFetch(): { fetchImpl: typeof fetch; calls: { url: string; method: string }[] } {
  const calls: { url: string; method: string }[] = [];
  const fetchImpl = (async (url: string | URL, init?: { method?: string }) => {
    calls.push({ method: init?.method ?? "GET", url: String(url) });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function logFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-cli-webaction-")), "action-log.json");
}

async function run(args: string[], deps: WebActionCommandDeps): Promise<{ output: string; exitCode: number | undefined }> {
  const output: string[] = [];
  const io = { stderr: (m: string) => output.push(m), stdout: (m: string) => output.push(m) };
  const prevExit = process.exitCode;
  process.exitCode = 0;
  const program = new Command();
  program.exitOverride();
  registerWebActionCommands(program, io, deps);
  try {
    await program.parseAsync(["node", "muse", "web-action", ...args]);
  } catch { /* commander exitOverride */ }
  const exitCode = process.exitCode === 0 ? undefined : process.exitCode;
  process.exitCode = prevExit;
  return { exitCode, output: output.join("") };
}

const approve: WebActionApprovalGate = () => ({ approved: true });
const deny: WebActionApprovalGate = () => ({ approved: false, reason: "declined" });

describe("muse web-action — surface", () => {
  it("CONFIRM: performs the action and reports the status", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const r = await run(["--url", "https://book.test/x", "--summary", "Book", "--body", "{}"], { actionLogFile: logFile(), approvalGate: approve, fetchImpl });
    expect(r.output).toContain("Done (HTTP 200)");
    expect(calls).toEqual([{ method: "POST", url: "https://book.test/x" }]);
    expect(r.exitCode).toBeUndefined();
  });

  it("DENY: no HTTP fires, exit 1", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const r = await run(["--url", "https://book.test/x", "--summary", "Book"], { actionLogFile: logFile(), approvalGate: deny, fetchImpl });
    expect(calls).toHaveLength(0);
    expect(r.output).toContain("Not performed (denied)");
    expect(r.exitCode).toBe(1);
  });
});
