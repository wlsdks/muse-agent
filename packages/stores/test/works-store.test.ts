import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  addWorkOutcome,
  createWork,
  deleteWork,
  encryptWorksAtRest,
  getWork,
  isWorksEncrypted,
  linkWorkBoardTask,
  linkWorkFlow,
  listWorks,
  markWorkDone,
  pruneDeletedFlowRefs,
  readWorks,
  resolveWorkId,
  serializeWork,
  setWorkThread,
  syncWorksOnFlowDelete,
  unlinkWorkFlow,
  unlinkWorkThread,
  updateWork,
  WorkExactReadError,
  WorksStoreError,
  writeWorks,
  type PersistedWork
} from "../src/works-store.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-works-"));
  file = join(dir, "works.json");
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

const ALWAYS_EXISTS = () => true;
const NEVER_EXISTS = () => false;

describe("createWork / readWorks / getWork / listWorks", () => {
  it("creates a Work with the reference-only shape, empty links, active status", async () => {
    const work = await createWork(file, { name: "생일 파티 준비", goal: "다음 주 토요일까지 준비 끝내기" }, process.env, {
      idFactory: () => "work_11111111-1111-4111-8111-111111111111",
      now: () => new Date("2026-07-17T00:00:00.000Z")
    });
    expect(work).toEqual({
      boardTaskIds: [],
      createdAtIso: "2026-07-17T00:00:00.000Z",
      flowIds: [],
      goal: "다음 주 토요일까지 준비 끝내기",
      id: "work_11111111-1111-4111-8111-111111111111",
      name: "생일 파티 준비",
      outcomes: [],
      status: "active",
      updatedAtIso: "2026-07-17T00:00:00.000Z"
    });
    expect(await getWork(file, "work_11111111-1111-4111-8111-111111111111")).toEqual(work);
  });

  it("rejects an empty name or goal", async () => {
    await expect(createWork(file, { name: "  ", goal: "x" })).rejects.toThrow(WorksStoreError);
    await expect(createWork(file, { name: "x", goal: "" })).rejects.toThrow(WorksStoreError);
  });

  it("listWorks sorts most-recently-touched first", async () => {
    await createWork(file, { name: "A", goal: "a" }, process.env, { idFactory: () => "work_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", now: () => new Date("2026-01-01T00:00:00.000Z") });
    await createWork(file, { name: "B", goal: "b" }, process.env, { idFactory: () => "work_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", now: () => new Date("2026-02-01T00:00:00.000Z") });
    const listed = await listWorks(file);
    expect(listed.map((w) => w.id)).toEqual([
      "work_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "work_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    ]);
  });

  it("getWork returns undefined for an unknown id (never throws on a read)", async () => {
    expect(await getWork(file, "nope")).toBeUndefined();
  });
});

describe("resolveWorkId — exact id first, else a UNIQUE prefix, never a guess (pure)", () => {
  const works: PersistedWork[] = [
    {
      boardTaskIds: [], createdAtIso: "2026-01-01T00:00:00.000Z", flowIds: [], goal: "g",
      id: "work_bb5cb52d-3812-4a11-9000-000000000001", name: "A", outcomes: [], status: "active",
      updatedAtIso: "2026-01-01T00:00:00.000Z"
    },
    {
      boardTaskIds: [], createdAtIso: "2026-01-01T00:00:00.000Z", flowIds: [], goal: "g",
      id: "work_aaaaaaaa-0000-4a11-9000-000000000002", name: "B", outcomes: [], status: "active",
      updatedAtIso: "2026-01-01T00:00:00.000Z"
    },
    // Shares the "work_dupe" prefix with the next entry — an ambiguity fixture.
    {
      boardTaskIds: [], createdAtIso: "2026-01-01T00:00:00.000Z", flowIds: [], goal: "g",
      id: "work_dupe1111-0000-4a11-9000-000000000003", name: "C1", outcomes: [], status: "active",
      updatedAtIso: "2026-01-01T00:00:00.000Z"
    },
    {
      boardTaskIds: [], createdAtIso: "2026-01-01T00:00:00.000Z", flowIds: [], goal: "g",
      id: "work_dupe2222-0000-4a11-9000-000000000004", name: "C2", outcomes: [], status: "active",
      updatedAtIso: "2026-01-01T00:00:00.000Z"
    }
  ];

  it("resolves an EXACT id even when it also happens to be a valid prefix of nothing else", () => {
    expect(resolveWorkId(works, "work_bb5cb52d-3812-4a11-9000-000000000001")).toBe("work_bb5cb52d-3812-4a11-9000-000000000001");
  });

  it("resolves a UNIQUE short prefix — the exact id `muse work start` prints", () => {
    expect(resolveWorkId(works, "work_bb5cb")).toBe("work_bb5cb52d-3812-4a11-9000-000000000001");
    expect(resolveWorkId(works, "work_aaaaaaaa")).toBe("work_aaaaaaaa-0000-4a11-9000-000000000002");
  });

  it("REFUSES an AMBIGUOUS prefix shared by two Works — never guesses", () => {
    expect(resolveWorkId(works, "work_dupe")).toBeUndefined();
  });

  it("returns undefined for a miss, an empty string, and a too-short prefix (below the min-length floor)", () => {
    expect(resolveWorkId(works, "work_zzzzzzzz")).toBeUndefined();
    expect(resolveWorkId(works, "")).toBeUndefined();
    expect(resolveWorkId(works, "   ")).toBeUndefined();
    // "work_" alone would match every Work — below the floor, refused rather than guessing.
    expect(resolveWorkId(works, "work_")).toBeUndefined();
  });
});

