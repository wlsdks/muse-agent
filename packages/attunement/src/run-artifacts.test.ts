import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeLocalRunReference } from "@muse/shared";
import { afterEach, describe, expect, it } from "vitest";

import { createRunArtifactValidator, createRunExactArtifactResolver } from "./run-artifacts.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))));

async function fixture() {
  const created = await mkdtemp(join(tmpdir(), "muse-attunement-run-"));
  roots.push(created);
  const workspaceRealpath = await realpath(created);
  const runsDir = join(workspaceRealpath, ".muse", "runs");
  await mkdir(runsDir, { recursive: true });
  const runId = "run_exact";
  const reference = encodeLocalRunReference({ runId, workspaceRealpath });
  const event = {
    apiUrl: "http://127.0.0.1:3030",
    grounded: "contested",
    message: "Continue release preparation",
    model: null,
    recordedAt: "2026-07-22T00:00:00.000Z",
    response: { response: "Reviewed the remaining release gate.", secret: "private", toolsUsed: ["task_read"] },
    runId,
    source: "cli.local",
    success: true,
    type: "chat.completed"
  };
  await writeFile(join(runsDir, `${runId}.jsonl`), `${JSON.stringify(event)}\n`, "utf8");
  return { reference, workspaceRealpath };
}

describe("exact run artifact adapter", () => {
  it("validates one exact workspace-scoped reference and projects no raw event fields", async () => {
    const f = await fixture();
    const validate = createRunArtifactValidator({ allowedWorkspaceRealpath: f.workspaceRealpath });
    await expect(validate({ artifactId: f.reference, artifactType: "run", providerId: "local" })).resolves.toEqual({
      artifactId: f.reference,
      artifactType: "run",
      providerId: "local"
    });
    const resolve = createRunExactArtifactResolver({ allowedWorkspaceRealpath: f.workspaceRealpath });
    const artifact = await resolve({ artifactId: f.reference, artifactType: "run", linkedAt: "2026-07-22T00:01:00.000Z", linkedBy: "user", providerId: "local", role: "context", threadId: "thread_1" });
    expect(artifact).toMatchObject({
      artifactType: "run",
      runOutcome: "contested",
      runSuccess: true,
      runToolNames: ["task_read"],
      summary: "Reviewed the remaining release gate.",
      title: "Continue release preparation"
    });
    expect(JSON.stringify(artifact)).not.toContain("private");
    expect(JSON.stringify(artifact)).not.toContain("apiUrl");
  });

  it("keeps run evidence context-only", async () => {
    const f = await fixture();
    const resolve = createRunExactArtifactResolver({ allowedWorkspaceRealpath: f.workspaceRealpath });
    await expect(resolve({ artifactId: f.reference, artifactType: "run", linkedAt: "2026-07-22T00:01:00.000Z", linkedBy: "user", providerId: "local", role: "next-step", threadId: "thread_1" })).resolves.toBeUndefined();
  });

  it("fails closed for a different configured workspace or absent exact run", async () => {
    const f = await fixture();
    const other = await fixture();
    await expect(createRunArtifactValidator({ allowedWorkspaceRealpath: other.workspaceRealpath })({ artifactId: f.reference, artifactType: "run", providerId: "local" })).rejects.toThrow(/configured workspace/u);
    const missing = encodeLocalRunReference({ runId: "run_missing", workspaceRealpath: f.workspaceRealpath });
    await expect(createRunArtifactValidator({ allowedWorkspaceRealpath: f.workspaceRealpath })({ artifactId: missing, artifactType: "run", providerId: "local" })).rejects.toThrow(/no local run/u);
  });
});
