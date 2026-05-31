import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { performConsentedAction, type PerformConsentedActionOptions } from "../src/consented-action.js";
import { recordConsent } from "../src/personal-consent-store.js";
import { recordVeto } from "../src/personal-veto-store.js";

let dir: string;
let consentFile: string;
let vetoFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-consented-"));
  consentFile = join(dir, "consent.json");
  vetoFile = join(dir, "veto.json");
});
afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

function recordingFetch(responder: () => Response | Promise<Response> = () => new Response("", { status: 200 })) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ init, url }); return responder(); }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const OBJ = "obj-1";
const SCOPE = "github:issues:write";
const base = (fetchImpl: typeof fetch, over: Partial<PerformConsentedActionOptions> = {}): PerformConsentedActionOptions => ({
  consentFile,
  credential: "svc-token",
  fetchImpl,
  objectiveId: OBJ,
  request: { body: '{"title":"x"}', method: "POST", url: "https://api.test/issues" },
  scope: SCOPE,
  userId: "u1",
  ...over
});

const grant = (scope = SCOPE) => recordConsent(consentFile, { grantedAt: "2026-05-31T00:00:00Z", id: "c1", objectiveId: OBJ, scope, userId: "u1" });

describe("performConsentedAction — fail-closed scoped-consent gate (outbound-safety rule 5)", () => {
  it("refuses with NO HTTP when there is no recorded consent (credential never leaves)", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const out = await performConsentedAction(base(fetchImpl));
    expect(out).toMatchObject({ performed: false });
    expect((out as { reason: string }).reason).toContain("no recorded consent");
    expect(calls).toHaveLength(0); // the credential is never resolved into a request
  });

  it("performs the action with a Bearer credential ONLY when consent for the exact {objective,scope} is recorded", async () => {
    await grant();
    const { calls, fetchImpl } = recordingFetch(() => new Response("", { status: 201 }));
    const out = await performConsentedAction(base(fetchImpl));
    expect(out).toEqual({ performed: true, status: 201 });
    expect(calls).toHaveLength(1);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer svc-token");
  });

  it("does NOT broaden consent — a consent for one scope doesn't authorise a different scope", async () => {
    await grant("github:issues:read"); // narrower/other scope
    const { calls, fetchImpl } = recordingFetch();
    const out = await performConsentedAction(base(fetchImpl)); // requests issues:WRITE
    expect(out).toMatchObject({ performed: false });
    expect(calls).toHaveLength(0);
  });

  it("a recorded VETO overrides prior consent and refuses BEFORE the consent check (no HTTP)", async () => {
    await grant(); // consent exists...
    await recordVeto(vetoFile, { id: "v1", objectiveId: OBJ, reason: "stop", scope: SCOPE, userId: "u1", vetoedAt: "2026-05-31T01:00:00Z" });
    const { calls, fetchImpl } = recordingFetch();
    const out = await performConsentedAction(base(fetchImpl, { vetoFile }));
    expect(out).toMatchObject({ performed: false });
    expect((out as { reason: string }).reason).toContain("vetoed");
    expect(calls).toHaveLength(0); // veto wins — the consented action never fires
  });

  it("times out a consented-but-hung endpoint instead of stalling the standing-objective loop", async () => {
    await grant();
    const hang = ((url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    const out = await performConsentedAction(base(hang, { timeoutMs: 5 }));
    expect(out).toMatchObject({ performed: false });
    expect((out as { reason: string }).reason).toContain("timed out");
  });

  it("reports a fetch transport error as a non-performed outcome (not a false success)", async () => {
    await grant();
    const throwing = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    const out = await performConsentedAction(base(throwing));
    expect(out).toMatchObject({ performed: false });
    expect((out as { reason: string }).reason).toContain("ECONNRESET");
  });
});
