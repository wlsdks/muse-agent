import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  OBSERVE_CONSENT_VERSION,
  emptyObserveState,
  forgetObserveSession,
  pauseObserveSession,
  readObserveState,
  recordObserveSample,
  resumeObserveSession,
  startObserveSession
} from "./observe-store.js";

const directories: string[] = [];
const SESSION_ID = "observe_00000000-0000-4000-8000-000000000001";
const OBSERVATION_ID = "observe_observation_00000000-0000-4000-8000-000000000002";

async function storeFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "muse-observe-"));
  directories.push(directory);
  return join(directory, "attunement.json.observe.json");
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("Observe O1 strict collection store", () => {
  it("treats a missing file as the literal empty v1 state", async () => {
    expect(await readObserveState(await storeFile())).toEqual(emptyObserveState());
  });

  it("starts, pauses, resumes, and forgets one consented session", async () => {
    const file = await storeFile();
    const session = await startObserveSession(file, {
      acceptVersion: OBSERVE_CONSENT_VERSION,
      threadId: "thread-a"
    }, { idFactory: () => SESSION_ID, now: () => new Date("2026-07-22T00:00:00.000Z") });
    expect(session).toMatchObject({ id: SESSION_ID, observedThroughAt: null, status: "active", threadId: "thread-a" });

    const paused = await pauseObserveSession(file, SESSION_ID, { now: () => new Date("2026-07-22T00:01:00.000Z") });
    expect(paused.status).toBe("paused");
    const bytes = await readFile(file, "utf8");
    expect(await pauseObserveSession(file, SESSION_ID)).toEqual(paused);
    expect(await readFile(file, "utf8")).toBe(bytes);

    const resumed = await resumeObserveSession(file, SESSION_ID, { now: () => new Date("2026-07-22T00:02:00.000Z") });
    expect(resumed).toMatchObject({ status: "active", updatedAt: "2026-07-22T00:02:00.000Z" });
    expect(await forgetObserveSession(file, SESSION_ID)).toEqual({ deletedObservations: 0 });
    expect((await readObserveState(file)).sessions).toEqual([]);
  });

  it("rejects duplicate keys and leaves malformed bytes untouched", async () => {
    const file = await storeFile();
    const malformed = '{"schemaVersion":1,"schemaVersion":1,"sessions":[],"observations":[],"activeSegments":[],"collectorLease":null,"nextFencingToken":1}';
    await writeFile(file, malformed);
    await expect(readObserveState(file)).rejects.toThrow("invalid JSON");
    expect(await readFile(file, "utf8")).toBe(malformed);
  });

  it("records deterministic category transitions without zero-duration evidence", async () => {
    const file = await storeFile();
    await startObserveSession(file, { acceptVersion: 1, threadId: "thread-a" }, {
      idFactory: () => SESSION_ID,
      now: () => new Date("2026-07-22T00:00:00.000Z")
    });
    const ids = [OBSERVATION_ID];
    await recordObserveSample(file, SESSION_ID, "writing", "2026-07-22T00:01:00.000Z", { idFactory: () => ids.shift()! });
    await recordObserveSample(file, SESSION_ID, "research", "2026-07-22T00:01:00.000Z");
    const state = await readObserveState(file);
    expect(state.observations).toEqual([]);
    expect(state.activeSegments).toEqual([expect.objectContaining({ appCategory: "research", startedAt: "2026-07-22T00:01:00.000Z" })]);
    expect(state.sessions[0]?.observedThroughAt).toBe("2026-07-22T00:01:00.000Z");

    const replayBytes = await readFile(file, "utf8");
    await recordObserveSample(file, SESSION_ID, "research", "2026-07-22T00:01:00.000Z");
    expect(await readFile(file, "utf8")).toBe(replayBytes);
  });

  it("closes gaps at lastSeen and caps observations before category handling", async () => {
    const file = await storeFile();
    const generated = [SESSION_ID, OBSERVATION_ID];
    await startObserveSession(file, { acceptVersion: 1, threadId: "thread-a" }, {
      idFactory: () => generated.shift()!,
      now: () => new Date("2026-07-20T00:00:00.000Z")
    });
    await recordObserveSample(file, SESSION_ID, "building", "2026-07-20T00:00:01.000Z");
    await recordObserveSample(file, SESSION_ID, "building", "2026-07-21T00:00:01.000Z", { idFactory: () => OBSERVATION_ID });
    const state = await readObserveState(file);
    expect(state.observations).toEqual([]);
    expect(state.activeSegments[0]).toMatchObject({ appCategory: "building", startedAt: "2026-07-21T00:00:01.000Z" });

    await expect(recordObserveSample(file, SESSION_ID, "building", "2026-07-20T23:00:00.000Z")).rejects.toMatchObject({ code: "conflict" });
  });
});
