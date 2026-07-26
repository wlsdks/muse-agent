import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPersonalThread, startTimingSession } from "@muse/attunement";
import { FileUserMemoryStore } from "@muse/memory";
import {
  activateQualificationLearningHold,
  enqueueLearnEvent,
  writePlaybook,
  type ActivePlaybookWriteGate,
  type PlaybookEntry
} from "@muse/stores";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import type { CompatibilityRouteOptions } from "./compat-routes.js";
import { registerUserMemoryCompatRoutes } from "./user-memory-compat-routes.js";

const allowActivePlaybookWrites: ActivePlaybookWriteGate = {
  run: (operation) => operation()
};
const NOW = new Date("2026-07-26T09:00:00.000Z");
const playbookEntry: PlaybookEntry = {
  createdAt: "2026-07-26T08:00:00.000Z",
  id: "existing-strategy",
  probation: false,
  reward: 2,
  text: "keep replies concise",
  userId: "owner"
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("explicit user-memory fact qualification-hold exception", () => {
  it("keeps the public fact contract while every active skill and policy surface remains byte-identical", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-explicit-memory-hold-"));
    roots.push(root);
    const attunementFile = join(root, "attunement.json");
    const authoredSkillsDir = join(root, "authored-skills");
    const holdFile = join(root, "qualification-learning-hold.json");
    const memoryFile = join(root, "user-memory.json");
    const playbookFile = join(root, "playbook.json");
    const proposalFile = join(root, "learn-queue.jsonl");
    const timingFile = join(root, "timing.json");
    await mkdir(authoredSkillsDir);

    const memory = new FileUserMemoryStore({
      env: { HOME: root },
      file: memoryFile,
      now: () => NOW
    });
    await memory.upsertFact("owner", "existing_fact", "kept");
    await writePlaybook(playbookFile, [playbookEntry], allowActivePlaybookWrites);
    const thread = await createPersonalThread(
      attunementFile,
      { kind: "life", title: "Existing continuity" },
      { idFactory: () => "thread_existing", now: () => NOW }
    );
    await startTimingSession(
      timingFile,
      { consentVersion: 1, threadId: thread.id },
      async () => undefined,
      { idFactory: () => "timing_existing", now: () => NOW }
    );
    await enqueueLearnEvent(proposalFile, {
      correction: "use shorter paragraphs",
      enqueuedAtMs: NOW.getTime(),
      id: "proposal-existing",
      priorAnswer: "long answer",
      userId: "owner"
    });
    await activateQualificationLearningHold(holdFile, {
      activatedAt: "2026-07-26T08:30:00.000Z",
      holdId: "personal-agent-v1"
    });

    const protectedFiles = [attunementFile, holdFile, playbookFile, proposalFile, timingFile] as const;
    const protectedBefore = new Map(
      await Promise.all(protectedFiles.map(async (file) => [file, await readFile(file)] as const))
    );
    const memoryBefore = await readFile(memoryFile);
    const app = Fastify();
    registerUserMemoryCompatRoutes(app, {
      authService: undefined,
      userMemoryStore: memory
    } as unknown as CompatibilityRouteOptions);

    const recorded = await app.inject({
      method: "PUT",
      payload: { key: " Home City ", value: " Seoul " },
      url: "/api/user-memory/owner/facts"
    });
    expect(recorded.statusCode).toBe(200);
    expect(recorded.json()).toEqual({ updated: true });
    const stored = await memory.findByUserId("owner");
    expect(stored).toMatchObject({
      facts: {
        existing_fact: "kept",
        home_city: "Seoul"
      },
      preferences: {}
    });
    expect(stored).not.toHaveProperty("userModel");
    expect(await readFile(memoryFile)).not.toEqual(memoryBefore);

    const afterFirstFact = await readFile(memoryFile);
    const replay = await app.inject({
      method: "PUT",
      payload: { key: "Home City", value: "Seoul" },
      url: "/api/user-memory/owner/facts"
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ updated: true });
    expect(await readFile(memoryFile)).toEqual(afterFirstFact);

    const invalid = await app.inject({
      method: "PUT",
      payload: { key: "timezone", value: "" },
      url: "/api/user-memory/owner/facts"
    });
    expect(invalid.statusCode).toBe(400);
    expect(await readFile(memoryFile)).toEqual(afterFirstFact);

    for (const file of protectedFiles) {
      expect(await readFile(file)).toEqual(protectedBefore.get(file));
    }
    expect(await readdir(authoredSkillsDir)).toEqual([]);
    await app.close();
  });
});