describe("short id round-trip — every read/mutate op accepts a unique id PREFIX, not just the full id", () => {
  it("show (getWork) resolves a short prefix", async () => {
    const work = await createWork(file, { goal: "goal", name: "Name" }, process.env, { idFactory: () => "work_bb5cb52d-3812-4a11-9000-000000000001" });
    const short = work.id.slice(0, 10);
    expect(await getWork(file, short)).toEqual(work);
  });

  it("updateWork / addWorkOutcome / markWorkDone / deleteWork all resolve a short prefix", async () => {
    const work = await createWork(file, { goal: "goal", name: "Name" }, process.env, { idFactory: () => "work_bb5cb52d-3812-4a11-9000-000000000002" });
    const short = work.id.slice(0, 10);

    const renamed = await updateWork(file, short, { name: "Renamed" });
    expect(renamed.id).toBe(work.id);

    const withOutcome = await addWorkOutcome(file, short, { kind: "used" });
    expect(withOutcome.outcomes).toHaveLength(1);

    const done = await markWorkDone(file, short);
    expect(done.status).toBe("done");

    expect(await deleteWork(file, short)).toBe(true);
    expect(await getWork(file, work.id)).toBeUndefined();
  });

  it("linkWorkFlow resolves the WORK's own short prefix (the link TARGET id is unaffected)", async () => {
    const work = await createWork(file, { goal: "goal", name: "Name" }, process.env, { idFactory: () => "work_bb5cb52d-3812-4a11-9000-000000000003" });
    const short = work.id.slice(0, 10);
    const linked = await linkWorkFlow(file, short, "job_1", ALWAYS_EXISTS);
    expect(linked.id).toBe(work.id);
    expect(linked.flowIds).toEqual(["job_1"]);
  });

  it("a miss reports the TRIED id and a `muse work list` hint (원인+원문+다음 행동)", async () => {
    await expect(getWork(file, "work_totally_missing")).resolves.toBeUndefined();
    await expect(updateWork(file, "work_totally_missing", { name: "x" })).rejects.toThrow(
      /no work with id 'work_totally_missing'.*muse work list/u
    );
  });
});

describe("referential integrity — link ops refuse a nonexistent target id (fail-close, no partial write)", () => {
  it("REFUSES linkWorkFlow to a nonexistent flow id, naming the id, and leaves the store byte-unchanged", async () => {
    const work = await createWork(file, { name: "Trip", goal: "plan it" }, process.env, { idFactory: () => "work_11111111-1111-4111-8111-111111111111" });
    const before = await readFile(file, "utf8");

    await expect(linkWorkFlow(file, work.id, "job_missing", NEVER_EXISTS)).rejects.toThrow(/no flow.*job_missing/);

    const after = await readFile(file, "utf8");
    expect(after).toBe(before);
    expect((await getWork(file, work.id))?.flowIds).toEqual([]);
  });

  it("REFUSES linkWorkBoardTask to a nonexistent task id, naming the id, and leaves the store unchanged", async () => {
    const work = await createWork(file, { name: "Trip", goal: "plan it" }, process.env, { idFactory: () => "work_11111111-1111-4111-8111-111111111111" });
    const before = await readWorks(file);

    await expect(linkWorkBoardTask(file, work.id, "task_missing", NEVER_EXISTS)).rejects.toThrow(/no board task.*task_missing/);

    expect(await readWorks(file)).toEqual(before);
  });

  it("REFUSES setWorkThread to a nonexistent thread id, naming the id, and leaves the store unchanged", async () => {
    const work = await createWork(file, { name: "Trip", goal: "plan it" }, process.env, { idFactory: () => "work_11111111-1111-4111-8111-111111111111" });
    const before = await readWorks(file);

    await expect(setWorkThread(file, work.id, "thread_missing", NEVER_EXISTS)).rejects.toThrow(/no continuity thread.*thread_missing/);

    expect(await readWorks(file)).toEqual(before);
  });

  it("links successfully when the validator confirms the target exists", async () => {
    const work = await createWork(file, { name: "Trip", goal: "plan it" }, process.env, { idFactory: () => "work_11111111-1111-4111-8111-111111111111" });
    const linked = await linkWorkFlow(file, work.id, "job_1", ALWAYS_EXISTS);
    expect(linked.flowIds).toEqual(["job_1"]);
    // Idempotent re-link — no duplicate entry.
    const relinked = await linkWorkFlow(file, work.id, "job_1", ALWAYS_EXISTS);
    expect(relinked.flowIds).toEqual(["job_1"]);
  });

  it("linking to an unknown WORK id throws and touches nothing", async () => {
    await expect(linkWorkFlow(file, "no_such_work", "job_1", ALWAYS_EXISTS)).rejects.toThrow(/no work with id 'no_such_work'/);
    expect(await readWorks(file)).toEqual([]);
  });
});

