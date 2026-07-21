import { describe, expect, it, vi } from "vitest";

import { baselinePolicy, policyForOutcome, prepareContinuityPack, type AttunementState, type ArtifactLink, type ExactArtifactResolver } from "./index.js";

const taskLink: ArtifactLink = {
  artifactId: "task_finish-invite",
  artifactType: "task",
  linkedAt: "2026-07-14T00:00:00.000Z",
  linkedBy: "user",
  providerId: "local",
  role: "next-step",
  threadId: "thread_life"
};

const noteLink: ArtifactLink = {
  artifactId: "birthday/ideas.md",
  artifactType: "note",
  linkedAt: "2026-07-14T00:00:00.000Z",
  linkedBy: "user",
  providerId: "local",
  role: "context",
  threadId: "thread_life"
};

function state(policy = baselinePolicy()): AttunementState {
  return {
    deliveries: [],
    interactionReceipts: [],
    nextPolicyVersion: 1,
    resetReceipts: [],
    schemaVersion: 4,
    threads: [{ createdAt: "2026-07-14T00:00:00.000Z", id: "thread_life", kind: "life", links: [noteLink, taskLink], policy, title: "Plan a birthday" }],
    undoResetReceipts: []
  };
}

function buildContinuityPack(current: AttunementState, threadId: string, resolver: ExactArtifactResolver) {
  return prepareContinuityPack(current, threadId, resolver, { now: () => Date.parse("2026-07-18T09:00:00.000Z") });
}

