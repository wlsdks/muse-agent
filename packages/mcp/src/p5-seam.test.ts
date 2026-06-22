import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { performConsentedAction } from "@muse/proactivity";
import { runDueObjectives, type ObjectiveEvaluation } from "@muse/proactivity";
import { recordConsent } from "@muse/stores";
import { addObjective, readObjectives, type StandingObjective } from "@muse/stores";

/**
 * P5 target audit (the P→P seam check). Unlike P4 (independent
 * trust-closures), P5's three bullets ARE a composed delegation
 * pipeline: register a durable objective (b1) → it is autonomously
 * re-evaluated on a tick with backoff (b2) → when met it acts via
 * a scoped credential under recorded consent (b3). The seam the
 * three isolated tests do NOT cover together is durability ACROSS
 * the pieces: does the whole delegation survive a process restart
 * and compose end-to-end over multiple ticks?
 *
 * Every store read below is a fresh call sharing no in-memory
 * state with the writes — exactly what a restarted process / the
 * next ~20-min tick sees.
 */
function objective(overrides: Partial<StandingObjective> = {}): StandingObjective {
  return {
    createdAt: "2026-05-19T10:00:00.000Z",
    id: "obj_release",
    kind: "until",
    spec: "when the release is tagged, open the changelog issue via GitHub",
    status: "active",
    userId: "stark",
    ...overrides
  };
}

describe("P5 audit — register → restart → tick(backoff) → restart → tick(met → consented action) composes", () => {
  it("a durable objective survives restarts and is carried to a real consented external action", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-p5-seam-"));
    const objectivesFile = join(dir, "objectives.json");
    const consentFile = join(dir, "consents.json");
    const base = 1000;

    // b1 — register, then "restart": a fresh read still has it.
    await addObjective(objectivesFile, objective());
    expect((await readObjectives(objectivesFile))[0]?.status).toBe("active");

    await recordConsent(consentFile, {
      grantedAt: "2026-05-19T11:00:00.000Z",
      id: "c_release",
      objectiveId: "obj_release",
      scope: "github:issues:write",
      userId: "stark"
    });

    const T1 = new Date("2026-05-19T12:00:00.000Z");
    let posted: string | undefined;

    const consentedAct = async (o: StandingObjective): Promise<void> => {
      const outcome = await performConsentedAction({
        consentFile,
        credential: "ghp-scoped",
        fetchImpl: (async (url: string, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          expect(headers.get("authorization")).toBe("Bearer ghp-scoped");
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
    };

    // b2 — tick 1: condition not yet met → exponential backoff,
    // persisted. No external action.
    const t1 = await runDueObjectives({
      act: consentedAct,
      backoffBaseMs: base,
      evaluate: async (): Promise<ObjectiveEvaluation> => ({ outcome: "unmet" }),
      file: objectivesFile,
      now: () => T1
    });
    expect(t1.retried).toEqual(["obj_release"]);
    expect(posted).toBeUndefined();

    // "Restart": the backoff state survived to disk.
    const afterTick1 = (await readObjectives(objectivesFile))[0]!;
    expect(afterTick1.status).toBe("active");
    expect(afterTick1.attempts).toBe(1);
    expect(Date.parse(afterTick1.nextEvalAt!)).toBe(T1.getTime() + base);

    // b2+b3 — tick 2 past the backoff window: condition now holds →
    // the consented scoped-credential external action fires.
    const T2 = new Date(Date.parse(afterTick1.nextEvalAt!) + 1);
    const t2 = await runDueObjectives({
      act: consentedAct,
      evaluate: async (): Promise<ObjectiveEvaluation> => ({ outcome: "met" }),
      file: objectivesFile,
      now: () => T2
    });
    expect(t2.fired).toEqual(["obj_release"]);
    expect(posted).toBe("https://api.github.test/repos/x/y/issues");

    // Final "restart": the completed state is durable.
    expect((await readObjectives(objectivesFile))[0]?.status).toBe("done");
  });

  it("the fail-closed consent gate composes with the durable lifecycle: no consent ⇒ never falsely completed across a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-p5-seam-noconsent-"));
    const objectivesFile = join(dir, "objectives.json");
    const consentFile = join(dir, "consents.json");
    await addObjective(objectivesFile, objective({ id: "obj_noconsent" }));

    let fetchCalled = false;
    const summary = await runDueObjectives({
      act: async (o) => {
        const outcome = await performConsentedAction({
          consentFile,
          credential: "ghp-scoped",
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
      evaluate: async (): Promise<ObjectiveEvaluation> => ({ outcome: "met" }),
      file: objectivesFile,
      now: () => new Date("2026-05-19T12:00:00.000Z")
    });

    expect(fetchCalled).toBe(false);
    expect(summary.fired).toEqual([]);
    // Restart: still active (not silently dropped, not falsely done).
    expect((await readObjectives(objectivesFile))[0]?.status).toBe("active");
  });
});
