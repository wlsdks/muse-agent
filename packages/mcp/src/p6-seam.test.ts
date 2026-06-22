import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { performConsentedAction } from "./consented-action.js";
import { runDueObjectives, type ObjectiveEvaluation } from "./objective-evaluation-loop.js";
import { appendActionLog, queryActionLog } from "@muse/stores";
import { recordConsent } from "@muse/stores";
import { hasVeto } from "@muse/stores";
import { addObjective, readObjectives, type StandingObjective } from "@muse/stores";
import { undoLoggedAction } from "./undo-action.js";

/**
 * P6 target audit (the P→P seam check). P6's two bullets ARE a
 * composed correction loop, not independent closures: an
 * autonomous action is logged (b1) → the user reviews it → undoes
 * it (b2) → the undo is ITSELF logged (b1) → the durable veto
 * blocks the same trigger → that refusal is logged too (b1). The
 * seam the two isolated tests do not cover together is the WHOLE
 * cycle through the real on-disk stores surviving a process
 * restart — the "see · undo · teach" north star end-to-end.
 *
 * Every store read below is a fresh call sharing no in-memory
 * state with the writes = exactly what a restarted process sees.
 */
const SCOPE = "github:issues:write";
const URL = "https://api.github.test/repos/x/y/issues";

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

describe("P6 audit — see → undo → teach correction loop composes and survives a restart", () => {
  it("the full audit trail (action → undo → vetoed refusal) is durable and the trigger no longer auto-acts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-p6-seam-"));
    const objectivesFile = join(dir, "objectives.json");
    const consentFile = join(dir, "consents.json");
    const vetoFile = join(dir, "vetoes.json");
    const actionLogFile = join(dir, "action-log.json");

    await addObjective(objectivesFile, objective());
    await recordConsent(consentFile, {
      grantedAt: "2026-05-19T11:00:00.000Z",
      id: "c1",
      objectiveId: "obj_release",
      scope: SCOPE,
      userId: "stark"
    });

    let httpCalls = 0;
    let seq = 0;
    let tickNowIso = "2026-05-19T12:00:00.000Z";
    const act = async (o: StandingObjective): Promise<void> => {
      seq += 1;
      const outcome = await performConsentedAction({
        consentFile,
        credential: "ghp-scoped",
        fetchImpl: (async () => {
          httpCalls += 1;
          return new Response(null, { status: 201 });
        }) as unknown as typeof fetch,
        objectiveId: o.id,
        request: { url: URL },
        scope: SCOPE,
        userId: o.userId,
        vetoFile
      });
      await appendActionLog(actionLogFile, {
        detail: outcome.performed ? `HTTP ${outcome.status.toString()}` : outcome.reason,
        id: `act_${o.id}_${seq.toString()}`,
        objectiveId: o.id,
        result: outcome.performed ? "performed" : "refused",
        userId: o.userId,
        what: `POST ${URL}`,
        when: tickNowIso,
        why: o.spec
      });
      if (!outcome.performed) {
        throw new Error(outcome.reason);
      }
    };

    // 1. Autonomous action performs and is logged (b1).
    const first = await runDueObjectives({
      act,
      evaluate: async (): Promise<ObjectiveEvaluation> => ({ outcome: "met" }),
      file: objectivesFile,
      now: () => new Date("2026-05-19T12:00:00.000Z")
    });
    expect(first.fired).toEqual(["obj_release"]);
    expect(httpCalls).toBe(1);

    // 2. The user reviews the log and sees it.
    expect((await queryActionLog(actionLogFile, { userId: "stark" }))[0]).toMatchObject({
      detail: "HTTP 201",
      result: "performed"
    });

    // 3. The user undoes it: reverse + record veto + log the undo (b2 + b1).
    const undo = await undoLoggedAction({
      actionLogFile,
      now: () => new Date("2026-05-19T13:00:00.000Z"),
      objectiveId: "obj_release",
      originalActionId: "act_obj_release_1",
      reason: "wrong repo",
      reverse: async () => ({ detail: "closed issue #42" }),
      scope: SCOPE,
      userId: "stark",
      vetoFile
    });
    expect(undo.reversed).toBe(true);

    // 4. "Restart": the veto + log survived to disk.
    expect(await hasVeto(vetoFile, { objectiveId: "obj_release", scope: SCOPE, userId: "stark" })).toBe(true);

    // 5. The same trigger recurs — the durable veto blocks it and
    //    the refusal is logged too (b1 covers what was NOT done).
    await addObjective(objectivesFile, objective());
    tickNowIso = "2026-05-19T14:00:00.000Z";
    const second = await runDueObjectives({
      act,
      evaluate: async (): Promise<ObjectiveEvaluation> => ({ outcome: "met" }),
      file: objectivesFile,
      now: () => new Date("2026-05-19T14:00:00.000Z")
    });
    expect(second.fired).toEqual([]);
    expect(httpCalls).toBe(1); // the consented action did NOT fire again
    expect((await readObjectives(objectivesFile))[0]?.status).toBe("active");

    // 6. Final "restart": the full audit trail is durable and
    //    review-queryable, newest-first.
    const trail = await queryActionLog(actionLogFile, { userId: "stark" });
    expect(trail.map((e) => ({ result: e.result, what: e.what }))).toEqual([
      { result: "refused", what: `POST ${URL}` },
      { result: "performed", what: "undo of action act_obj_release_1" },
      { result: "performed", what: `POST ${URL}` }
    ]);
    expect(trail[0]?.detail).toContain("vetoed");
  });
});
