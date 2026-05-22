import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WebActionApprovalGate } from "@muse/mcp";
import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { registerHomeCommands, type HomeCommandDeps } from "./commands-home.js";

function recordingFetch(): { fetchImpl: typeof fetch; calls: { url: string; body?: string }[] } {
  const calls: { url: string; body?: string }[] = [];
  const fetchImpl = (async (url: string | URL, init?: { body?: string }) => {
    calls.push({ body: init?.body, url: String(url) });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function logFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-cli-home-")), "action-log.json");
}

async function run(args: string[], deps: HomeCommandDeps): Promise<{ output: string; exitCode: number | undefined }> {
  const output: string[] = [];
  const io = { stderr: (m: string) => output.push(m), stdout: (m: string) => output.push(m) };
  const prevExit = process.exitCode;
  process.exitCode = 0;
  const program = new Command();
  program.exitOverride();
  registerHomeCommands(program, io, { baseUrl: "http://ha.local:8123", token: "tok", ...deps });
  try {
    await program.parseAsync(["node", "muse", "home", ...args]);
  } catch { /* commander exitOverride */ }
  const exitCode = process.exitCode === 0 ? undefined : process.exitCode;
  process.exitCode = prevExit;
  return { exitCode, output: output.join("") };
}

const approve: WebActionApprovalGate = () => ({ approved: true });
const deny: WebActionApprovalGate = () => ({ approved: false, reason: "declined" });

describe("muse home call — surface", () => {
  it("CONFIRM: calls the HA service and reports the status", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const r = await run(["call", "light.turn_off", "--entity", "light.living_room"], { actionLogFile: logFile(), approvalGate: approve, fetchImpl });
    expect(r.output).toContain("Done (HTTP 200)");
    expect(calls[0]?.url).toBe("http://ha.local:8123/api/services/light/turn_off");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ entity_id: "light.living_room" });
  });

  it("DENY: no HA call fires, exit 1", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const r = await run(["call", "light.turn_off", "--entity", "light.living_room"], { actionLogFile: logFile(), approvalGate: deny, fetchImpl });
    expect(calls).toHaveLength(0);
    expect(r.output).toContain("Not performed (denied)");
    expect(r.exitCode).toBe(1);
  });

  it("rejects a malformed service id (not domain.service)", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const r = await run(["call", "turnoff", "--entity", "x"], { actionLogFile: logFile(), approvalGate: approve, fetchImpl });
    expect(calls).toHaveLength(0);
    expect(r.output).toContain("must be '<domain>.<service>'");
    expect(r.exitCode).toBe(1);
  });
});