describe("buildContinuityPack", () => {
  it("captures one preparation time and derives one shared overdue task artifact", async () => {
    const now = vi.fn(() => Date.parse("2026-07-18T09:00:00.001Z"));
    const pack = await prepareContinuityPack(state(), "thread_life", async (link) => ({
      ...link,
      taskDueAt: link.artifactType === "task" ? "2026-07-18T09:00:00.000Z" : undefined,
      taskStatus: link.artifactType === "task" ? "open" : undefined,
      title: link.artifactId
    }), { now });

    expect(now).toHaveBeenCalledTimes(1);
    expect(pack.nextStep?.taskDueState).toBe("overdue");
    expect(pack.evidence.find((entry) => entry.reference.artifactType === "task")?.artifact).toBe(pack.nextStep);
  });

  it.each([
    ["2026-07-18T09:00:00.000Z", "due"],
    ["2026-07-18T09:00:00.001Z", "due"],
    ["not-a-date", undefined]
  ] as const)("derives fail-closed due state for %s", async (taskDueAt, expected) => {
    const pack = await prepareContinuityPack(state(), "thread_life", async (link) => ({
      ...link,
      taskDueAt: link.artifactType === "task" ? taskDueAt : undefined,
      taskStatus: link.artifactType === "task" ? "open" : undefined,
      title: link.artifactId
    }), { now: () => Date.parse("2026-07-18T09:00:00.000Z") });

    expect(pack.nextStep?.taskDueState).toBe(expected);
    if (expected === undefined) expect(pack.nextStep?.taskDueAt).toBeUndefined();
  });

  it("keeps completed tasks due rather than overdue", async () => {
    const pack = await prepareContinuityPack(state(), "thread_life", async (link) => ({
      ...link,
      taskDueAt: link.artifactType === "task" ? "2026-07-17T09:00:00.000Z" : undefined,
      taskStatus: link.artifactType === "task" ? "done" : undefined,
      title: link.artifactId
    }), { now: () => Date.parse("2026-07-18T09:00:00.000Z") });

    expect(pack.evidence.find((entry) => entry.reference.artifactType === "task")?.artifact?.taskDueState).toBe("due");
  });

  it.each([
    ["pending", "2026-07-17T09:00:00.000Z", "overdue"],
    ["pending", "2026-07-19T09:00:00.000Z", "due"],
    ["fired", "2026-07-17T09:00:00.000Z", undefined]
  ] as const)("derives reminder temporal state for %s", async (reminderStatus, reminderDueAt, expected) => {
    const reminderLink: ArtifactLink = {
      artifactId: "reminder_dentist",
      artifactType: "reminder",
      linkedAt: "2026-07-14T00:00:00.000Z",
      linkedBy: "user",
      providerId: "local",
      role: "context",
      threadId: "thread_life"
    };
    const current: AttunementState = {
      ...state(),
      threads: [{ ...state().threads[0]!, links: [reminderLink, taskLink] }]
    };
    const pack = await prepareContinuityPack(current, "thread_life", async (link) => link.artifactType === "reminder"
      ? { ...link, reminderDueAt, reminderStatus, title: "Dentist reminder" }
      : { ...link, taskStatus: "open", title: "Finish invitation list" }, {
      now: () => Date.parse("2026-07-18T09:00:00.000Z")
    });

    const reminder = pack.evidence.find((entry) => entry.reference.artifactType === "reminder")?.artifact;
    expect(reminder?.reminderDueState).toBe(expected);
    expect(pack.nextStep?.artifactType).toBe("task");
    expect(pack.interactionAnchor?.artifactId).toBe(taskLink.artifactId);
  });

  it("resolves only the selected thread's stored links, preserving unavailable references", async () => {
    const calls: string[] = [];
    const pack = await buildContinuityPack(state(), "thread_life", async (link) => {
      calls.push(link.artifactId);
      if (link.artifactType === "note") return undefined;
      return { ...link, taskStatus: "open", title: "Finish invitation list" };
    });

    expect(calls).toEqual(["birthday/ideas.md", "task_finish-invite"]);
    expect(pack.evidence.map((entry) => [entry.reference.artifactType, entry.reference.artifactId, entry.status])).toEqual([
      ["note", "birthday/ideas.md", "unavailable"],
      ["task", "task_finish-invite", "available"]
    ]);
    expect(pack.nextStep?.title).toBe("Finish invitation list");
    expect(pack.evidenceRefs).toEqual([noteLink, taskLink].map(({ artifactId, artifactType, providerId, role }) => ({ artifactId, artifactType, providerId, role })));
  });

  it("rejects a resolver artifact whose canonical id does not match the user-authored link", async () => {
    await expect(buildContinuityPack(state(), "thread_life", async (link) => ({
      ...link,
      artifactId: link.artifactType === "task" ? "task_other" : link.artifactId,
      taskStatus: link.artifactType === "task" ? "open" : undefined,
      title: link.artifactId
    }))).rejects.toThrow("exact artifact resolver returned mismatched artifactId");
  });

  it("rejects a resolver artifact whose type does not match the user-authored link", async () => {
    await expect(buildContinuityPack(state(), "thread_life", async (link) => ({
      ...link,
      artifactType: link.artifactType === "task" ? "note" : link.artifactType,
      title: link.artifactId
    }))).rejects.toThrow("exact artifact resolver returned mismatched artifactType");
  });

  it("rejects a resolver artifact whose provider does not match the user-authored link", async () => {
    await expect(buildContinuityPack(state(), "thread_life", async (link) => ({
      ...link,
      providerId: link.artifactType === "task" ? "mcp:other" : link.providerId,
      title: link.artifactId
    }))).rejects.toThrow("exact artifact resolver returned mismatched providerId");
  });

  it("rejects a resolver artifact whose role does not match the user-authored link", async () => {
    await expect(buildContinuityPack(state(), "thread_life", async (link) => ({
      ...link,
      role: link.artifactType === "task" ? "context" : link.role,
      title: link.artifactId
    }))).rejects.toThrow("exact artifact resolver returned mismatched role");
  });

  it("does not infer a replacement when the linked next task is done or hidden", async () => {
    const done = await buildContinuityPack(state(), "thread_life", async (link) => ({ ...link, taskStatus: link.artifactType === "task" ? "done" : undefined, title: link.artifactId }));
    expect(done.nextStep).toBeUndefined();

    const hidden = await buildContinuityPack(state(policyForOutcome("rejected", 1)), "thread_life", async (link) => ({ ...link, taskStatus: link.artifactType === "task" ? "open" : undefined, title: link.artifactId }));
    expect(hidden.nextStep).toBeUndefined();
    expect(hidden.policy.nextStep).toBe("hidden");
  });

  it("shows a resolved external resource as evidence and never promotes it to a next-step", async () => {
    const resourceLink: ArtifactLink = {
      artifactId: "facebook/react/issues/1",
      artifactType: "resource",
      linkedAt: "2026-07-14T00:00:00.000Z",
      linkedBy: "user",
      providerId: "mcp:github",
      role: "context",
      threadId: "thread_work"
    };
    const withResource: AttunementState = {
      deliveries: [],
      interactionReceipts: [],
      nextPolicyVersion: 1,
      resetReceipts: [],
      schemaVersion: 4,
      threads: [{ createdAt: "2026-07-14T00:00:00.000Z", id: "thread_work", kind: "work", links: [resourceLink, taskLink], policy: baselinePolicy(), title: "Ship the adapter" }],
      undoResetReceipts: []
    };
    const pack = await buildContinuityPack(withResource, "thread_work", async (link) => {
      if (link.artifactType === "resource") {
        return { ...link, summary: "untrusted body text", title: "Fix the render loop" };
      }
      return { ...link, taskStatus: "open", title: "Finish invitation list" };
    });

    const resource = pack.evidence.find((entry) => entry.reference.artifactType === "resource");
    expect(resource?.status).toBe("available");
    expect(resource?.artifact?.title).toBe("Fix the render loop");
    expect(resource?.artifact?.providerId).toBe("mcp:github");
    // The resource is context; the next-step still comes only from the local open task.
    expect(pack.nextStep?.title).toBe("Finish invitation list");
    expect(pack.nextStep?.artifactType).toBe("task");
  });

  it("marks an unresolvable external resource unavailable and never fabricates a title", async () => {
    const resourceLink: ArtifactLink = {
      artifactId: "facebook/react/issues/999",
      artifactType: "resource",
      linkedAt: "2026-07-14T00:00:00.000Z",
      linkedBy: "user",
      providerId: "mcp:github",
      role: "context",
      threadId: "thread_work"
    };
    const withResource: AttunementState = {
      deliveries: [],
      interactionReceipts: [],
      nextPolicyVersion: 1,
      resetReceipts: [],
      schemaVersion: 4,
      threads: [{ createdAt: "2026-07-14T00:00:00.000Z", id: "thread_work", kind: "work", links: [resourceLink], policy: baselinePolicy(), title: "Ship the adapter" }],
      undoResetReceipts: []
    };
    const pack = await buildContinuityPack(withResource, "thread_work", async () => undefined);
    const resource = pack.evidence[0]!;
    expect(resource.status).toBe("unavailable");
    expect(resource.artifact).toBeUndefined();
  });

  it("carries the previous outcome only when policy asks to acknowledge it", async () => {
    const base = state(policyForOutcome("ignored", 1));
    const withDelivery: AttunementState = {
      ...base,
      deliveries: [{
        evidenceClass: "unclassified",
        evidenceRefs: [],
        id: "delivery_previous",
        openedAt: "2026-07-14T00:00:00.000Z",
        outcome: { evidenceClass: "unclassified", outcome: "ignored", policyVersion: 1, recordedAt: "2026-07-14T01:00:00.000Z" },
        policyVersion: 0,
        threadId: "thread_life"
      }]
    };
    const pack = await buildContinuityPack(withDelivery, "thread_life", async (link) => ({ ...link, taskStatus: link.artifactType === "task" ? "open" : undefined, title: link.artifactId }));
    expect(pack.previousOutcome).toBe("ignored");
  });
});
