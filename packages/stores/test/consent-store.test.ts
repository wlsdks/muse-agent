import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  hasConsent,
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

describe("serializeConsent", () => {
  it("emits the five required fields and includes note only when set", () => {
    expect(Object.keys(serializeConsent(consent())).sort()).toEqual(["grantedAt", "id", "objectiveId", "scope", "userId"]);
    expect(serializeConsent(consent({ note: "approved in chat" }))).toHaveProperty("note", "approved in chat");
  });
});
