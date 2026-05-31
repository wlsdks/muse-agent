import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { patchObjective, readObjectives, type StandingObjective, writeObjectives } from "../src/personal-objectives-store.js";

const objective = (id: string): StandingObjective => ({
  id,
  userId: "u1",
  createdAt: "2026-01-01T00:00:00Z",
  spec: "watch the build until it is green",
  kind: "watch",
  status: "active",
});

let files: string[] = [];
const freshFile = () => {
  const file = join(tmpdir(), `muse-objectives-${randomUUID()}.json`);
  files.push(file);
  return file;
};
afterEach(async () => {
  await Promise.all(files.map((f) => rm(f, { force: true })));
  files = [];
});

describe("patchObjective", () => {
  it("merges the patch into the matching objective and returns it, leaving others untouched", async () => {
    const file = freshFile();
    await writeObjectives(file, [objective("a"), objective("b")]);

    const patched = await patchObjective(file, "a", { status: "escalated", attempts: 2 });
    expect(patched).toMatchObject({ id: "a", status: "escalated", attempts: 2 });

    const all = await readObjectives(file);
    expect(all.find((o) => o.id === "a")).toMatchObject({ status: "escalated", attempts: 2 });
    expect(all.find((o) => o.id === "b")).toMatchObject({ status: "active" });
  });

  it("never lets the patch overwrite the id", async () => {
    const file = freshFile();
    await writeObjectives(file, [objective("a")]);
    const patched = await patchObjective(file, "a", { id: "HIJACK", status: "done" } as Partial<StandingObjective>);
    expect(patched?.id).toBe("a");
    expect((await readObjectives(file)).map((o) => o.id)).toEqual(["a"]);
  });

  it("returns undefined and writes nothing when the id is not found", async () => {
    const file = freshFile();
    await writeObjectives(file, [objective("a")]);
    expect(await patchObjective(file, "missing", { status: "done" })).toBeUndefined();
    expect((await readObjectives(file)).find((o) => o.id === "a")).toMatchObject({ status: "active" });
  });

  it("returns undefined on an empty / missing store", async () => {
    const file = freshFile();
    expect(await patchObjective(file, "anything", { status: "done" })).toBeUndefined();
  });
});
