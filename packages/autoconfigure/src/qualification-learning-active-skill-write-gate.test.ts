import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { FileUserMemoryStore } from "@muse/memory";
import {
  createPersonalThread,
  evaluateTimingSession,
  openContinuityDelivery,
  recordContinuityOutcome,
  recordTimingFeedback,
  recordTimingObservation,
  resetThreadPolicy,
  startTimingSession,
  undoThreadReset,
  type ActiveAttunementPolicyWriteGate
} from "@muse/attunement";
import {
  activateQualificationLearningHold,
  adjustPlaybookReward,
  bumpPlaybookObservation,
  decayStalePlaybookRewards,
  enqueueLearnEvent,
  readPendingLearnEvents,
  recordPlaybookStrategy,
  removePlaybookStrategy,
  writePlaybook,
  type ActivePlaybookWriteGate,
  type PlaybookEntry
} from "@muse/stores";
import { describe, expect, it } from "vitest";

import {
  createQualificationLearningActiveSkillWriteGate,
  createQualificationLearningWriteGate
} from "./qualification-learning-active-skill-write-gate.js";

const allowActivePlaybookWrites: ActivePlaybookWriteGate = {
  run: (operation) => operation()
};
const seedEntry: PlaybookEntry = {
  createdAt: "2026-01-01T00:00:00.000Z",
  id: "seed",
  probation: false,
  reward: 2,
  text: "keep replies concise",
  userId: "owner"
};
const allowActiveAttunementPolicyWrites: ActiveAttunementPolicyWriteGate = {
  run: (operation) => operation()
};

async function activeAttunementPolicyMutationFixtures(root: string): Promise<readonly {
  readonly file: string;
  readonly mutate: (gate: ActiveAttunementPolicyWriteGate) => Promise<unknown>;
}[]> {
  const outcomeFile = join(root, "outcome.json");
  const outcomeThread = await createPersonalThread(
    outcomeFile,
    { kind: "life", title: "Outcome fixture" },
    { idFactory: () => "thread_outcome" }
  );
  const outcomeDelivery = await openContinuityDelivery(outcomeFile, {
    evidenceRefs: [],
    expectedPolicyVersion: 0,
    threadId: outcomeThread.id
  }, { idFactory: () => "delivery_outcome" });

  const resetFile = join(root, "reset.json");
  const resetThread = await createPersonalThread(
    resetFile,
    { kind: "work", title: "Reset fixture" },
    { idFactory: () => "thread_reset" }
  );
  const resetDelivery = await openContinuityDelivery(resetFile, {
    evidenceRefs: [],
    expectedPolicyVersion: 0,
    threadId: resetThread.id
  }, { idFactory: () => "delivery_reset" });
  await recordContinuityOutcome(
    resetFile,
    resetDelivery.id,
    "ignored",
    allowActiveAttunementPolicyWrites
  );

  const undoFile = join(root, "undo.json");
  const undoThread = await createPersonalThread(
    undoFile,
    { kind: "work", title: "Undo fixture" },
    { idFactory: () => "thread_undo" }
  );
  const undoDelivery = await openContinuityDelivery(undoFile, {
    evidenceRefs: [],
    expectedPolicyVersion: 0,
    threadId: undoThread.id
  }, { idFactory: () => "delivery_undo" });
  await recordContinuityOutcome(
    undoFile,
    undoDelivery.id,
    "ignored",
    allowActiveAttunementPolicyWrites
  );
  const reset = await resetThreadPolicy(
    undoFile,
    undoThread.id,
    allowActiveAttunementPolicyWrites,
    { idFactory: () => "reset_undo" }
  );

  const timingFile = join(root, "timing.json");
  const timingSession = await startTimingSession(
    timingFile,
    { consentVersion: 1, threadId: "thread_timing" },
    async () => undefined,
    { idFactory: () => "timing_session", now: () => new Date("2026-07-26T00:00:00.000Z") }
  );
  await recordTimingObservation(timingFile, timingSession.id, {
    appCategory: "writing",
    durationMs: 30 * 60_000,
    endedAt: "2026-07-26T00:30:00.000Z",
    startedAt: "2026-07-26T00:00:00.000Z"
  }, { idFactory: () => "observation_1" });
  await recordTimingObservation(timingFile, timingSession.id, {
    appCategory: "research",
    durationMs: 30 * 60_000,
    endedAt: "2026-07-26T01:00:00.000Z",
    startedAt: "2026-07-26T00:30:00.000Z"
  }, { idFactory: () => "observation_2" });
  const candidate = await evaluateTimingSession(
    timingFile,
    timingSession.id,
    { idFactory: () => "candidate_1", now: () => new Date("2026-07-26T01:00:00.000Z") }
  );

  return [
    {
      file: outcomeFile,
      mutate: (gate) => recordContinuityOutcome(outcomeFile, outcomeDelivery.id, "used", gate)
    },
    {
      file: resetFile,
      mutate: (gate) => resetThreadPolicy(resetFile, resetThread.id, gate)
    },
    {
      file: undoFile,
      mutate: (gate) => undoThreadReset(undoFile, undoThread.id, reset.receipt!.id, gate)
    },
    {
      file: timingFile,
      mutate: (gate) => recordTimingFeedback(timingFile, candidate.id, "used", gate)
    }
  ];
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "muse-active-skill-gate-"));
  const file = join(root, "qualification-learning-hold.json");
  const env = {
    HOME: root,
    MUSE_QUALIFICATION_LEARNING_HOLD_FILE: file
  };
  return {
    env,
    file,
    gate: createQualificationLearningActiveSkillWriteGate(env)
  };
}

