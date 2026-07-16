import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readActionLog } from "../src/personal-action-log-store.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(join(tmpdir(), "action-log-validation-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe("readActionLog persisted-entry validation", () => {
  it("rejects non-string optional fields before they reach action-log consumers", async () => {
    const file = join(dir, "actions.json");
    await fs.writeFile(file, JSON.stringify({
      entries: [{
        id: "invalid-optional-fields",
        result: "performed",
        userId: "u",
        what: "did thing",
        when: "2026-07-16T00:00:00.000Z",
        why: "because",
        detail: { nested: "untrusted" },
        objectiveId: 42
      }]
    }));

    await expect(readActionLog(file)).resolves.toEqual([]);
  });
});
