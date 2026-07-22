import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileCheckpointStore } from "@muse/runtime-state";
import { encodeLocalCheckpointReference } from "@muse/shared";
import { afterEach, describe, expect, it } from "vitest";

import { createCheckpointArtifactValidator, createCheckpointExactArtifactResolver } from "./checkpoint-artifacts.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))));

async function fixture() {
  const created = await mkdtemp(join(tmpdir(), "muse-attunement-checkpoint-"));
  roots.push(created);
  const workspaceRealpath = await realpath(created);
  const checkpointsDir = join(workspaceRealpath, "checkpoints");
  const runId = "run_interrupted";
  const step = 4;
  await new FileCheckpointStore(checkpointsDir, { continuityWorkspaceDir: workspaceRealpath }).save({
    continuityEvidence: { phase: "act", query: "Continue the release checklist" },
    runId,
    state: { encodedMessages: ["private"], metadata: { token: "secret" }, output: "hidden", phase: "act" },
    step
  });
  const reference = encodeLocalCheckpointReference({ runId, step, workspaceRealpath });
  return { checkpointsDir, reference, workspaceRealpath };
}

describe("exact checkpoint artifact adapter", () => {
  it("validates and projects only context-safe fields", async () => {
    const f = await fixture();
    const options = { allowedWorkspaceRealpath: f.workspaceRealpath, checkpointsDir: f.checkpointsDir };
    await expect(createCheckpointArtifactValidator(options)({ artifactId: f.reference, artifactType: "checkpoint", providerId: "local" })).resolves.toEqual({
      artifactId: f.reference,
      artifactType: "checkpoint",
      providerId: "local"
    });
    const artifact = await createCheckpointExactArtifactResolver(options)({
      artifactId: f.reference,
      artifactType: "checkpoint",
      linkedAt: "2026-07-22T00:01:00.000Z",
      linkedBy: "user",
      providerId: "local",
      role: "context",
      threadId: "thread_1"
    });
    expect(artifact).toMatchObject({
      artifactType: "checkpoint",
      checkpointPhase: "act",
      checkpointStep: 4,
      summary: "Execution checkpoint 4:act",
      title: "Continue the release checklist"
    });
    expect(artifact).not.toHaveProperty("state");
    expect(artifact).not.toHaveProperty("output");
    expect(artifact).not.toHaveProperty("metadata");
  });

  it("is context-only and rejects absent exact steps", async () => {
    const f = await fixture();
    const options = { allowedWorkspaceRealpath: f.workspaceRealpath, checkpointsDir: f.checkpointsDir };
    const resolver = createCheckpointExactArtifactResolver(options);
    await expect(resolver({ artifactId: f.reference, artifactType: "checkpoint", linkedAt: "2026-07-22T00:01:00.000Z", linkedBy: "user", providerId: "local", role: "next-step", threadId: "thread_1" })).resolves.toBeUndefined();
    const missing = encodeLocalCheckpointReference({ runId: "run_interrupted", step: 99, workspaceRealpath: f.workspaceRealpath });
    await expect(createCheckpointArtifactValidator(options)({ artifactId: missing, artifactType: "checkpoint", providerId: "local" })).rejects.toThrow(/no local checkpoint/u);
  });
});
