import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  findConsent,
  hasConsent,
  isConsentActive,
  readConsents,
  recordConsent,
  serializeConsent,
  type ScopedConsent
} from "../src/personal-consent-store.js";

let dir: string;
let file: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "muse-consent-")); file = join(dir, "consents.json"); });
afterEach(async () => { await rm(dir, { force: true, recursive: true }); });

const consent = (over: Partial<ScopedConsent> = {}): ScopedConsent => ({
  grantedAt: "2026-06-01T00:00:00Z",
  id: "c1",
  objectiveId: "o1",
  scope: "github:issues:write",
  userId: "u",
  ...over
});

// The fail-closed scoped-consent gate behind performConsentedAction
// (outbound-safety.md rule 5: standing objectives need RECORDED scoped consent,
// never implicitly broadened).
describe("hasConsent — fail-closed exact-match gate", () => {
  it("returns false for a missing store (no consent ⇒ no action)", async () => {
    expect(await hasConsent(join(dir, "absent.json"), { objectiveId: "o1", scope: "github:issues:write", userId: "u" })).toBe(false);
  });

  it("returns true only on an exact user + objective + scope match", async () => {
    await recordConsent(file, consent());
    expect(await hasConsent(file, { objectiveId: "o1", scope: "github:issues:write", userId: "u" })).toBe(true);
  });

  it("never broadens: a consent for one scope does NOT authorize a different scope", async () => {
    await recordConsent(file, consent({ scope: "github:issues:write" }));
    expect(await hasConsent(file, { objectiveId: "o1", scope: "github:repo:delete", userId: "u" })).toBe(false);
  });

  it("does not cross users or objectives", async () => {
    await recordConsent(file, consent());
    expect(await hasConsent(file, { objectiveId: "o1", scope: "github:issues:write", userId: "someone-else" })).toBe(false);
    expect(await hasConsent(file, { objectiveId: "different-objective", scope: "github:issues:write", userId: "u" })).toBe(false);
  });
});

describe("recordConsent", () => {
  it("is idempotent on id — a re-grant updates the record without duplicating", async () => {
    await recordConsent(file, consent());
    await recordConsent(file, consent({ grantedAt: "2026-06-02T00:00:00Z", note: "re-approved" }));
    const all = await readConsents(file);
    expect(all).toHaveLength(1);
    expect(all[0]?.note).toBe("re-approved");
  });
});

// TTL / expiry on standing-objective consents (outbound-safety.md rule 5 +
// least-privilege time-bound permissions): a consent past its expiresAt is
// treated as ABSENT — fail-closed — never as a still-good grant.
describe("expiry — a consent past its expiresAt is treated as ABSENT", () => {
  const NOW = new Date("2026-06-10T12:00:00Z");

  it("findConsent returns undefined for a consent whose expiresAt is in the PAST relative to `now`", async () => {
    await recordConsent(file, consent({ expiresAt: "2026-06-10T11:59:59Z" }));
    expect(await findConsent(file, { objectiveId: "o1", scope: "github:issues:write", userId: "u" }, NOW)).toBeUndefined();
  });

  it("findConsent returns the consent when expiresAt is in the FUTURE relative to `now`", async () => {
    await recordConsent(file, consent({ expiresAt: "2026-06-10T12:00:01Z" }));
    const found = await findConsent(file, { objectiveId: "o1", scope: "github:issues:write", userId: "u" }, NOW);
    expect(found?.id).toBe("c1");
  });

  it("findConsent returns the consent when expiresAt is ABSENT (back-compat, no expiry)", async () => {
    await recordConsent(file, consent());
    const found = await findConsent(file, { objectiveId: "o1", scope: "github:issues:write", userId: "u" }, NOW);
    expect(found?.id).toBe("c1");
  });

  it("hasConsent mirrors findConsent: false when expired, true when future or absent expiresAt", async () => {
    await recordConsent(file, consent({ expiresAt: "2026-06-10T11:59:59Z" }));
    expect(await hasConsent(file, { objectiveId: "o1", scope: "github:issues:write", userId: "u" }, NOW)).toBe(false);

    await recordConsent(file, consent({ expiresAt: "2026-06-10T12:00:01Z" }));
    expect(await hasConsent(file, { objectiveId: "o1", scope: "github:issues:write", userId: "u" }, NOW)).toBe(true);

    await recordConsent(file, consent({ expiresAt: undefined }));
    expect(await hasConsent(file, { objectiveId: "o1", scope: "github:issues:write", userId: "u" }, NOW)).toBe(true);
  });

  it("isConsentActive: absent ⇒ active, future ⇒ active, past ⇒ inactive, unparseable ⇒ INACTIVE (fail-closed — a credential gate must not authorise on a corrupt timestamp)", () => {
    expect(isConsentActive(consent(), NOW)).toBe(true);
    expect(isConsentActive(consent({ expiresAt: "2026-06-10T12:00:01Z" }), NOW)).toBe(true);
    expect(isConsentActive(consent({ expiresAt: "2026-06-10T11:59:59Z" }), NOW)).toBe(false);
    expect(isConsentActive(consent({ expiresAt: "not-a-date" }), NOW)).toBe(false);
  });

  it("SECURITY: a consent with a corrupt/unparseable expiresAt fails CLOSED — findConsent + hasConsent both refuse it (a partial-write/tampered timestamp must not authorise forever)", async () => {
    await recordConsent(file, consent({ expiresAt: "garbage-not-a-timestamp" }));
    expect(await findConsent(file, { objectiveId: "o1", scope: "github:issues:write", userId: "u" }, NOW)).toBeUndefined();
    expect(await hasConsent(file, { objectiveId: "o1", scope: "github:issues:write", userId: "u" }, NOW)).toBe(false);
  });

  it("readConsents stays a RAW reader — it does not filter expired records out (expiry is enforced at findConsent/hasConsent)", async () => {
    await recordConsent(file, consent({ expiresAt: "2020-01-01T00:00:00Z" }));
    const all = await readConsents(file);
    expect(all).toHaveLength(1);
    expect(all[0]?.expiresAt).toBe("2020-01-01T00:00:00Z");
  });

  it("round-trips expiresAt through writeConsents/readConsents (isRecord validator accepts it)", async () => {
    await recordConsent(file, consent({ expiresAt: "2026-07-01T00:00:00Z" }));
    const all = await readConsents(file);
    expect(all[0]?.expiresAt).toBe("2026-07-01T00:00:00Z");
  });
});

describe("serializeConsent", () => {
  it("emits the five required fields and includes note only when set", () => {
    expect(Object.keys(serializeConsent(consent())).sort()).toEqual(["grantedAt", "id", "objectiveId", "scope", "userId"]);
    expect(serializeConsent(consent({ note: "approved in chat" }))).toHaveProperty("note", "approved in chat");
  });
});

describe("readConsents", () => {
  it("rejects blank host bindings and wrong-typed notes at the persisted boundary", async () => {
    await writeFile(file, JSON.stringify({
      consents: [
        consent(),
        consent({ allowedHost: " ", id: "blank-host" }),
        consent({ id: "bad-note", note: 7 as unknown as string })
      ]
    }));
    expect((await readConsents(file)).map((entry) => entry.id)).toEqual(["c1"]);
  });
});
