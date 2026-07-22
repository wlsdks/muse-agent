import { describe, expect, it } from "vitest";

import { createWorkArtifactValidator, createWorkExactArtifactResolver } from "./work-artifact.js";

const ID = "work_123e4567-e89b-4d3a-a456-426614174000";
const WORK = {
  boardTaskIds: ["secret-task"],
  createdAtIso: "2026-07-22T00:00:00.000Z",
  flowIds: ["secret-flow"],
  goal: "Ship\u001b[31m exact continuity",
  id: ID,
  name: "Work\u001b[31m continuity",
  outcomes: [{ atIso: "2026-07-22T01:00:00.000Z", kind: "used" as const, note: "private" }],
  status: "active" as const,
  threadId: "thread_same",
  updatedAtIso: "2026-07-22T02:00:00.000Z"
};

describe("exact Work artifact", () => {
  it("requires canonical exact context and matching thread binding", async () => {
    const validate = createWorkArtifactValidator({ readExactWork: async (id) => id === ID ? WORK : undefined });
    await expect(validate({ artifactId: ID, artifactType: "work", providerId: "local", threadId: "thread_same" }))
      .resolves.toEqual({ artifactId: ID, artifactType: "work", providerId: "local" });
    await expect(validate({ artifactId: ID, artifactType: "work", providerId: "local", threadId: "thread_other" }))
      .rejects.toThrow(/another PersonalThread/u);
    await expect(validate({ artifactId: `${ID} `, artifactType: "work", providerId: "local", threadId: "thread_same" }))
      .rejects.toThrow(/canonical full Work id/u);
  });

  it("projects bounded display fields and counts without leaking links, thread, or outcomes", async () => {
    const resolve = createWorkExactArtifactResolver({ readExactWork: async () => WORK });
    const result = await resolve({ artifactId: ID, artifactType: "work", linkedAt: "x", linkedBy: "user", providerId: "local", role: "context", threadId: "thread_same" });
    expect(result).toEqual({
      artifactId: ID,
      artifactType: "work",
      providerId: "local",
      role: "context",
      summary: "Ship[31m exact continuity",
      title: "Work[31m continuity",
      workBoardTaskCount: 1,
      workFlowCount: 1,
      workOutcomeCount: 1,
      workStatus: "active",
      workUpdatedAt: "2026-07-22T02:00:00.000Z"
    });
    expect(result).not.toHaveProperty("threadId");
    expect(result).not.toHaveProperty("outcomes");
    expect(JSON.stringify(result)).not.toContain("private");
    expect(result).not.toHaveProperty("outcome");
  });

  it("never resolves Work as a next-step", async () => {
    const resolve = createWorkExactArtifactResolver({ readExactWork: async () => WORK });
    await expect(resolve({ artifactId: ID, artifactType: "work", linkedAt: "x", linkedBy: "user", providerId: "local", role: "next-step", threadId: "thread_same" }))
      .resolves.toBeUndefined();
  });

  it("treats a deleted Work as unavailable and rejects normalized-empty text", async () => {
    const deleted = createWorkExactArtifactResolver({ readExactWork: async () => undefined });
    await expect(deleted({ artifactId: ID, artifactType: "work", linkedAt: "x", linkedBy: "user", providerId: "local", role: "context", threadId: "thread_same" }))
      .resolves.toBeUndefined();
    const validate = createWorkArtifactValidator({ readExactWork: async () => ({ ...WORK, goal: "\u0000\t", name: "\u0000\n" }) });
    await expect(validate({ artifactId: ID, artifactType: "work", providerId: "local", threadId: "thread_same" }))
      .rejects.toThrow(/non-empty safe/u);
  });
});
