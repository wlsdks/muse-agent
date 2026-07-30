import { describe, expect, it } from "vitest";

import {
  archiveProjectExecution,
  createProjectExecutionReadModel,
  setProjectExecutionStatus,
  type ProjectExecutionReadModelInput
} from "../src/project-execution-read-model.js";

function input(): ProjectExecutionReadModelInput {
  return {
    goal: "Ship a trusted personal-agent loop",
    links: {
      continuityThreadIds: ["continuity-2", "continuity-1"],
      conversationIds: ["conversation-1"],
      evidenceIds: ["evidence-1"],
      outcomeIds: ["outcome-1"],
      taskIds: ["task-1"]
    },
    owner: "user",
    projectId: "project_muse-loop",
    source: { kind: "owner-created" },
    status: "active"
  };
}

describe("project execution read model", () => {
  it("mints a separate immutable project identity with explicit domain links", () => {
    const mutable = input();
    const model = createProjectExecutionReadModel(mutable);
    mutable.links.continuityThreadIds = ["changed"];

    expect(model).toEqual({
      ...input(),
      links: {
        ...input().links,
        continuityThreadIds: ["continuity-1", "continuity-2"]
      },
      schemaVersion: 1
    });
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model.links)).toBe(true);
    expect(Object.isFrozen(model.links.continuityThreadIds)).toBe(true);
    expect(model.projectId).not.toBe(model.links.conversationIds[0]);
    expect(model.projectId).not.toBe(model.links.continuityThreadIds[0]);
  });

  it("changes only project status while linked domains remain identical", () => {
    const active = createProjectExecutionReadModel(input());
    const completed = setProjectExecutionStatus(active, "completed");
    const archived = archiveProjectExecution(completed);

    expect(active.status).toBe("active");
    expect(completed.status).toBe("completed");
    expect(archived.status).toBe("archived");
    expect(completed.links).toBe(active.links);
    expect(archived.links).toBe(active.links);
    expect(completed.source).toBe(active.source);
    expect(archived).not.toHaveProperty("evidence");
    expect(archived).not.toHaveProperty("outcome");
  });

  it("rejects project ID reuse while allowing opaque IDs in distinct namespaces", () => {
    expect(() => createProjectExecutionReadModel({
      ...input(),
      links: { ...input().links, taskIds: ["project_muse-loop"] }
    })).toThrow(/projectId/u);
    expect(createProjectExecutionReadModel({
      ...input(),
      links: { ...input().links, outcomeIds: ["evidence-1"] }
    }).links).toMatchObject({
      evidenceIds: ["evidence-1"],
      outcomeIds: ["evidence-1"]
    });
    expect(() => createProjectExecutionReadModel({
      ...input(),
      projectId: "conversation-1"
    })).toThrow(/project_/u);
  });

  it("fails closed on extra fields, accessors, and proxies without invoking traps", () => {
    expect(() => createProjectExecutionReadModel({
      ...input(),
      hiddenAuthority: "mutate-thread"
    } as ProjectExecutionReadModelInput)).toThrow(/exactly/u);

    const accessor = input() as ProjectExecutionReadModelInput;
    let getterCalls = 0;
    Object.defineProperty(accessor, "goal", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "must not run";
      }
    });
    expect(() => createProjectExecutionReadModel(accessor)).toThrow();
    expect(getterCalls).toBe(0);

    let proxyGets = 0;
    const proxy = new Proxy(input(), {
      get() {
        proxyGets += 1;
        throw new Error("must not inspect proxy");
      }
    });
    expect(() => createProjectExecutionReadModel(proxy)).toThrow();
    expect(proxyGets).toBe(0);
  });

  it("revalidates cloned persisted data before changing status", () => {
    const cloned = structuredClone(createProjectExecutionReadModel(input()));
    expect(setProjectExecutionStatus(cloned, "blocked")).toMatchObject({
      projectId: "project_muse-loop",
      schemaVersion: 1,
      status: "blocked"
    });
    expect(() => setProjectExecutionStatus({
      ...cloned,
      schemaVersion: 2
    } as never, "blocked")).toThrow(/schemaVersion/u);
  });
});
