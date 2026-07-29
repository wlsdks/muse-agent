import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  OBSERVE_CONSENT_TEMPLATE,
  OBSERVE_CONSENT_VERSION,
  claimObserveLease,
  emptyObserveState,
  forgetObserveSession,
  pauseObserveSession,
  readObserveState,
  reduceObserveSample,
  resumeObserveSession,
  releaseObserveLease,
  startObserveSession,
  writeObserveStateUnlocked
} from "./observe-store.js";

const directories: string[] = [];
const SESSION_ID = "observe_00000000-0000-4000-8000-000000000001";
const OBSERVATION_ID = "observe_observation_00000000-0000-4000-8000-000000000002";
const RESUME_INPUT = {
  acceptVersion: OBSERVE_CONSENT_VERSION,
  consent: { ...OBSERVE_CONSENT_TEMPLATE, retentionDays: 45 },
  previousGeneration: 1
} as const;

async function applySample(file: string, sessionId: string, category: Parameters<typeof reduceObserveSample>[2], observedAt: string, options: Parameters<typeof reduceObserveSample>[4] = {}): Promise<void> {
  const mutation = reduceObserveSample(await readObserveState(file), sessionId, category, observedAt, options);
  if (mutation.changed) await writeFile(file, `${JSON.stringify(mutation.state, null, 2)}\n`);
}

