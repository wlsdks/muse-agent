import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { performConsentedAction } from "../src/consented-action.js";
import { recordConsent } from "../src/personal-consent-store.js";
import { readActionLog } from "../src/personal-action-log-store.js";
import { hasVeto } from "../src/personal-veto-store.js";
import { undoLoggedAction } from "../src/undo-action.js";

let dir: string;
let vetoFile: string;
let actionLogFile: string;
let consentFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-undo-"));
  vetoFile = join(dir, "veto.json");
  actionLogFile = join(dir, "actions.json");
  consentFile = join(dir, "consent.json");
});
afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

const OBJ = "obj-1";
const SCOPE = "github:issues:write";
const base = (over = {}) => ({
  actionLogFile,
  objectiveId: OBJ,
  originalActionId: "act-123",
  scope: SCOPE,
  userId: "u1",
  vetoFile,
  ...over
});

describe("undoLoggedAction — undo + teach (records a veto so it cannot recur)", () => {
  it("reverses a reversible action, records the veto, and logs the undo as performed", async () => {
    let reverseCalled = false;
    const result = await undoLoggedAction(base({
      reason: "wrong repo",
      reverse: async () => { reverseCalled = true; return { detail: "closed issue #42" }; }
    }));
    expect(result.reversed).toBe(true);
    expect(reverseCalled).toBe(true);
    expect(await hasVeto(vetoFile, { objectiveId: OBJ, scope: SCOPE, userId: "u1" })).toBe(true);
    const entry = (await readActionLog(actionLogFile)).at(-1);
    expect(entry).toMatchObject({ result: "performed", what: "undo of action act-123", why: "wrong repo" });
    expect(entry!.detail).toBe("closed issue #42");
  });

  it("for an IRREVERSIBLE action (no inverse) still records the veto so it can't recur", async () => {
    const result = await undoLoggedAction(base());
    expect(result.reversed).toBe(false);
    expect(await hasVeto(vetoFile, { objectiveId: OBJ, scope: SCOPE, userId: "u1" })).toBe(true);
    expect((await readActionLog(actionLogFile)).at(-1)!.detail).toContain("irreversible");
  });

  it("the recorded veto then OVERRIDES prior consent — the same action class no longer auto-acts", async () => {
    // grant consent, then undo (records the veto), then a consented action for
    // the SAME {objective,scope} must be refused before any HTTP fires.
    await recordConsent(consentFile, { grantedAt: "2026-05-31T00:00:00Z", id: "c1", objectiveId: OBJ, scope: SCOPE, userId: "u1" });
    await undoLoggedAction(base());
    let fetched = false;
    const fetchImpl = (async () => { fetched = true; return new Response("", { status: 200 }); }) as unknown as typeof fetch;
    const outcome = await performConsentedAction({
      consentFile,
      credential: "tok",
      fetchImpl,
      objectiveId: OBJ,
      request: { url: "https://api.test/x" },
      scope: SCOPE,
      userId: "u1",
      vetoFile
    });
    expect(outcome).toMatchObject({ performed: false });
    expect((outcome as { reason: string }).reason).toContain("vetoed");
    expect(fetched).toBe(false); // the veto from undo blocked the re-action
  });
});