describe("unlink ops are idempotent (never error on an absent reference)", () => {
  it("unlinkWorkFlow / unlinkWorkThread on a Work that never had the ref is a no-op", async () => {
    const work = await createWork(file, { name: "Trip", goal: "plan it" }, process.env, { idFactory: () => "work_11111111-1111-4111-8111-111111111111" });
    const afterUnlink = await unlinkWorkFlow(file, work.id, "job_never_linked");
    expect(afterUnlink.flowIds).toEqual([]);
    const afterThreadUnlink = await unlinkWorkThread(file, work.id);
    expect(afterThreadUnlink.threadId).toBeUndefined();
  });
});

describe("updateWork — rename / status only", () => {
  it("renames and changes status independently", async () => {
    const work = await createWork(file, { name: "Old name", goal: "goal" }, process.env, { idFactory: () => "work_11111111-1111-4111-8111-111111111111" });
    const renamed = await updateWork(file, work.id, { name: "New name" });
    expect(renamed.name).toBe("New name");
    expect(renamed.status).toBe("active");
    const paused = await updateWork(file, work.id, { status: "paused" });
    expect(paused.status).toBe("paused");
    expect(paused.name).toBe("New name");
  });

  it("rejects an empty rename and an invalid status", async () => {
    const work = await createWork(file, { name: "Name", goal: "goal" }, process.env, { idFactory: () => "work_11111111-1111-4111-8111-111111111111" });
    await expect(updateWork(file, work.id, { name: "  " })).rejects.toThrow(WorksStoreError);
    await expect(updateWork(file, work.id, { status: "cancelled" as never })).rejects.toThrow(WorksStoreError);
  });
});

describe("addWorkOutcome / markWorkDone", () => {
  it("appends an outcome with a server-assigned timestamp", async () => {
    const work = await createWork(file, { name: "Name", goal: "goal" }, process.env, { idFactory: () => "work_11111111-1111-4111-8111-111111111111" });
    const updated = await addWorkOutcome(
      file,
      work.id,
      { kind: "used", note: "helped" },
      process.env,
      () => new Date("2026-07-17T09:00:00.000Z")
    );
    expect(updated.outcomes).toEqual([{ atIso: "2026-07-17T09:00:00.000Z", kind: "used", note: "helped" }]);
  });

  it("rejects an invalid outcome kind", async () => {
    const work = await createWork(file, { name: "Name", goal: "goal" }, process.env, { idFactory: () => "work_11111111-1111-4111-8111-111111111111" });
    await expect(addWorkOutcome(file, work.id, { kind: "invalid" as never })).rejects.toThrow(WorksStoreError);
  });

  it("markWorkDone sets status done directly (an explicit user action, not a self-report)", async () => {
    const work = await createWork(file, { name: "Name", goal: "goal" }, process.env, { idFactory: () => "work_11111111-1111-4111-8111-111111111111" });
    const done = await markWorkDone(file, work.id);
    expect(done.status).toBe("done");
  });
});

describe("deleteWork — severs the Work reference only", () => {
  it("removes the Work entry and reports whether it existed", async () => {
    const work = await createWork(file, { name: "Name", goal: "goal" }, process.env, { idFactory: () => "work_11111111-1111-4111-8111-111111111111" });
    expect(await deleteWork(file, work.id)).toBe(true);
    expect(await getWork(file, work.id)).toBeUndefined();
    expect(await deleteWork(file, work.id)).toBe(false);
  });

  it("never touches the linked flow/task/thread ids — those live in their own stores untouched", async () => {
    const work = await createWork(file, { name: "Name", goal: "goal" }, process.env, { idFactory: () => "work_11111111-1111-4111-8111-111111111111" });
    await linkWorkFlow(file, work.id, "job_1", ALWAYS_EXISTS);
    // Deleting the Work only removes the Work record; this test documents
    // that deleteWork never reaches into any other store (there is none
    // wired here — a compile-time + behavioral guarantee that the function
    // signature takes no scheduler/board/attunement handle at all).
    await deleteWork(file, work.id);
    expect(await readWorks(file)).toEqual([]);
  });
});

