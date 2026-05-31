import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  patchProposedActionStatus,
  type ProposedAction,
  readProposedActions,
  writeProposedActions,
} from "../src/personal-proposed-action-store.js";

const proposal = (id: string): ProposedAction => ({
  id,
  kind: "message",
  status: "pending",
  createdAt: "2026-01-01T00:00:00Z",
  expiresAt: "2026-01-02T00:00:00Z",
  providerId: "slack",
  destination: "C1",
  text: "hi",
  summary: "summary",
  reason: "reason",
  userId: "u1",
});

let files: string[] = [];
const freshFile = () => {
  const file = join(tmpdir(), `muse-proposed-${randomUUID()}.json`);
  files.push(file);
  return file;
};
afterEach(async () => {
  await Promise.all(files.map((f) => rm(f, { force: true })));
  files = [];
});

describe("writeProposedActions / readProposedActions", () => {
  it("round-trips a list of proposals", async () => {
    const file = freshFile();
    await writeProposedActions(file, [proposal("a"), proposal("b")]);
    expect((await readProposedActions(file)).map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("writes an empty list and reads it back as empty", async () => {
    const file = freshFile();
    await writeProposedActions(file, []);
    expect(await readProposedActions(file)).toEqual([]);
  });
});

describe("patchProposedActionStatus", () => {
  it("sets status + resolvedAt on the matching proposal, leaving others untouched", async () => {
    const file = freshFile();
    await writeProposedActions(file, [proposal("a"), proposal("b")]);

    await patchProposedActionStatus(file, "a", "executed", "2026-01-01T05:00:00Z");
    const afterExecute = await readProposedActions(file);
    expect(afterExecute.find((p) => p.id === "a")).toMatchObject({ status: "executed", resolvedAt: "2026-01-01T05:00:00Z" });
    expect(afterExecute.find((p) => p.id === "b")).toMatchObject({ status: "pending" });

    await patchProposedActionStatus(file, "b", "declined", "2026-01-01T06:00:00Z");
    expect((await readProposedActions(file)).find((p) => p.id === "b")).toMatchObject({ status: "declined" });
  });

  it("is a no-op when the id is not found", async () => {
    const file = freshFile();
    await writeProposedActions(file, [proposal("a")]);
    await patchProposedActionStatus(file, "missing", "executed", "2026-01-01T05:00:00Z");
    expect(await readProposedActions(file)).toEqual([proposal("a")]);
  });
});