async function storeFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "muse-observe-"));
  directories.push(directory);
  return join(directory, "attunement.json.observe.json");
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("Observe O1 strict collection store", () => {
  it("treats a missing file as the literal empty current state", async () => {
    expect(await readObserveState(await storeFile())).toEqual(emptyObserveState());
  });

  it("starts, pauses, resumes, and forgets one consented session", async () => {
    const file = await storeFile();
    const session = await startObserveSession(file, {
      acceptVersion: OBSERVE_CONSENT_VERSION,
      consent: OBSERVE_CONSENT_TEMPLATE,
      threadId: "thread-a"
    }, { idFactory: () => SESSION_ID, now: () => new Date("2026-07-22T00:00:00.000Z") });
    expect(session).toMatchObject({
      consentGrant: OBSERVE_CONSENT_TEMPLATE,
      consentGeneration: 1,
      consentVersion: OBSERVE_CONSENT_VERSION,
      id: SESSION_ID,
      observedThroughAt: null,
      status: "active",
      threadId: "thread-a"
    });

    const paused = await pauseObserveSession(file, SESSION_ID, { now: () => new Date("2026-07-22T00:01:00.000Z") });
    expect(paused.status).toBe("paused");
    const bytes = await readFile(file, "utf8");
    expect(await pauseObserveSession(file, SESSION_ID)).toEqual(paused);
    expect(await readFile(file, "utf8")).toBe(bytes);

    await expect(resumeObserveSession(file, SESSION_ID, {
      ...RESUME_INPUT,
      previousGeneration: 0
    })).rejects.toThrow("generation is stale");
    expect(await readFile(file, "utf8")).toBe(bytes);
    const resumed = await resumeObserveSession(file, SESSION_ID, RESUME_INPUT, {
      now: () => new Date("2026-07-22T00:02:00.000Z")
    });
    expect(resumed).toMatchObject({
      consentGeneration: 2,
      consentGrant: { retentionDays: 45 },
      status: "active",
      updatedAt: "2026-07-22T00:02:00.000Z"
    });
    expect(await forgetObserveSession(file, SESSION_ID)).toEqual({ deletedObservations: 0 });
    expect((await readObserveState(file)).sessions).toEqual([]);
  });

  it.each(["source", "fields", "cadenceMs", "retentionDays", "pauseControl"] as const)(
    "refuses enrollment when explicit consent is missing %s and leaves the store unchanged",
    async (missing) => {
      const file = await storeFile();
      const consent = { ...OBSERVE_CONSENT_TEMPLATE } as Record<string, unknown>;
      delete consent[missing];
      await expect(startObserveSession(file, {
        acceptVersion: OBSERVE_CONSENT_VERSION,
        consent: consent as never,
        threadId: "thread-a"
      })).rejects.toMatchObject({ code: "invalid" });
      expect(await readObserveState(file)).toEqual(emptyObserveState());
    }
  );

  it("preserves legacy active state but blocks collection/resume without inventing consent", async () => {
    const file = await storeFile();
    await writeFile(file, `${JSON.stringify({
      activeSegments: [{
        appCategory: "writing",
        lastSeenAt: "2026-07-22T00:00:20.000Z",
        sessionId: SESSION_ID,
        startedAt: "2026-07-22T00:00:10.000Z",
        threadId: "thread-a"
      }],
      collectorLease: {
        claimedAt: "2026-07-22T00:00:15.000Z",
        collectorFingerprint: "a".repeat(64),
        expiresAt: "2026-07-22T00:01:00.000Z",
        fencingToken: 1,
        sessionId: SESSION_ID
      },
      nextFencingToken: 2,
      observations: [],
      schemaVersion: 1,
      sessions: [{
        consentVersion: 1,
        createdAt: "2026-07-22T00:00:00.000Z",
        id: SESSION_ID,
        observedThroughAt: "2026-07-22T00:00:20.000Z",
        status: "active",
        threadId: "thread-a",
        updatedAt: "2026-07-22T00:00:00.000Z"
      }]
    })}\n`);
    const migrated = await readObserveState(file);
    expect(migrated).toMatchObject({
      activeSegments: [],
      collectorLease: null,
      observations: [{ durationMs: 10_000, sessionId: SESSION_ID }],
      schemaVersion: 3,
      sessions: [{ consentGeneration: 0, consentGrant: null, consentVersion: 1, status: "paused" }]
    });
    await writeObserveStateUnlocked(file, migrated);
    expect(await readObserveState(file)).toEqual(migrated);
    await expect(resumeObserveSession(file, SESSION_ID, RESUME_INPUT)).rejects.toThrow("new explicit consent enrollment");
  });

  it("migrates a schema-v2 consented session to generation 1 with a valid round trip", async () => {
    const file = await storeFile();
    await writeFile(file, `${JSON.stringify({
      activeSegments: [],
      collectorLease: null,
      nextFencingToken: 1,
      observations: [],
      schemaVersion: 2,
      sessions: [{
        consentGrant: OBSERVE_CONSENT_TEMPLATE,
        consentVersion: 2,
        createdAt: "2026-07-22T00:00:00.000Z",
        id: SESSION_ID,
        observedThroughAt: null,
        status: "paused",
        threadId: "thread-a",
        updatedAt: "2026-07-22T00:01:00.000Z"
      }]
    })}\n`);
    const migrated = await readObserveState(file);
    expect(migrated).toMatchObject({
      schemaVersion: 3,
      sessions: [{ consentGeneration: 1, consentGrant: OBSERVE_CONSENT_TEMPLATE, status: "paused" }]
    });
    await writeObserveStateUnlocked(file, migrated);
    expect(await readObserveState(file)).toEqual(migrated);
  });

  it("rejects duplicate keys and leaves malformed bytes untouched", async () => {
    const file = await storeFile();
    const malformed = '{"schemaVersion":1,"schemaVersion":1,"sessions":[],"observations":[],"activeSegments":[],"collectorLease":null,"nextFencingToken":1}';
    await writeFile(file, malformed);
    await expect(readObserveState(file)).rejects.toThrow("invalid JSON");
    expect(await readFile(file, "utf8")).toBe(malformed);
  });

  it("accepts a valid leaf alias and rejects dangling, invalid UTF-8, and oversized stores", async () => {
    const file = await storeFile();
    await startObserveSession(file, { acceptVersion: OBSERVE_CONSENT_VERSION, consent: OBSERVE_CONSENT_TEMPLATE, threadId: "thread-a" }, { idFactory: () => SESSION_ID, now: () => new Date("2026-07-22T00:00:00.000Z") });
    const alias = `${file}.alias`;
    await symlink(file, alias);
    expect(await readObserveState(alias)).toEqual(await readObserveState(file));
    const dangling = `${file}.dangling`;
    await symlink(`${file}.missing`, dangling);
    await expect(readObserveState(dangling)).rejects.toThrow("dangling symlink");
    await writeFile(file, new Uint8Array([0xff]));
    await expect(readObserveState(file)).rejects.toThrow("valid UTF-8");
    await writeFile(file, Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));
    await expect(readObserveState(file)).rejects.toThrow("content size limit");
  });

  it("records deterministic category transitions without zero-duration evidence", async () => {
    const file = await storeFile();
    await startObserveSession(file, { acceptVersion: OBSERVE_CONSENT_VERSION, consent: OBSERVE_CONSENT_TEMPLATE, threadId: "thread-a" }, {
      idFactory: () => SESSION_ID,
      now: () => new Date("2026-07-22T00:00:00.000Z")
    });
    const ids = [OBSERVATION_ID];
    await applySample(file, SESSION_ID, "writing", "2026-07-22T00:01:00.000Z", { idFactory: () => ids.shift()! });
    await applySample(file, SESSION_ID, "research", "2026-07-22T00:01:00.000Z");
    const state = await readObserveState(file);
    expect(state.observations).toEqual([]);
    expect(state.activeSegments).toEqual([expect.objectContaining({ appCategory: "research", startedAt: "2026-07-22T00:01:00.000Z" })]);
    expect(state.sessions[0]?.observedThroughAt).toBe("2026-07-22T00:01:00.000Z");

    const replayBytes = await readFile(file, "utf8");
    await applySample(file, SESSION_ID, "research", "2026-07-22T00:01:00.000Z");
    expect(await readFile(file, "utf8")).toBe(replayBytes);
  });

  it("closes gaps at lastSeen and caps observations before category handling", async () => {
    const file = await storeFile();
    const generated = [SESSION_ID, OBSERVATION_ID];
    await startObserveSession(file, { acceptVersion: OBSERVE_CONSENT_VERSION, consent: OBSERVE_CONSENT_TEMPLATE, threadId: "thread-a" }, {
      idFactory: () => generated.shift()!,
      now: () => new Date("2026-07-20T00:00:00.000Z")
    });
    await applySample(file, SESSION_ID, "building", "2026-07-20T00:00:01.000Z");
    await applySample(file, SESSION_ID, "building", "2026-07-21T00:00:01.000Z", { idFactory: () => OBSERVATION_ID });
    const state = await readObserveState(file);
    expect(state.observations).toEqual([]);
    expect(state.activeSegments[0]).toMatchObject({ appCategory: "building", startedAt: "2026-07-21T00:00:01.000Z" });

    await expect(applySample(file, SESSION_ID, "building", "2026-07-20T23:00:00.000Z")).rejects.toMatchObject({ code: "conflict" });
  });

  it("closes a real gap only through the last accepted sample", async () => {
    const file = await storeFile();
    await startObserveSession(file, { acceptVersion: OBSERVE_CONSENT_VERSION, consent: OBSERVE_CONSENT_TEMPLATE, threadId: "thread-a" }, { idFactory: () => SESSION_ID, now: () => new Date("2026-07-22T00:00:00.000Z") });
    await applySample(file, SESSION_ID, "writing", "2026-07-22T00:00:00.000Z");
    await applySample(file, SESSION_ID, "writing", "2026-07-22T00:01:00.000Z");
    await applySample(file, SESSION_ID, "research", "2026-07-22T00:07:00.001Z", { idFactory: () => OBSERVATION_ID });
    const state = await readObserveState(file);
    expect(state.observations[0]).toMatchObject({ durationMs: 60_000, endedAt: "2026-07-22T00:01:00.000Z" });
    expect(state.activeSegments[0]).toMatchObject({ appCategory: "research", startedAt: "2026-07-22T00:07:00.001Z" });
  });

  it("caps a continuously sampled segment at exactly 24 hours", async () => {
    const file = await storeFile();
    const origin = Date.parse("2026-07-20T00:00:00.000Z");
    await startObserveSession(file, { acceptVersion: OBSERVE_CONSENT_VERSION, consent: OBSERVE_CONSENT_TEMPLATE, threadId: "thread-a" }, { idFactory: () => SESSION_ID, now: () => new Date(origin) });
    let state = (reduceObserveSample(await readObserveState(file), SESSION_ID, "building", new Date(origin).toISOString())).state;
    for (let step = 1; step <= 288; step += 1) {
      state = reduceObserveSample(state, SESSION_ID, "building", new Date(origin + step * 5 * 60_000).toISOString(), step === 288 ? { idFactory: () => OBSERVATION_ID } : {}).state;
    }
    expect(state.observations).toEqual([expect.objectContaining({ durationMs: 24 * 60 * 60_000, endedAt: "2026-07-21T00:00:00.000Z" })]);
    expect(state.activeSegments[0]?.startedAt).toBe("2026-07-21T00:00:00.000Z");
  });

  it("produces the same equal-time winner for both arrival orders across pass^10", async () => {
    for (let pass = 0; pass < 10; pass += 1) {
      const left = await storeFile();
      const right = await storeFile();
      for (const file of [left, right]) await startObserveSession(file, { acceptVersion: OBSERVE_CONSENT_VERSION, consent: OBSERVE_CONSENT_TEMPLATE, threadId: "thread-a" }, { idFactory: () => SESSION_ID, now: () => new Date("2026-07-22T00:00:00.000Z") });
      await applySample(left, SESSION_ID, "writing", "2026-07-22T00:00:00.000Z");
      await applySample(right, SESSION_ID, "writing", "2026-07-22T00:00:00.000Z");
      await applySample(left, SESSION_ID, "writing", "2026-07-22T00:01:00.000Z");
      await applySample(left, SESSION_ID, "research", "2026-07-22T00:01:00.000Z", { idFactory: () => OBSERVATION_ID });
      await applySample(right, SESSION_ID, "research", "2026-07-22T00:01:00.000Z", { idFactory: () => OBSERVATION_ID });
      await applySample(right, SESSION_ID, "writing", "2026-07-22T00:01:00.000Z");
      expect(await readObserveState(left)).toEqual(await readObserveState(right));
      expect((await readObserveState(left)).observations[0]).toMatchObject({ appCategory: "writing", durationMs: 60_000 });
    }
  });

  it("fences an expired collector takeover and rejects the old owner", async () => {
    const file = await storeFile();
    await startObserveSession(file, { acceptVersion: OBSERVE_CONSENT_VERSION, consent: OBSERVE_CONSENT_TEMPLATE, threadId: "thread-a" }, { idFactory: () => SESSION_ID, now: () => new Date("2026-07-22T00:00:00.000Z") });
    const first = await claimObserveLease(file, SESSION_ID, "a".repeat(64), 10_000, "2026-07-22T00:00:01.000Z");
    const second = await claimObserveLease(file, SESSION_ID, "b".repeat(64), 10_000, "2026-07-22T00:00:31.000Z");
    expect(second.fencingToken).toBe(first.fencingToken + 1);
    await expect(releaseObserveLease(file, SESSION_ID, first)).rejects.toMatchObject({ code: "conflict" });
    await expect(releaseObserveLease(file, SESSION_ID, second)).resolves.toBeUndefined();
  });

  it("keeps the resume watermark and rejects wall-clock rollback", async () => {
    const file = await storeFile();
    await startObserveSession(file, { acceptVersion: OBSERVE_CONSENT_VERSION, consent: OBSERVE_CONSENT_TEMPLATE, threadId: "thread-a" }, { idFactory: () => SESSION_ID, now: () => new Date("2026-07-22T00:00:00.000Z") });
    await pauseObserveSession(file, SESSION_ID, { now: () => new Date("2026-07-22T00:01:00.000Z") });
    await resumeObserveSession(file, SESSION_ID, RESUME_INPUT, {
      now: () => new Date("2026-07-22T00:02:00.000Z")
    });
    const state = await readObserveState(file);
    expect(() => reduceObserveSample(state, SESSION_ID, "writing", "2026-07-22T00:01:59.999Z")).toThrow("stale");
  });

  it("retains the newest deterministic tail at the 500/501 observation boundary", async () => {
    const file = await storeFile();
    const origin = Date.parse("2026-07-22T00:00:00.000Z");
    await startObserveSession(file, { acceptVersion: OBSERVE_CONSENT_VERSION, consent: OBSERVE_CONSENT_TEMPLATE, threadId: "thread-a" }, { idFactory: () => SESSION_ID, now: () => new Date(origin) });
    let state = reduceObserveSample(await readObserveState(file), SESSION_ID, "writing", new Date(origin).toISOString()).state;
    for (let index = 1; index <= 501; index += 1) {
      const suffix = index.toString(16).padStart(12, "0");
      state = reduceObserveSample(state, SESSION_ID, index % 2 === 0 ? "writing" : "research", new Date(origin + index * 60_000).toISOString(), {
        idFactory: () => `observe_observation_00000000-0000-4000-8000-${suffix}`
      }).state;
    }
    expect(state.observations).toHaveLength(500);
    expect(state.observations[0]?.startedAt).toBe("2026-07-22T00:01:00.000Z");
    expect(state.observations.at(-1)?.endedAt).toBe("2026-07-22T08:21:00.000Z");
  });

  it("rejects a hostile active segment that reaches the 24-hour bound", async () => {
    const file = await storeFile();
    const origin = "2026-07-20T00:00:00.000Z";
    await startObserveSession(file, { acceptVersion: OBSERVE_CONSENT_VERSION, consent: OBSERVE_CONSENT_TEMPLATE, threadId: "thread-a" }, { idFactory: () => SESSION_ID, now: () => new Date(origin) });
    const state = reduceObserveSample(await readObserveState(file), SESSION_ID, "writing", origin).state;
    const capped = "2026-07-21T00:00:00.000Z";
    const hostile = {
      ...state,
      activeSegments: [{ ...state.activeSegments[0]!, lastSeenAt: capped }],
      sessions: [{ ...state.sessions[0]!, observedThroughAt: capped }]
    };
    await writeFile(file, JSON.stringify(hostile));
    await expect(readObserveState(file)).rejects.toThrow("invalid active segment");
  });

  it("keeps exact reducer bytes deterministic across no-prior, zero-age, positive, gap, and cap cases at pass^10", async () => {
    const file = await storeFile();
    const origin = Date.parse("2026-07-20T00:00:00.000Z");
    await startObserveSession(file, { acceptVersion: OBSERVE_CONSENT_VERSION, consent: OBSERVE_CONSENT_TEMPLATE, threadId: "thread-a" }, { idFactory: () => SESSION_ID, now: () => new Date(origin) });
    const empty = await readObserveState(file);
    const zero = reduceObserveSample(empty, SESSION_ID, "writing", new Date(origin).toISOString()).state;
    const positive = reduceObserveSample(zero, SESSION_ID, "writing", new Date(origin + 60_000).toISOString()).state;
    const nearCap = {
      ...zero,
      activeSegments: [{ ...zero.activeSegments[0]!, lastSeenAt: new Date(origin + 24 * 60 * 60_000 - 60_000).toISOString() }],
      sessions: [{ ...zero.sessions[0]!, observedThroughAt: new Date(origin + 24 * 60 * 60_000 - 60_000).toISOString() }]
    };
    const cases = [
      { category: "writing" as const, state: empty, time: origin },
      { category: "research" as const, state: zero, time: origin },
      { category: "writing" as const, state: positive, time: origin + 60_000 },
      { category: "research" as const, state: positive, time: origin + 60_000 },
      { category: "writing" as const, state: positive, time: origin + 7 * 60_000 },
      { category: "research" as const, state: positive, time: origin + 7 * 60_000 },
      { category: "writing" as const, state: nearCap, time: origin + 24 * 60 * 60_000 },
      { category: "research" as const, state: nearCap, time: origin + 24 * 60 * 60_000 }
    ];
    for (const [index, scenario] of cases.entries()) {
      let expected: string | undefined;
      for (let pass = 0; pass < 10; pass += 1) {
        const suffix = (index + 1).toString(16).padStart(12, "0");
        const mutation = reduceObserveSample(scenario.state, SESSION_ID, scenario.category, new Date(scenario.time).toISOString(), {
          idFactory: () => `observe_observation_00000000-0000-4000-8000-${suffix}`
        });
        const bytes = JSON.stringify({ activeSegments: mutation.state.activeSegments, observations: mutation.state.observations, sessions: mutation.state.sessions });
        expected ??= bytes;
        expect(bytes).toBe(expected);
      }
    }
  });
});