describe("pruneDeletedFlowRefs — the lifecycle audit sweep (pure)", () => {
  const work = (id: string, flowIds: readonly string[]): PersistedWork => ({
    boardTaskIds: [],
    createdAtIso: "2026-01-01T00:00:00.000Z",
    flowIds,
    goal: "goal",
    id,
    name: "name",
    outcomes: [],
    status: "active",
    updatedAtIso: "2026-01-01T00:00:00.000Z"
  });

  it("drops a flowId no longer in the existing set, keeps the ones that remain", () => {
    const works = [work("w1", ["job_1", "job_2"])];
    const pruned = pruneDeletedFlowRefs(works, ["job_2"]);
    expect(pruned[0]?.flowIds).toEqual(["job_2"]);
  });

  it("returns the SAME array reference when nothing needs pruning (cheap no-op write skip)", () => {
    const works = [work("w1", ["job_2"])];
    const pruned = pruneDeletedFlowRefs(works, ["job_1", "job_2"]);
    expect(pruned).toBe(works);
  });

  it("leaves works with no flowIds at all untouched", () => {
    const works = [work("w1", [])];
    expect(pruneDeletedFlowRefs(works, [])).toBe(works);
  });
});

describe("syncWorksOnFlowDelete — applied delete-sync (the acceptance test: deleting a job prunes it from a Work)", () => {
  it("prunes a deleted job id out of every Work's flowIds", async () => {
    const w1 = await createWork(file, { name: "A", goal: "a" }, process.env, { idFactory: () => "work_11111111-1111-4111-8111-111111111111" });
    const w2 = await createWork(file, { name: "B", goal: "b" }, process.env, { idFactory: () => "work_22222222-2222-4222-8222-222222222222" });
    await linkWorkFlow(file, w1.id, "job_1", ALWAYS_EXISTS);
    await linkWorkFlow(file, w1.id, "job_2", ALWAYS_EXISTS);
    await linkWorkFlow(file, w2.id, "job_2", ALWAYS_EXISTS);

    // job_1 was deleted from the scheduler — job_2 is the only one still real.
    const prunedCount = await syncWorksOnFlowDelete(file, ["job_2"]);
    expect(prunedCount).toBe(1);

    expect((await getWork(file, "work_11111111-1111-4111-8111-111111111111"))?.flowIds).toEqual(["job_2"]);
    expect((await getWork(file, "work_22222222-2222-4222-8222-222222222222"))?.flowIds).toEqual(["job_2"]);
  });

  it("is fail-open: a missing/unwritable works file never throws", async () => {
    const missing = join(dir, "does-not-exist-dir", "works.json");
    await expect(syncWorksOnFlowDelete(missing, [])).resolves.toBe(0);
  });
});

describe("serializeWork", () => {
  it("omits threadId when unset and includes it when set", async () => {
    const work = await createWork(file, { name: "Name", goal: "goal" }, process.env, { idFactory: () => "work_11111111-1111-4111-8111-111111111111" });
    expect(serializeWork(work)).not.toHaveProperty("threadId");
    const withThread = await setWorkThread(file, work.id, "thread_1", ALWAYS_EXISTS);
    expect(serializeWork(withThread).threadId).toBe("thread_1");
  });
});

describe("encryption-at-rest — format-preserving, same envelope as contacts/playbook", () => {
  it("round-trips through encryptWorksAtRest / a later plain write stays encrypted", async () => {
    await createWork(file, { name: "Name", goal: "goal" }, process.env, { idFactory: () => "work_11111111-1111-4111-8111-111111111111" });
    expect(await isWorksEncrypted(file)).toBe(false);
    await encryptWorksAtRest(file);
    expect(await isWorksEncrypted(file)).toBe(true);
    // A subsequent normal mutation preserves the on-disk encrypted format.
    await updateWork(file, "work_11111111-1111-4111-8111-111111111111", { name: "Renamed" });
    expect(await isWorksEncrypted(file)).toBe(true);
    expect((await getWork(file, "work_11111111-1111-4111-8111-111111111111"))?.name).toBe("Renamed");
  });
});

describe("strict read — corrupt state fails closed", () => {
  it("a malformed JSON file throws and remains byte-stable", async () => {
    await writeWorks(file, []);
    const fs = await import("node:fs/promises");
    await fs.writeFile(file, "{not json", "utf8");
    const before = await readFile(file, "utf8");
    await expect(readWorks(file)).rejects.toThrow(WorkExactReadError);
    expect(await readFile(file, "utf8")).toBe(before);
  });
});
