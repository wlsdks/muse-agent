import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { performConsentedAction } from "@muse/proactivity";
import { runDueObjectives, type ObjectiveEvaluation } from "@muse/proactivity";
import { recordConsent } from "@muse/stores";
import { addObjective, readObjectives, type StandingObjective } from "@muse/stores";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "muse-consent-"));
}

function objective(overrides: Partial<StandingObjective> = {}): StandingObjective {
  return {
    createdAt: "2026-05-19T10:00:00.000Z",
    id: "obj_ship",
    kind: "until",
    spec: "when the release is tagged, open the changelog issue",
    status: "active",
    userId: "stark",
    ...overrides
  };
}

const NOW = new Date("2026-05-19T12:00:00.000Z");

describe("performConsentedAction — P5-b3 act-as-the-user under recorded consent", () => {
  it("fail-closed: no recorded consent ⇒ no HTTP call, no credential use", async () => {
    const consentFile = join(tmpDir(), "consents.json");
    let fetchCalled = false;
    const outcome = await performConsentedAction({
      consentFile,
      credential: "ghp-secret",
      fetchImpl: (async () => {
        fetchCalled = true;
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch,
      objectiveId: "obj_ship",
      request: { url: "https://api.github.test/repos/x/y/issues" },
      scope: "github:issues:write",
      userId: "stark"
    });
    expect(outcome).toEqual({ performed: false, reason: "no recorded consent for scope github:issues:write" });
    expect(fetchCalled).toBe(false);
  });

  it("consent recorded ⇒ the real external request fires carrying the scoped credential", async () => {
    const consentFile = join(tmpDir(), "consents.json");
    await recordConsent(consentFile, {
      grantedAt: NOW.toISOString(),
      id: "c1",
      objectiveId: "obj_ship",
      scope: "github:issues:write",
      userId: "stark"
    });

    let seen: { url: string; method: string; auth?: string; body?: string } | undefined;
    const outcome = await performConsentedAction({
      consentFile,
      credential: "ghp-secret",
      fetchImpl: (async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seen = {
          auth: headers.get("authorization") ?? undefined,
          body: typeof init?.body === "string" ? init.body : undefined,
          method: (init?.method ?? "GET").toUpperCase(),
          url: String(url)
        };
        return new Response(JSON.stringify({ number: 42 }), { status: 201 });
      }) as unknown as typeof fetch,
      objectiveId: "obj_ship",
      request: {
        body: JSON.stringify({ title: "Changelog for the release" }),
        url: "https://api.github.test/repos/x/y/issues"
      },
      scope: "github:issues:write",
      userId: "stark"
    });

    expect(outcome).toEqual({ performed: true, status: 201 });
    expect(seen).toEqual({
      auth: "Bearer ghp-secret",
      body: JSON.stringify({ title: "Changelog for the release" }),
      method: "POST",
      url: "https://api.github.test/repos/x/y/issues"
    });
  });

  it("fail-closed: a redirect from the consented host is NOT followed — the credential is never re-sent to an unvetted host", async () => {
    const consentFile = join(tmpDir(), "consents.json");
    await recordConsent(consentFile, {
      allowedHost: "api.github.test",
      grantedAt: NOW.toISOString(),
      id: "c-redir",
      objectiveId: "obj_ship",
      scope: "github:issues:write",
      userId: "stark"
    });

    const calls: { url: string; auth?: string }[] = [];
    const outcome = await performConsentedAction({
      consentFile,
      credential: "ghp-secret",
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push({ auth: new Headers(init?.headers).get("authorization") ?? undefined, url: String(url) });
        // The consented host answers with a redirect to an attacker host.
        return new Response(null, { headers: { location: "https://evil.example.net/collect" }, status: 302 });
      }) as unknown as typeof fetch,
      objectiveId: "obj_ship",
      request: { body: JSON.stringify({ title: "x" }), url: "https://api.github.test/repos/x/y/issues" },
      scope: "github:issues:write",
      userId: "stark"
    });

    expect(outcome.performed).toBe(false);
    if (outcome.performed === false) {
      expect(outcome.reason).toContain("redirect");
    }
    // The credential left the box exactly ONCE — to the consented host only;
    // evil.example.net was never contacted and never saw the Bearer token.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.github.test/repos/x/y/issues");
    expect(calls.some((c) => c.url.includes("evil.example.net"))).toBe(false);
  });

  it("times out instead of hanging when the consented endpoint never responds — a hung upstream can't stall the standing-objective loop", async () => {
    const consentFile = join(tmpDir(), "consents.json");
    await recordConsent(consentFile, {
      grantedAt: NOW.toISOString(),
      id: "c1",
      objectiveId: "obj_ship",
      scope: "github:issues:write",
      userId: "stark"
    });

    const start = Date.now();
    const outcome = await performConsentedAction({
      consentFile,
      credential: "ghp-secret",
      // Endpoint that ONLY resolves when its abort signal fires.
      // Pre-fix the test hangs until vitest's test-level cap; post-fix
      // the 50ms wall-clock aborts the fetch and the outcome surfaces.
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        return new Promise<Response>((_, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          if (signal) {
            signal.addEventListener("abort", () => reject(new Error("aborted by signal")));
          }
        });
      }) as unknown as typeof fetch,
      objectiveId: "obj_ship",
      request: { url: "https://api.github.test/repos/x/y/issues" },
      scope: "github:issues:write",
      timeoutMs: 50,
      userId: "stark"
    });
    const elapsed = Date.now() - start;
    expect(outcome.performed).toBe(false);
    if (outcome.performed === false) {
      expect(outcome.reason).toMatch(/timed out after 50ms/u);
    }
    // Generous bound; pre-fix the call hangs until vitest's 5_000ms
    // test timeout (>2s easily).
    expect(elapsed, `consented action must abort within the bounded window; took ${elapsed.toString()}ms`).toBeLessThan(2_000);
  });

  it("scope is never broadened implicitly: consent for one scope does not authorise another", async () => {
    const consentFile = join(tmpDir(), "consents.json");
    await recordConsent(consentFile, {
      grantedAt: NOW.toISOString(),
      id: "c1",
      objectiveId: "obj_ship",
      scope: "github:issues:read",
      userId: "stark"
    });
    let fetchCalled = false;
    const outcome = await performConsentedAction({
      consentFile,
      credential: "ghp-secret",
      fetchImpl: (async () => {
        fetchCalled = true;
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch,
      objectiveId: "obj_ship",
      request: { url: "https://api.github.test/repos/x/y/issues" },
      scope: "github:issues:write",
      userId: "stark"
    });
    expect(outcome.performed).toBe(false);
    expect(fetchCalled).toBe(false);
  });

  it("end-to-end: a met objective performs the real external action via the scoped credential and is marked done", async () => {
    const dir = tmpDir();
    const objectivesFile = join(dir, "objectives.json");
    const consentFile = join(dir, "consents.json");
    await addObjective(objectivesFile, objective());
    await recordConsent(consentFile, {
      grantedAt: NOW.toISOString(),
      id: "c1",
      objectiveId: "obj_ship",
      scope: "github:issues:write",
      userId: "stark"
    });

    let posted: string | undefined;
    const summary = await runDueObjectives({
      act: async (o) => {
        const outcome = await performConsentedAction({
          consentFile,
          credential: "ghp-secret",
          fetchImpl: (async (url: string) => {
            posted = String(url);
            return new Response(null, { status: 201 });
          }) as unknown as typeof fetch,
          objectiveId: o.id,
          request: { url: "https://api.github.test/repos/x/y/issues" },
          scope: "github:issues:write",
          userId: o.userId
        });
        if (!outcome.performed) {
          throw new Error(outcome.reason);
        }
      },
      evaluate: async (): Promise<ObjectiveEvaluation> => ({ evidence: [{ source: "test:seam", text: "objective condition observed in the fake store" }], outcome: "met" }),
      file: objectivesFile,
      now: () => NOW
    });

    expect(summary.fired).toEqual(["obj_ship"]);
    expect(posted).toBe("https://api.github.test/repos/x/y/issues");
    expect((await readObjectives(objectivesFile))[0]!.status).toBe("done");
  });

  it("end-to-end: WITHOUT consent the objective is not falsely completed (fail-closed composes with backoff)", async () => {
    const dir = tmpDir();
    const objectivesFile = join(dir, "objectives.json");
    const consentFile = join(dir, "consents.json");
    await addObjective(objectivesFile, objective());

    let fetchCalled = false;
    const summary = await runDueObjectives({
      act: async (o) => {
        const outcome = await performConsentedAction({
          consentFile,
          credential: "ghp-secret",
          fetchImpl: (async () => {
            fetchCalled = true;
            return new Response(null, { status: 200 });
          }) as unknown as typeof fetch,
          objectiveId: o.id,
          request: { url: "https://api.github.test/repos/x/y/issues" },
          scope: "github:issues:write",
          userId: o.userId
        });
        if (!outcome.performed) {
          throw new Error(outcome.reason);
        }
      },
      evaluate: async (): Promise<ObjectiveEvaluation> => ({ evidence: [{ source: "test:seam", text: "objective condition observed in the fake store" }], outcome: "met" }),
      file: objectivesFile,
      now: () => NOW
    });

    expect(fetchCalled).toBe(false);
    expect(summary.fired).toEqual([]);
    expect(summary.errors[0]).toContain("no recorded consent");
    expect((await readObjectives(objectivesFile))[0]!.status).toBe("active");
  });
});
