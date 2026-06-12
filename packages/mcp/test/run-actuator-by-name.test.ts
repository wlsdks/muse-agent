import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonObject } from "@muse/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runActuatorByName, type RunActuatorByNameDeps } from "../src/run-actuator-by-name.js";

let dir: string;
let actionLogFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-run-actuator-"));
  actionLogFile = join(dir, "actions.json");
});
afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

const okFetch = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const deps = (over: Partial<RunActuatorByNameDeps> = {}): RunActuatorByNameDeps => ({
  actionLogFile,
  emailApprovalGate: () => ({ approved: true }),
  fetchImpl: okFetch,
  lookup: publicLookup,
  userId: "u1",
  webApprovalGate: () => ({ approved: true }),
  ...over
});
const webArgs: JsonObject = { body: "{}", method: "POST", summary: "book a table", url: "https://api.test/x" };

describe("runActuatorByName — dispatch a gated actuator by name", () => {
  it("returns unknown-tool for a name it doesn't dispatch", async () => {
    expect(await runActuatorByName("nope", {}, deps())).toEqual({ detail: "nope", ran: false, reason: "unknown-tool" });
  });

  it("returns unavailable when email_send / home_action lack their required credentials", async () => {
    expect(await runActuatorByName("email_send", {}, deps())).toMatchObject({ ran: false, reason: "unavailable" });
    expect(await runActuatorByName("home_action", {}, deps())).toMatchObject({ ran: false, reason: "unavailable" });
  });

  it("runs web_action through the real WithApproval orchestration and reports ran:true on success", async () => {
    expect(await runActuatorByName("web_action", webArgs, deps())).toEqual({ ran: true });
  });

  it("maps a DENIED approval to 'declined' (not a generic failure)", async () => {
    const out = await runActuatorByName("web_action", webArgs, deps({ webApprovalGate: () => ({ approved: false, reason: "user said no" }) }));
    expect(out).toMatchObject({ ran: false, reason: "declined", detail: "user said no" });
  });

  it("maps a non-2xx / transport failure to 'failed' with the detail", async () => {
    const out = await runActuatorByName("web_action", webArgs, deps({ fetchImpl: (async () => new Response("", { status: 500 })) as unknown as typeof fetch }));
    expect(out).toMatchObject({ ran: false, reason: "failed" });
    expect((out as { detail: string }).detail).toContain("HTTP 500");
  });
});