describe("qualification learning active-skill write gate", () => {
  it("allows a mutation only while the hold is absent", async () => {
    const { gate } = await fixture();
    let mutations = 0;
    await expect(gate.run(async () => {
      mutations += 1;
      return "applied";
    })).resolves.toBe("applied");
    expect(mutations).toBe(1);
  });

  it("fails closed for active and invalid hold state without invoking the mutation", async () => {
    const active = await fixture();
    await activateQualificationLearningHold(active.file, {
      activatedAt: "2026-07-26T06:00:00.000Z",
      holdId: "personal-agent-v1"
    });
    let activeMutations = 0;
    await expect(active.gate.run(async () => {
      activeMutations += 1;
    })).rejects.toMatchObject({
      code: "MUSE_ACTIVE_SKILL_WRITE_BLOCKED",
      reason: "qualification-hold-active"
    });
    expect(activeMutations).toBe(0);

    const invalid = await fixture();
    await writeFile(invalid.file, "{malformed", { mode: 0o600 });
    let invalidMutations = 0;
    await expect(invalid.gate.run(async () => {
      invalidMutations += 1;
    })).rejects.toMatchObject({
      code: "MUSE_ACTIVE_SKILL_WRITE_BLOCKED",
      reason: "qualification-hold-invalid"
    });
    expect(invalidMutations).toBe(0);
  });

  it("shares the activation lock so no active write can land after the hold engages", async () => {
    const { file, gate } = await fixture();
    let enteredResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    let releaseResolve: (() => void) | undefined;
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    const order: string[] = [];
    const mutation = gate.run(async () => {
      order.push("mutation-entered");
      enteredResolve?.();
      await release;
      order.push("mutation-completed");
    });
    await entered;
    const activation = activateQualificationLearningHold(file, {
      activatedAt: "2026-07-26T06:00:00.000Z",
      holdId: "personal-agent-v1"
    }).then(() => {
      order.push("hold-activated");
    });
    await Promise.resolve();
    expect(order).toEqual(["mutation-entered"]);
    releaseResolve?.();
    await Promise.all([mutation, activation]);
    expect(order).toEqual([
      "mutation-entered",
      "mutation-completed",
      "hold-activated"
    ]);

    await expect(gate.run(async () => {
      order.push("forbidden");
    })).rejects.toMatchObject({ reason: "qualification-hold-active" });
    expect(order).not.toContain("forbidden");
  });

  it("does not let a sibling process steal an aged live mutation lock before activation", async () => {
    const { file, gate } = await fixture();
    const activeFile = join(file, "..", "active-skill.md");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const order: string[] = [];
    let child: ReturnType<typeof spawn> | undefined;

    const mutation = gate.run(async () => {
      entered.resolve();
      await release.promise;
      await writeFile(activeFile, "mutation-completed", { mode: 0o600 });
      order.push("mutation-completed");
    });

    try {
      await entered.promise;
      const stale = new Date(Date.now() - 31_000);
      await utimes(`${file}.lock`, stale, stale);

      const storeModule = pathToFileURL(
        join(import.meta.dirname, "../../stores/src/qualification-learning-hold-store.ts")
      ).href;
      const childCode = `
        import { activateQualificationLearningHold } from ${JSON.stringify(storeModule)};
        await activateQualificationLearningHold(process.env.MUSE_PROBE_HOLD_FILE, {
          activatedAt: "2026-07-26T06:00:00.000Z",
          holdId: "personal-agent-v1"
        });
      `;
      child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", childCode],
        {
          env: {
            ...process.env,
            MUSE_PROBE_HOLD_FILE: file
          },
          stdio: ["ignore", "ignore", "pipe"]
        }
      );
      let childStderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        childStderr += chunk.toString("utf8");
      });
      const childExit = once(child, "exit").then(([code, signal]) => {
        order.push("hold-activated");
        return { code, signal };
      });
      const earlyExit = await Promise.race([
        childExit.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 150))
      ]);
      expect(earlyExit).toBe(false);

      release.resolve();
      await mutation;
      const exit = await childExit;
      expect(exit, childStderr).toEqual({ code: 0, signal: null });
      expect(order).toEqual(["mutation-completed", "hold-activated"]);
      expect(await readFile(activeFile, "utf8")).toBe("mutation-completed");
      await expect(gate.run(async () => {
        await writeFile(activeFile, "forbidden");
      })).rejects.toMatchObject({ reason: "qualification-hold-active" });
      expect(await readFile(activeFile, "utf8")).toBe("mutation-completed");
    } finally {
      release.resolve();
      await mutation.catch(() => undefined);
      if (child && child.exitCode === null) child.kill();
    }
  }, 10_000);

  it.each([
    "active",
    "invalid",
    "unavailable"
  ] as const)("keeps exact playbook bytes unchanged for every mutation family when hold state is %s", async (state) => {
    const root = await mkdtemp(join(tmpdir(), `muse-playbook-gate-${state}-`));
    const playbookFile = join(root, "playbook.json");
    let holdFile = join(root, "qualification-learning-hold.json");
    await writePlaybook(playbookFile, [seedEntry], allowActivePlaybookWrites);
    const before = await readFile(playbookFile);

    if (state === "active") {
      await activateQualificationLearningHold(holdFile, {
        activatedAt: "2026-07-26T06:00:00.000Z",
        holdId: "personal-agent-v1"
      });
    } else if (state === "invalid") {
      await writeFile(holdFile, "{malformed", { mode: 0o600 });
    } else {
      const parentFile = join(root, "not-a-directory");
      await writeFile(parentFile, "block", { mode: 0o600 });
      holdFile = join(parentFile, "qualification-learning-hold.json");
    }

    const gate = createQualificationLearningWriteGate({
      HOME: root,
      MUSE_QUALIFICATION_LEARNING_HOLD_FILE: holdFile
    });
    const mutations = [
      () => writePlaybook(playbookFile, [{ ...seedEntry, text: "replaced" }], gate),
      () => recordPlaybookStrategy(playbookFile, { ...seedEntry, id: "new" }, gate),
      () => removePlaybookStrategy(playbookFile, seedEntry.id, gate),
      () => adjustPlaybookReward(playbookFile, seedEntry.id, 1, gate),
      () => bumpPlaybookObservation(playbookFile, seedEntry.id, gate),
      () => decayStalePlaybookRewards(playbookFile, { nowMs: Date.parse("2026-07-26T00:00:00.000Z") }, gate)
    ];
    for (const mutate of mutations) {
      await expect(mutate()).rejects.toMatchObject({
        code: "MUSE_QUALIFICATION_LEARNING_WRITE_BLOCKED",
        reason: `qualification-hold-${state}`
      });
      expect(await readFile(playbookFile)).toEqual(before);
    }
  });

  it("fails closed without a gate for every exported playbook mutation family", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-playbook-missing-gate-"));
    const playbookFile = join(root, "playbook.json");
    await writePlaybook(playbookFile, [seedEntry], allowActivePlaybookWrites);
    const before = await readFile(playbookFile);
    const noGate = undefined as never;
    const mutations = [
      () => writePlaybook(playbookFile, [{ ...seedEntry, text: "replaced" }], noGate),
      () => recordPlaybookStrategy(playbookFile, { ...seedEntry, id: "new" }, noGate),
      () => removePlaybookStrategy(playbookFile, seedEntry.id, noGate),
      () => adjustPlaybookReward(playbookFile, seedEntry.id, 1, noGate),
      () => bumpPlaybookObservation(playbookFile, seedEntry.id, noGate),
      () => decayStalePlaybookRewards(playbookFile, { nowMs: Date.parse("2026-07-26T00:00:00.000Z") }, noGate)
    ];
    for (const mutate of mutations) {
      await expect(mutate()).rejects.toMatchObject({
        code: "MUSE_ACTIVE_PLAYBOOK_WRITE_BLOCKED",
        reason: "qualification-hold-unavailable"
      });
      expect(await readFile(playbookFile)).toEqual(before);
    }
  });

  it.each([
    "active",
    "invalid",
    "unavailable"
  ] as const)("keeps exact Attunement policy bytes unchanged for every policy mutation family when hold state is %s", async (state) => {
    const root = await mkdtemp(join(tmpdir(), `muse-attunement-policy-gate-${state}-`));
    const fixtures = await activeAttunementPolicyMutationFixtures(root);
    const before = new Map(await Promise.all(fixtures.map(async ({ file }) => [file, await readFile(file)] as const)));
    let holdFile = join(root, "qualification-learning-hold.json");
    if (state === "active") {
      await activateQualificationLearningHold(holdFile, {
        activatedAt: "2026-07-26T06:00:00.000Z",
        holdId: "personal-agent-v1"
      });
    } else if (state === "invalid") {
      await writeFile(holdFile, "{malformed", { mode: 0o600 });
    } else {
      const parentFile = join(root, "not-a-directory");
      await writeFile(parentFile, "block", { mode: 0o600 });
      holdFile = join(parentFile, "qualification-learning-hold.json");
    }
    const gate = createQualificationLearningWriteGate({
      HOME: root,
      MUSE_QUALIFICATION_LEARNING_HOLD_FILE: holdFile
    });
    for (const fixture of fixtures) {
      await expect(fixture.mutate(gate)).rejects.toMatchObject({
        code: "MUSE_QUALIFICATION_LEARNING_WRITE_BLOCKED",
        reason: `qualification-hold-${state}`
      });
      expect(await readFile(fixture.file)).toEqual(before.get(fixture.file));
    }
  });

  it("fails closed without a gate for every Attunement policy mutation family", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-attunement-policy-missing-gate-"));
    const fixtures = await activeAttunementPolicyMutationFixtures(root);
    const before = new Map(await Promise.all(fixtures.map(async ({ file }) => [file, await readFile(file)] as const)));
    const noGate = undefined as never;
    for (const fixture of fixtures) {
      await expect(fixture.mutate(noGate)).rejects.toMatchObject({
        code: "MUSE_ACTIVE_ATTUNEMENT_POLICY_WRITE_BLOCKED",
        reason: "qualification-hold-unavailable"
      });
      expect(await readFile(fixture.file)).toEqual(before.get(fixture.file));
    }
  });

  it("keeps every Attunement policy mutation family working while the hold is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-attunement-policy-gate-inactive-"));
    const fixtures = await activeAttunementPolicyMutationFixtures(root);
    const before = new Map(await Promise.all(fixtures.map(async ({ file }) => [file, await readFile(file)] as const)));
    const gate = createQualificationLearningWriteGate({
      HOME: root,
      MUSE_QUALIFICATION_LEARNING_HOLD_FILE: join(root, "qualification-learning-hold.json")
    });

    for (const fixture of fixtures) {
      await expect(fixture.mutate(gate)).resolves.toBeDefined();
      expect(await readFile(fixture.file)).not.toEqual(before.get(fixture.file));
    }
  });

  it("preserves the exact operation error through an Attunement policy writer", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-attunement-policy-error-"));
    const [fixture] = await activeAttunementPolicyMutationFixtures(root);
    const original = new Error("policy store write failed");
    const gate: ActiveAttunementPolicyWriteGate = {
      run: async () => {
        throw original;
      }
    };

    await expect(fixture!.mutate(gate)).rejects.toBe(original);
  });

  it("preserves the exact operation error through both qualification gate adapters", async () => {
    const { env } = await fixture();
    const original = new Error("disk write failed");
    await expect(createQualificationLearningWriteGate(env).run(async () => {
      throw original;
    })).rejects.toBe(original);
    await expect(createQualificationLearningActiveSkillWriteGate(env).run(async () => {
      throw original;
    })).rejects.toBe(original);
  });

  it("keeps proposals and explicit user facts writable while active playbook state is held", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-playbook-hold-separation-"));
    const holdFile = join(root, "qualification-learning-hold.json");
    const queueFile = join(root, "learn-queue.jsonl");
    const memoryFile = join(root, "user-memory.json");
    await activateQualificationLearningHold(holdFile, {
      activatedAt: "2026-07-26T06:00:00.000Z",
      holdId: "personal-agent-v1"
    });

    await enqueueLearnEvent(queueFile, {
      correction: "use bullet points",
      enqueuedAtMs: 1,
      id: "proposal-1",
      priorAnswer: "prose",
      userId: "owner"
    });
    expect((await readPendingLearnEvents(queueFile)).map((event) => event.id)).toEqual(["proposal-1"]);

    const memory = new FileUserMemoryStore({ file: memoryFile });
    await memory.upsertFact("owner", "home_city", "Seoul");
    await expect(memory.findByUserId("owner")).resolves.toMatchObject({
      facts: { home_city: "Seoul" }
    });
  });

  it("keeps timing observations and candidate proposals writable without changing policy under hold", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-timing-proposal-hold-"));
    const holdFile = join(root, "qualification-learning-hold.json");
    const timingFile = join(root, "timing.json");
    const session = await startTimingSession(
      timingFile,
      { consentVersion: 1, threadId: "thread_timing" },
      async () => undefined,
      { idFactory: () => "timing_session", now: () => new Date("2026-07-26T00:00:00.000Z") }
    );
    await activateQualificationLearningHold(holdFile, {
      activatedAt: "2026-07-26T06:00:00.000Z",
      holdId: "personal-agent-v1"
    });
    await recordTimingObservation(timingFile, session.id, {
      appCategory: "writing",
      durationMs: 30 * 60_000,
      endedAt: "2026-07-26T00:30:00.000Z",
      startedAt: "2026-07-26T00:00:00.000Z"
    }, { idFactory: () => "observation_1" });
    await recordTimingObservation(timingFile, session.id, {
      appCategory: "research",
      durationMs: 30 * 60_000,
      endedAt: "2026-07-26T01:00:00.000Z",
      startedAt: "2026-07-26T00:30:00.000Z"
    }, { idFactory: () => "observation_2" });
    const candidate = await evaluateTimingSession(
      timingFile,
      session.id,
      { idFactory: () => "candidate_1", now: () => new Date("2026-07-26T01:00:00.000Z") }
    );
    expect(candidate.decision).toBe("offer");
    const state = JSON.parse(await readFile(timingFile, "utf8")) as {
      feedback: unknown[];
      observations: unknown[];
      sessions: { policy: { version: number } }[];
    };
    expect(state.observations).toHaveLength(2);
    expect(state.feedback).toEqual([]);
    expect(state.sessions[0]?.policy.version).toBe(0);
  });

  it("blocks a restarted child process from recording a playbook strategy under the persisted hold", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-playbook-restart-gate-"));
    const holdFile = join(root, "qualification-learning-hold.json");
    const playbookFile = join(root, "playbook.json");
    await writePlaybook(playbookFile, [seedEntry], allowActivePlaybookWrites);
    const before = await readFile(playbookFile);
    await activateQualificationLearningHold(holdFile, {
      activatedAt: "2026-07-26T06:00:00.000Z",
      holdId: "personal-agent-v1"
    });

    const gateModule = pathToFileURL(
      join(import.meta.dirname, "qualification-learning-active-skill-write-gate.ts")
    ).href;
    const playbookModule = pathToFileURL(
      join(import.meta.dirname, "../../stores/src/personal-playbook-store.ts")
    ).href;
    const childCode = `
      import { createQualificationLearningWriteGate } from ${JSON.stringify(gateModule)};
      import { recordPlaybookStrategy } from ${JSON.stringify(playbookModule)};
      const gate = createQualificationLearningWriteGate({
        HOME: process.env.MUSE_PROBE_HOME,
        MUSE_QUALIFICATION_LEARNING_HOLD_FILE: process.env.MUSE_PROBE_HOLD_FILE
      });
      try {
        await recordPlaybookStrategy(process.env.MUSE_PROBE_PLAYBOOK_FILE, {
          createdAt: "2026-07-26T06:01:00.000Z",
          id: "forbidden",
          text: "must not land",
          userId: "owner"
        }, gate);
        process.exitCode = 2;
      } catch (cause) {
        if (cause?.code !== "MUSE_QUALIFICATION_LEARNING_WRITE_BLOCKED"
          || cause?.reason !== "qualification-hold-active") {
          throw cause;
        }
      }
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", childCode],
      {
        env: {
          ...process.env,
          MUSE_PROBE_HOLD_FILE: holdFile,
          MUSE_PROBE_HOME: root,
          MUSE_PROBE_PLAYBOOK_FILE: playbookFile
        },
        stdio: ["ignore", "ignore", "pipe"]
      }
    );
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const [code, signal] = await once(child, "exit");
    expect({ code, signal }, stderr).toEqual({ code: 0, signal: null });
    expect(await readFile(playbookFile)).toEqual(before);
  }, 10_000);

  it("blocks a restarted child process from recording an Attunement outcome under the persisted hold", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-attunement-restart-gate-"));
    const holdFile = join(root, "qualification-learning-hold.json");
    const attunementFile = join(root, "attunement.json");
    const thread = await createPersonalThread(
      attunementFile,
      { kind: "life", title: "Restart fixture" },
      { idFactory: () => "thread_restart" }
    );
    const delivery = await openContinuityDelivery(attunementFile, {
      evidenceRefs: [],
      expectedPolicyVersion: 0,
      threadId: thread.id
    }, { idFactory: () => "delivery_restart" });
    const before = await readFile(attunementFile);
    await activateQualificationLearningHold(holdFile, {
      activatedAt: "2026-07-26T06:00:00.000Z",
      holdId: "personal-agent-v1"
    });

    const gateModule = pathToFileURL(
      join(import.meta.dirname, "qualification-learning-active-skill-write-gate.ts")
    ).href;
    const attunementModule = pathToFileURL(
      join(import.meta.dirname, "../../attunement/src/attunement-store.ts")
    ).href;
    const childCode = `
      import { createQualificationLearningWriteGate } from ${JSON.stringify(gateModule)};
      import { recordContinuityOutcome } from ${JSON.stringify(attunementModule)};
      const gate = createQualificationLearningWriteGate({
        HOME: process.env.MUSE_PROBE_HOME,
        MUSE_QUALIFICATION_LEARNING_HOLD_FILE: process.env.MUSE_PROBE_HOLD_FILE
      });
      try {
        await recordContinuityOutcome(
          process.env.MUSE_PROBE_ATTUNEMENT_FILE,
          ${JSON.stringify(delivery.id)},
          "used",
          gate
        );
        process.exitCode = 2;
      } catch (cause) {
        if (cause?.code !== "MUSE_QUALIFICATION_LEARNING_WRITE_BLOCKED"
          || cause?.reason !== "qualification-hold-active") {
          throw cause;
        }
      }
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", childCode],
      {
        env: {
          ...process.env,
          MUSE_PROBE_ATTUNEMENT_FILE: attunementFile,
          MUSE_PROBE_HOLD_FILE: holdFile,
          MUSE_PROBE_HOME: root
        },
        stdio: ["ignore", "ignore", "pipe"]
      }
    );
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const [code, signal] = await once(child, "exit");
    expect({ code, signal }, stderr).toEqual({ code: 0, signal: null });
    expect(await readFile(attunementFile)).toEqual(before);
  }, 10_000);
});
