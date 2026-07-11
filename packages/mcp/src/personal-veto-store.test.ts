import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  hasVeto,
  queryVetoes,
  readVetoes,
  recordVeto,
  removeVeto,
  type ActionVeto
} from "@muse/stores";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-veto-review-")), "vetoes.json");
}

function veto(overrides: Partial<ActionVeto> = {}): ActionVeto {
  return {
    id: "v1",
    objectiveId: "obj_release",
    scope: "github:issues:write",
    userId: "stark",
    vetoedAt: "2026-05-19T12:00:00.000Z",
    ...overrides
  };
}

/**
 * The exact value `@muse/agent-core` applyVetoAvoidance consumes
 * via the duck-typed VetoAvoidanceProvider — agent-core cannot be
 * imported here (dependency direction is mcp → agent-core), so we
 * assert the provider-shaped input transitions. P7-b1 already
 * pins: non-empty ⇒ the [Learned Avoidance] directive injects;
 * [] ⇒ exact no-op. So "non-empty → [] after clear" IS "the
 * directive no longer injects".
 */
async function avoidanceInput(file: string, userId: string) {
  return (await readVetoes(file))
    .filter((v) => v.userId === userId)
    .map((v) => ({ objectiveId: v.objectiveId, reason: v.reason, scope: v.scope }));
}

describe("personal-veto-store review + clear — P7-b2", () => {
  it("queryVetoes is the user-scoped, newest-first review surface", async () => {
    const file = tmpFile();
    await recordVeto(file, veto({ id: "old", vetoedAt: "2026-05-19T10:00:00.000Z" }));
    await recordVeto(file, veto({ id: "new", vetoedAt: "2026-05-19T14:00:00.000Z" }));
    await recordVeto(file, veto({ id: "other", userId: "wintermute" }));
    const mine = await queryVetoes(file, { userId: "stark" });
    expect(mine.map((v) => v.id)).toEqual(["new", "old"]);
    expect((await queryVetoes(file)).length).toBe(3);
  });

  it("newest-first is by parsed instant, not lexicographic ISO (mixed precision / offset)", async () => {
    const file = tmpFile();
    // UTC instants: zlate (May20 01:00:01) > xmid (May20 00:00:00.500)
    // > yold (May20 00:00:00.000). But lexicographically the strings
    // sort yold > xmid > zlate (the "-05:00" day is "…05-19…", and
    // "…00.500Z" sorts before "…00Z") — the exact 418 footgun.
    await recordVeto(file, veto({ id: "xmid", vetoedAt: "2026-05-20T00:00:00.500Z" }));
    await recordVeto(file, veto({ id: "yold", vetoedAt: "2026-05-20T00:00:00Z" }));
    await recordVeto(file, veto({ id: "zlate", vetoedAt: "2026-05-19T20:00:01-05:00" }));
    expect((await queryVetoes(file, { userId: "stark" })).map((v) => v.id))
      .toEqual(["zlate", "xmid", "yold"]);
  });

  it("missing store → empty review (no error)", async () => {
    expect(await queryVetoes(join(tmpdir(), "no-such-vetoes.json"))).toEqual([]);
  });

  it("review lists the avoidance; clear removes it and the directive no longer injects", async () => {
    const file = tmpFile();
    await recordVeto(file, veto());

    // Review: the user sees the learned avoidance.
    expect((await queryVetoes(file, { userId: "stark" })).map((v) => v.id)).toEqual(["v1"]);
    // The directive WOULD inject (non-empty provider input) and the
    // consented-action gate WOULD block.
    expect(await avoidanceInput(file, "stark")).toEqual([
      { objectiveId: "obj_release", reason: undefined, scope: "github:issues:write" }
    ]);
    expect(await hasVeto(file, { objectiveId: "obj_release", scope: "github:issues:write", userId: "stark" })).toBe(true);

    // Clear: one-tap removal.
    expect(await removeVeto(file, "v1")).toBe(true);

    // The correction is undone: review is empty, the directive no
    // longer injects ([] provider input), the gate no longer blocks.
    expect(await queryVetoes(file, { userId: "stark" })).toEqual([]);
    expect(await avoidanceInput(file, "stark")).toEqual([]);
    expect(await hasVeto(file, { objectiveId: "obj_release", scope: "github:issues:write", userId: "stark" })).toBe(false);
  });

  it("clearing a missing id is a no-op (false), the store is untouched", async () => {
    const file = tmpFile();
    await recordVeto(file, veto());
    expect(await removeVeto(file, "nope")).toBe(false);
    expect((await readVetoes(file)).length).toBe(1);
  });

  it("clear is precise: removing one veto leaves the user's others intact", async () => {
    const file = tmpFile();
    await recordVeto(file, veto({ id: "v1", scope: "github:issues:write" }));
    await recordVeto(file, veto({ id: "v2", scope: "email:send" }));
    expect(await removeVeto(file, "v1")).toBe(true);
    expect((await queryVetoes(file, { userId: "stark" })).map((v) => v.id)).toEqual(["v2"]);
  });

  // Concurrency (shared atomic-file helper migration): recordVeto / removeVeto
  // are read-modify-write. A lost veto = a learned-avoidance the agent forgets,
  // so it re-attempts an action the user already refused (outbound-safety
  // reversibility). These assert lossless, crash-free concurrent record+remove.
  describe("concurrent record + remove", () => {
    it("preserves EVERY distinct veto recorded concurrently (no last-writer-wins loss)", { timeout: 60_000 }, async () => {
      const file = tmpFile();
      await Promise.all(Array.from({ length: 20 }, (_unused, i) =>
        recordVeto(file, veto({ id: `v${i.toString()}`, objectiveId: `obj_${i.toString()}` }))));
      expect(await readVetoes(file)).toHaveLength(20);
      // the avoidance still fires for each recorded class (fail-closed gate sees them)
      expect(await hasVeto(file, { objectiveId: "obj_9", scope: "github:issues:write", userId: "stark" })).toBe(true);
    });

    it("concurrent removes drop exactly the targeted vetoes, leaving the rest intact", { timeout: 60_000 }, async () => {
      const file = tmpFile();
      await Promise.all(Array.from({ length: 20 }, (_unused, i) =>
        recordVeto(file, veto({ id: `v${i.toString()}`, objectiveId: `obj_${i.toString()}` }))));
      await Promise.all(Array.from({ length: 10 }, (_unused, i) => removeVeto(file, `v${i.toString()}`)));
      const remaining = await readVetoes(file);
      expect(remaining).toHaveLength(10);
      expect(remaining.every((v) => Number(v.id.slice(1)) >= 10)).toBe(true);
    });
  });
});
