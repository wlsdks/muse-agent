import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  hasConsent,
  readConsents,
  recordConsent,
  type ScopedConsent
} from "@muse/stores";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-consent-")), "consents.json");
}

function consent(overrides: Partial<ScopedConsent> = {}): ScopedConsent {
  return {
    grantedAt: "2026-05-20T12:00:00.000Z",
    id: "c1",
    objectiveId: "obj_release",
    scope: "github:issues:write",
    userId: "stark",
    ...overrides
  };
}

const Q = { objectiveId: "obj_release", scope: "github:issues:write", userId: "stark" } as const;

describe("personal-consent-store — fail-closed autonomous-action gate", () => {
  it("grants only on an EXACT {userId,objectiveId,scope} match — never broadened", async () => {
    const file = tmpFile();
    await recordConsent(file, consent());

    expect(await hasConsent(file, Q)).toBe(true);
    // Scope is never broadened implicitly: a narrower/related scope
    // is NOT covered by the recorded one.
    expect(await hasConsent(file, { ...Q, scope: "github:issues:read" })).toBe(false);
    expect(await hasConsent(file, { ...Q, scope: "github:*" })).toBe(false);
    expect(await hasConsent(file, { ...Q, scope: "github:issues" })).toBe(false);
    expect(await hasConsent(file, { ...Q, scope: "github:issues:write:extra" })).toBe(false);
    // Cross-user / cross-objective isolation.
    expect(await hasConsent(file, { ...Q, userId: "other" })).toBe(false);
    expect(await hasConsent(file, { ...Q, objectiveId: "obj_other" })).toBe(false);
  });

  it("absence / unreadable / corrupt store ⇒ false (no consent ⇒ no action)", async () => {
    const missing = tmpFile();
    expect(await hasConsent(missing, Q)).toBe(false); // no file at all

    const corrupt = tmpFile();
    writeFileSync(corrupt, "{ not valid json");
    expect(await hasConsent(corrupt, Q)).toBe(false);
    // Corrupt store is quarantined aside, never silently trusted.
    const sidecars = readdirSync(dirname(corrupt)).filter((n) => n.includes(".corrupt-"));
    expect(sidecars.length).toBe(1);

    const wrongShape = tmpFile();
    writeFileSync(wrongShape, JSON.stringify({ consents: "not-an-array" }));
    expect(await hasConsent(wrongShape, Q)).toBe(false);
  });

  it("a malformed entry can't act as a phantom grant; valid siblings still count", async () => {
    const file = tmpFile();
    writeFileSync(
      file,
      JSON.stringify({
        consents: [
          { scope: "github:issues:write" }, // missing userId/objectiveId/id/grantedAt
          consent({ id: "c2" })
        ]
      })
    );
    // The malformed entry is filtered by isScopedConsent — it must
    // not satisfy a query that "looks like" it.
    expect((await readConsents(file)).map((c) => c.id)).toEqual(["c2"]);
    expect(await hasConsent(file, Q)).toBe(true); // only the valid c2 grants
  });

  it("recordConsent is idempotent on id — re-grant REPLACES, never duplicates", async () => {
    const file = tmpFile();
    await recordConsent(file, consent());
    await recordConsent(file, consent({ note: "re-approved", scope: "github:issues:write" }));

    const all = await readConsents(file);
    expect(all).toHaveLength(1);
    expect(all[0]?.note).toBe("re-approved");

    // A genuinely different id is an additional grant, not a replace.
    await recordConsent(file, consent({ id: "c2", objectiveId: "obj_two" }));
    expect((await readConsents(file)).map((c) => c.id).sort()).toEqual(["c1", "c2"]);
  });

  // Concurrency (shared atomic-file helper migration): recordConsent is a
  // read-modify-write. A dropped grant is outbound-safety-relevant (rule 5: a
  // standing objective acts toward a third party ONLY with recorded scoped
  // consent — a silently-lost grant wrongly refuses a legitimate action, and a
  // racing write could corrupt the set the fail-closed check reads).
  describe("concurrent grants", () => {
    it("preserves EVERY distinct consent granted concurrently (no last-writer-wins loss)", async () => {
      const file = tmpFile();
      await Promise.all(Array.from({ length: 20 }, (_unused, i) =>
        recordConsent(file, consent({ id: `c${i.toString()}`, objectiveId: `obj_${i.toString()}` }))));
      const all = await readConsents(file);
      expect(all).toHaveLength(20);
      // every grant remains individually checkable (the fail-closed gate sees them all)
      expect(await hasConsent(file, { objectiveId: "obj_7", scope: "github:issues:write", userId: "stark" })).toBe(true);
    });

    it("re-granting the same id concurrently converges to a single record (idempotent under races)", async () => {
      const file = tmpFile();
      await Promise.all(Array.from({ length: 15 }, () => recordConsent(file, consent({ id: "c1" }))));
      expect(await readConsents(file)).toHaveLength(1);
    });
  });
});
