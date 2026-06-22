import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { performConsentedAction } from "@muse/proactivity";
import { runDueObjectives, type ObjectiveEvaluation } from "@muse/proactivity";
import { queryActionLog } from "@muse/stores";
import { recordConsent } from "@muse/stores";
import { hasVeto, readVetoes } from "@muse/stores";
import { addObjective, readObjectives, type StandingObjective } from "@muse/stores";
import { undoLoggedAction } from "@muse/proactivity";

function dirs() {
  const dir = mkdtempSync(join(tmpdir(), "muse-undo-"));
  return {
    actionLogFile: join(dir, "action-log.json"),
    consentFile: join(dir, "consents.json"),
    objectivesFile: join(dir, "objectives.json"),
    vetoFile: join(dir, "vetoes.json")
  };
}

function objective(overrides: Partial<StandingObjective> = {}): StandingObjective {
  return {
    createdAt: "2026-05-19T10:00:00.000Z",
    id: "obj_release",
    kind: "until",
    spec: "when the release is tagged, open the changelog issue",
    status: "active",
    userId: "stark",
    ...overrides
  };
}

const T = new Date("2026-05-19T12:00:00.000Z");
const SCOPE = "github:issues:write";

describe("undoLoggedAction — P6-b2 act → undo → veto → no longer auto-acts", () => {
  it("a veto recorded by an undo overrides prior consent and blocks the same trigger from recurring", async () => {
    const f = dirs();
    await addObjective(f.objectivesFile, objective());
    await recordConsent(f.consentFile, {
      grantedAt: "2026-05-19T11:00:00.000Z",
      id: "c1",
      objectiveId: "obj_release",
      scope: SCOPE,
      userId: "stark"
    });

    // Act: the autonomous consented action performs and is logged.
    let posts = 0;
    const act = async (o: StandingObjective): Promise<void> => {
      const outcome = await performConsentedAction({
        consentFile: f.consentFile,
        credential: "ghp-scoped",
        fetchImpl: (async () => {
          posts += 1;
          return new Response(null, { status: 201 });
        }) as unknown as typeof fetch,
        objectiveId: o.id,
        request: { url: "https://api.github.test/repos/x/y/issues" },
        scope: SCOPE,
        userId: o.userId,
        vetoFile: f.vetoFile
      });
      if (!outcome.performed) {
        throw new Error(outcome.reason);
      }
    };
    const first = await runDueObjectives({
      act,
      evaluate: async (): Promise<ObjectiveEvaluation> => ({ outcome: "met" }),
      file: f.objectivesFile,
      now: () => T
    });
    expect(first.fired).toEqual(["obj_release"]);
    expect(posts).toBe(1);

    // Undo: reverse (HTTP-faked inverse) + record the memory veto +
    // log the undo.
    let reversedCalls = 0;
    const undo = await undoLoggedAction({
      actionLogFile: f.actionLogFile,
      now: () => new Date("2026-05-19T13:00:00.000Z"),
      objectiveId: "obj_release",
      originalActionId: "act_obj_release",
      reason: "wrong repo",
      reverse: async () => {
        reversedCalls += 1;
        return { detail: "closed issue #42 (HTTP 200)" };
      },
      scope: SCOPE,
      userId: "stark",
      vetoFile: f.vetoFile
    });
    expect(undo.reversed).toBe(true);
    expect(reversedCalls).toBe(1);
    expect(await hasVeto(f.vetoFile, { objectiveId: "obj_release", scope: SCOPE, userId: "stark" })).toBe(true);
    const log = await queryActionLog(f.actionLogFile, { userId: "stark" });
    expect(log[0]).toMatchObject({
      detail: "closed issue #42 (HTTP 200)",
      result: "performed",
      what: "undo of action act_obj_release",
      why: "wrong repo"
    });

    // The same trigger recurs: re-register the objective active and
    // tick again. The veto must block it — no HTTP, not completed.
    await addObjective(f.objectivesFile, objective());
    const second = await runDueObjectives({
      act,
      evaluate: async (): Promise<ObjectiveEvaluation> => ({ outcome: "met" }),
      file: f.objectivesFile,
      now: () => new Date("2026-05-19T14:00:00.000Z")
    });
    expect(second.fired).toEqual([]);
    expect(posts).toBe(1); // unchanged — the consented action did NOT fire again
    expect((await readObjectives(f.objectivesFile))[0]?.status).toBe("active");
  });

  it("veto overrides consent directly in performConsentedAction (no HTTP)", async () => {
    const f = dirs();
    await recordConsent(f.consentFile, {
      grantedAt: T.toISOString(),
      id: "c1",
      objectiveId: "obj_release",
      scope: SCOPE,
      userId: "stark"
    });
    await undoLoggedAction({
      actionLogFile: f.actionLogFile,
      objectiveId: "obj_release",
      originalActionId: "act_x",
      scope: SCOPE,
      userId: "stark",
      vetoFile: f.vetoFile
    });
    let called = false;
    const outcome = await performConsentedAction({
      consentFile: f.consentFile,
      credential: "ghp-scoped",
      fetchImpl: (async () => {
        called = true;
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch,
      objectiveId: "obj_release",
      request: { url: "https://api.github.test/repos/x/y/issues" },
      scope: SCOPE,
      userId: "stark",
      vetoFile: f.vetoFile
    });
    expect(outcome.performed).toBe(false);
    expect(called).toBe(false);
  });

  it("an irreversible action still records the veto (reversed:false, veto present)", async () => {
    const f = dirs();
    const result = await undoLoggedAction({
      actionLogFile: f.actionLogFile,
      objectiveId: "obj_send",
      originalActionId: "act_send",
      scope: "email:send",
      userId: "stark",
      vetoFile: f.vetoFile
    });
    expect(result.reversed).toBe(false);
    expect((await readVetoes(f.vetoFile)).length).toBe(1);
    const log = await queryActionLog(f.actionLogFile);
    expect(log[0]?.detail).toContain("irreversible");
  });

  it("hasVeto is exact: a veto for one scope does not block another", async () => {
    const f = dirs();
    await undoLoggedAction({
      actionLogFile: f.actionLogFile,
      objectiveId: "obj_release",
      originalActionId: "a",
      scope: "github:issues:write",
      userId: "stark",
      vetoFile: f.vetoFile
    });
    expect(await hasVeto(f.vetoFile, { objectiveId: "obj_release", scope: "github:issues:read", userId: "stark" })).toBe(false);
    expect(await hasVeto(f.vetoFile, { objectiveId: "obj_other", scope: "github:issues:write", userId: "stark" })).toBe(false);
  });
});
