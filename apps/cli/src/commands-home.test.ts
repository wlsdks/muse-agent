import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WebActionApprovalGate } from "@muse/domain-tools";
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

function stateFetch(status: number, body: string): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("muse home state — read-only surface", () => {
  it("GETs the entity state and prints it with the friendly name", async () => {
    const { fetchImpl, calls } = stateFetch(200, JSON.stringify({ attributes: { friendly_name: "Front Door" }, entity_id: "lock.front_door", state: "locked" }));
    const r = await run(["state", "lock.front_door"], { fetchImpl });
    expect(calls[0]).toBe("http://ha.local:8123/api/states/lock.front_door");
    expect(r.output).toContain("lock.front_door (Front Door): locked");
    expect(r.exitCode).toBeUndefined();
  });

  it("an unknown entity (404) reports no state and exits 1, never throwing", async () => {
    const { fetchImpl } = stateFetch(404, "Not found");
    const r = await run(["state", "lock.nope"], { fetchImpl });
    expect(r.output).toContain("no state for 'lock.nope'");
    expect(r.exitCode).toBe(1);
  });
});

describe("muse home entities — discovery surface", () => {
  it("lists entities and filters by --domain", async () => {
    const body = JSON.stringify([
      { attributes: {}, entity_id: "lock.front_door", state: "locked" },
      { attributes: {}, entity_id: "light.living_room", state: "on" }
    ]);
    const { fetchImpl, calls } = stateFetch(200, body);
    const r = await run(["entities", "--domain", "lock"], { fetchImpl });
    expect(calls[0]).toBe("http://ha.local:8123/api/states");
    expect(r.output).toContain("lock.front_door: locked");
    expect(r.output).not.toContain("light.living_room");
  });

  it("reports none when the entity list is empty / unreachable", async () => {
    const { fetchImpl } = stateFetch(500, "boom");
    const r = await run(["entities"], { fetchImpl });
    expect(r.output).toContain("No entities found");
  });
});

function statesFetch(states: unknown[]): typeof fetch {
  return (async (url: string | URL) => {
    if (String(url).includes("/api/states")) {
      return new Response(JSON.stringify(states), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

describe("muse home entities — --state filter (what's left on?)", () => {
  const STATES = [
    { attributes: {}, entity_id: "light.living_room", state: "on" },
    { attributes: {}, entity_id: "light.bedroom", state: "off" },
    { attributes: {}, entity_id: "lock.front_door", state: "locked" }
  ];

  it("--state ON returns only on-state entities (case-insensitive)", async () => {
    const { output } = await run(["entities", "--state", "ON"], { fetchImpl: statesFetch(STATES) });
    expect(output).toContain("light.living_room: on");
    expect(output).not.toContain("light.bedroom");
    expect(output).not.toContain("lock.front_door");
  });

  it("without --state, lists every entity (unchanged behaviour)", async () => {
    const { output } = await run(["entities"], { fetchImpl: statesFetch(STATES) });
    expect(output).toContain("light.living_room: on");
    expect(output).toContain("light.bedroom: off");
    expect(output).toContain("lock.front_door: locked");
  });

  it("--state unlocked → none when the only lock is locked", async () => {
    const { output } = await run(["entities", "--state", "unlocked"], { fetchImpl: statesFetch(STATES) });
    expect(output).toContain("No entities found");
    expect(output).toContain("state 'unlocked'");
  });
});

describe("muse home — local-only remote containment", () => {
  it("refuses call/state/entities before approval or fetch even when explicit baseUrl/token deps are supplied", async () => {
    for (const args of [
      ["call", "light.turn_off", "--entity", "light.living_room"],
      ["state", "lock.front_door"],
      ["entities"]
    ]) {
      const { fetchImpl, calls } = recordingFetch();
      let approvals = 0;
      const result = await run(args, {
        actionLogFile: logFile(),
        approvalGate: () => {
          approvals += 1;
          return { approved: true };
        },
        env: { MUSE_LOCAL_ONLY: "true" },
        fetchImpl
      });
      expect(result.exitCode, args.join(" ")).toBe(1);
      expect(result.output, args.join(" ")).toContain("Home Assistant remote paths are disabled while MUSE_LOCAL_ONLY=true");
      expect(calls, args.join(" ")).toEqual([]);
      expect(approvals, args.join(" ")).toBe(0);
    }
  });

  it("keeps canonical localhost loopback working under local-only", async () => {
    const { fetchImpl, calls } = stateFetch(200, JSON.stringify({ attributes: {}, entity_id: "lock.front_door", state: "locked" }));
    const result = await run(["state", "lock.front_door"], {
      baseUrl: "http://localhost:8123/",
      env: { MUSE_LOCAL_ONLY: "true" },
      fetchImpl,
      token: "tok"
    });
    expect(result.exitCode).toBeUndefined();
    expect(result.output).toContain("lock.front_door: locked");
    expect(calls).toEqual(["http://127.0.0.1:8123/api/states/lock.front_door"]);
  });
});
