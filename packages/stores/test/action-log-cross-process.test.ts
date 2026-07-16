import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ACTION_LOG_GENESIS_HASH,
  appendActionLog,
  computeEntryHash,
  readActionLog,
  verifyActionLogChain,
  type ActionLogEntry
} from "../src/personal-action-log-store.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(join(tmpdir(), "action-log-cross-process-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const entry = (i: number): ActionLogEntry => ({
  id: `a${i.toString()}`,
  result: "performed",
  userId: "u",
  what: `did thing ${i.toString()}`,
  when: `2026-07-16T00:00:0${i.toString()}.000Z`,
  why: "because"
});

describe("appendActionLog cross-process safety", () => {
  it("preserves an append committed while this process waits for the file lock", async () => {
    const file = join(dir, "actions.json");
    await appendActionLog(file, entry(0));

    await fs.writeFile(`${file}.lock`, "external writer", { flag: "wx" });
    const localAppend = appendActionLog(file, entry(1));
    await sleep(300);

    const first = (await readActionLog(file))[0]!;
    const external: ActionLogEntry = {
      ...entry(2),
      prevHash: computeEntryHash(first, first.prevHash ?? ACTION_LOG_GENESIS_HASH)
    };
    await fs.writeFile(file, `${JSON.stringify({ entries: [first, external] }, null, 2)}\n`);
    await fs.unlink(`${file}.lock`);

    await localAppend;
    const entries = await readActionLog(file);
    expect(entries.map(({ id }) => id)).toEqual(["a0", "a2", "a1"]);
    expect(verifyActionLogChain(entries)).toMatchObject({ ok: true, linkedEntries: 3 });
  });
});
