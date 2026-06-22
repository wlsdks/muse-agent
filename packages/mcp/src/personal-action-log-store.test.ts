import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { performConsentedAction } from "@muse/proactivity";
import { runDueObjectives, type ObjectiveEvaluation } from "@muse/proactivity";
import { recordConsent } from "@muse/stores";
import {
  appendActionLog,
  queryActionLog,
  readActionLog,
  type ActionLogEntry
} from "@muse/stores";
import { addObjective, readObjectives, type StandingObjective } from "@muse/stores";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "muse-actionlog-"));
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

const NOW = new Date("2026-05-19T12:00:00.000Z");

describe("personal-action-log-store — P6-b1 reviewable autonomous-action log", () => {
  it("append-only: prior entries are preserved, even on a duplicate id (the log records attempts)", async () => {
    const file = join(tmpDir(), "action-log.json");
    const base: ActionLogEntry = {
      id: "a1",
      result: "performed",
      userId: "stark",
      what: "open issue",
      when: "2026-05-19T12:00:00.000Z",
      why: "release tagged"
    };
    await appendActionLog(file, base);
    await appendActionLog(file, { ...base, id: "a1", when: "2026-05-19T12:05:00.000Z" });
    expect((await readActionLog(file)).length).toBe(2);
  });

  it("missing log → empty; corrupt log → empty AND quarantined aside", async () => {
    expect(await readActionLog(join(tmpdir(), "nope-action-log.json"))).toEqual([]);
    const file = join(tmpDir(), "action-log.json");
    writeFileSync(file, "{ not json");
    expect(await readActionLog(file)).toEqual([]);
    expect(readdirSync(dirname(file)).some((n) => n.includes("action-log.json.corrupt-"))).toBe(true);
  });

  it("drops INDIVIDUAL malformed entries (missing required field / bogus result) while keeping the valid ones — audit integrity", () => {
    // A whole-corrupt file is quarantined; a parseable file with a mix of valid
    // and malformed entries must still surface ONLY the well-formed ones, so a
    // tampered/partial entry can't masquerade as a recorded action.
    const file = join(tmpDir(), "action-log.json");
    writeFileSync(file, JSON.stringify({ version: 1, entries: [
      { id: "ok", result: "performed", userId: "stark", what: "x", when: "2026-05-20T00:00:00Z", why: "r" },
      { id: "no-why", result: "performed", userId: "stark", what: "x", when: "2026-05-20T00:00:00Z" }, // missing required `why`
      { id: "bad-result", result: "exploded", userId: "stark", what: "x", when: "2026-05-20T00:00:00Z", why: "r" }, // not performed/refused/failed
      null,
      "not an object"
    ] }));
    return readActionLog(file).then((entries) => {
      expect(entries.map((e) => e.id)).toEqual(["ok"]);
    });
  });

  it("queryActionLog returns newest-first and scopes to the user", async () => {
    const file = join(tmpDir(), "action-log.json");
    await appendActionLog(file, { id: "old", result: "performed", userId: "stark", what: "x", when: "2026-05-19T10:00:00.000Z", why: "r" });
    await appendActionLog(file, { id: "new", result: "performed", userId: "stark", what: "y", when: "2026-05-19T14:00:00.000Z", why: "r" });
    await appendActionLog(file, { id: "other", result: "performed", userId: "wintermute", what: "z", when: "2026-05-19T15:00:00.000Z", why: "r" });
    const mine = await queryActionLog(file, { userId: "stark" });
    expect(mine.map((e) => e.id)).toEqual(["new", "old"]);
  });

  it("two entries sharing `when` are ordered by id desc — deterministic across reloads (tiebreaker)", async () => {
    const file = join(tmpDir(), "action-log.json");
    const sameWhen = "2026-05-19T12:00:00.000Z";
    await appendActionLog(file, { id: "a", result: "performed", userId: "stark", what: "x", when: sameWhen, why: "r" });
    await appendActionLog(file, { id: "c", result: "performed", userId: "stark", what: "x", when: sameWhen, why: "r" });
    await appendActionLog(file, { id: "b", result: "performed", userId: "stark", what: "x", when: sameWhen, why: "r" });
    const ids = (await queryActionLog(file, { userId: "stark" })).map((e) => e.id);
    expect(ids, "ties on `when` resolve by id desc — deterministic regardless of insertion order").toEqual(["c", "b", "a"]);
  });

  it("newest-first is by parsed instant, not lexicographic ISO (mixed precision / offset)", async () => {
    const file = join(tmpDir(), "action-log.json");
    // UTC instants: zlate (May20 01:00:01) > xmid (May20 00:00:00.500)
    // > yold (May20 00:00:00.000). But the strings sort
    // lexicographically yold > xmid > zlate (the 418/461 footgun:
    // "…00.500Z" < "…00Z", and the "-05:00" day is "…05-19…").
    await appendActionLog(file, { id: "xmid", result: "performed", userId: "stark", what: "x", when: "2026-05-20T00:00:00.500Z", why: "r" });
    await appendActionLog(file, { id: "yold", result: "performed", userId: "stark", what: "y", when: "2026-05-20T00:00:00Z", why: "r" });
    await appendActionLog(file, { id: "zlate", result: "performed", userId: "stark", what: "z", when: "2026-05-19T20:00:01-05:00", why: "r" });
    expect((await queryActionLog(file, { userId: "stark" })).map((e) => e.id))
      .toEqual(["zlate", "xmid", "yold"]);
  });

  it("an autonomous consented action produces a rationale-bearing log entry the user can query", async () => {
    const dir = tmpDir();
    const objectivesFile = join(dir, "objectives.json");
    const consentFile = join(dir, "consents.json");
    const logFile = join(dir, "action-log.json");
    await addObjective(objectivesFile, objective());
    await recordConsent(consentFile, {
      grantedAt: "2026-05-19T11:00:00.000Z",
      id: "c1",
      objectiveId: "obj_release",
      scope: "github:issues:write",
      userId: "stark"
    });

    const summary = await runDueObjectives({
      act: async (o) => {
        const url = "https://api.github.test/repos/x/y/issues";
        const outcome = await performConsentedAction({
          consentFile,
          credential: "ghp-scoped",
          fetchImpl: (async () => new Response(null, { status: 201 })) as unknown as typeof fetch,
          objectiveId: o.id,
          request: { url },
          scope: "github:issues:write",
          userId: o.userId
        });
        await appendActionLog(logFile, {
          id: `act_${o.id}`,
          result: outcome.performed ? "performed" : "refused",
          userId: o.userId,
          what: `POST ${url}`,
          when: NOW.toISOString(),
          why: o.spec,
          objectiveId: o.id,
          detail: outcome.performed ? `HTTP ${outcome.status.toString()}` : outcome.reason
        });
        if (!outcome.performed) {
          throw new Error(outcome.reason);
        }
      },
      evaluate: async (): Promise<ObjectiveEvaluation> => ({ outcome: "met" }),
      file: objectivesFile,
      now: () => NOW
    });

    expect(summary.fired).toEqual(["obj_release"]);
    const log = await queryActionLog(logFile, { userId: "stark" });
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      detail: "HTTP 201",
      objectiveId: "obj_release",
      result: "performed",
      what: "POST https://api.github.test/repos/x/y/issues",
      why: "when the release is tagged, open the changelog issue"
    });
    expect((await readObjectives(objectivesFile))[0]?.status).toBe("done");
  });

  it("a fail-closed refusal is also logged — accountability covers what was NOT done", async () => {
    const dir = tmpDir();
    const objectivesFile = join(dir, "objectives.json");
    const consentFile = join(dir, "consents.json");
    const logFile = join(dir, "action-log.json");
    await addObjective(objectivesFile, objective({ id: "obj_noconsent" }));

    await runDueObjectives({
      act: async (o) => {
        const outcome = await performConsentedAction({
          consentFile,
          credential: "ghp-scoped",
          fetchImpl: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
          objectiveId: o.id,
          request: { url: "https://api.github.test/repos/x/y/issues" },
          scope: "github:issues:write",
          userId: o.userId
        });
        await appendActionLog(logFile, {
          id: `act_${o.id}`,
          result: outcome.performed ? "performed" : "refused",
          userId: o.userId,
          what: "POST https://api.github.test/repos/x/y/issues",
          when: NOW.toISOString(),
          why: o.spec,
          objectiveId: o.id,
          detail: outcome.performed ? "ok" : outcome.reason
        });
        if (!outcome.performed) {
          throw new Error(outcome.reason);
        }
      },
      evaluate: async (): Promise<ObjectiveEvaluation> => ({ outcome: "met" }),
      file: objectivesFile,
      now: () => NOW
    });

    const log = await queryActionLog(logFile, { userId: "stark" });
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ result: "refused", detail: "no recorded consent for scope github:issues:write" });
    expect((await readObjectives(objectivesFile))[0]?.status).toBe("active");
  });
});
