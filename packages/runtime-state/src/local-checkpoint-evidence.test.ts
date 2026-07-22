import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeLocalCheckpointReference } from "@muse/shared";
import { afterEach, describe, expect, it } from "vitest";

import { checkpointV3FileName } from "./checkpoint-v3.js";
import { FileCheckpointStore } from "./file-checkpoint-store.js";
import { readLocalCheckpointEvidenceStrict } from "./local-checkpoint-evidence.js";

const roots: string[] = [];

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "muse-checkpoint-evidence-")));
  roots.push(root);
  const workspaceRealpath = realpathSync(mkdtempSync(join(root, "workspace-")));
  const checkpointsDir = join(root, "checkpoints");
  return { checkpointsDir, root, workspaceRealpath };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("readLocalCheckpointEvidenceStrict", () => {
  it("projects only bounded purpose-built evidence from an exact future v3 step", async () => {
    const f = fixture();
    const store = new FileCheckpointStore(f.checkpointsDir, { continuityWorkspaceDir: f.workspaceRealpath });
    await store.save({
      continuityEvidence: { phase: "act", query: `  ${"가".repeat(200)}\n next  ` },
      runId: "run_exact",
      state: { encodedMessages: ["secret"], metadata: { token: "do-not-project" }, output: "private", phase: "act" },
      step: 3
    });
    const reference = encodeLocalCheckpointReference({ runId: "run_exact", step: 3, workspaceRealpath: f.workspaceRealpath });
    const result = await readLocalCheckpointEvidenceStrict({ allowedWorkspaceRealpath: f.workspaceRealpath, checkpointsDir: f.checkpointsDir, reference });
    expect(result.kind).toBe("available");
    if (result.kind === "available") {
      expect(result.evidence).toMatchObject({ phase: "act", runId: "run_exact", step: 3, workspaceRealpath: f.workspaceRealpath });
      expect(new TextEncoder().encode(result.evidence.query).byteLength).toBeLessThanOrEqual(240);
      expect(result.evidence).not.toHaveProperty("state");
      expect(result.evidence).not.toHaveProperty("metadata");
      expect(result.evidence).not.toHaveProperty("output");
    }
  });

  it("treats valid v3 checkpoints without safe evidence and legacy v2-only runs as absent", async () => {
    const f = fixture();
    const future = new FileCheckpointStore(f.checkpointsDir, { continuityWorkspaceDir: f.workspaceRealpath });
    await future.save({ runId: "no-evidence", state: { phase: "act" }, step: 1 });
    const noEvidence = encodeLocalCheckpointReference({ runId: "no-evidence", step: 1, workspaceRealpath: f.workspaceRealpath });
    await expect(readLocalCheckpointEvidenceStrict({ allowedWorkspaceRealpath: f.workspaceRealpath, checkpointsDir: f.checkpointsDir, reference: noEvidence })).resolves.toEqual({ kind: "absent" });

    await new FileCheckpointStore(f.checkpointsDir).save({ runId: "legacy-only", state: { phase: "act" }, step: 1 });
    const legacy = encodeLocalCheckpointReference({ runId: "legacy-only", step: 1, workspaceRealpath: f.workspaceRealpath });
    await expect(readLocalCheckpointEvidenceStrict({ allowedWorkspaceRealpath: f.workspaceRealpath, checkpointsDir: f.checkpointsDir, reference: legacy })).resolves.toEqual({ kind: "absent" });
  });

  it("rejects cross-workspace references and duplicate-key tampering", async () => {
    const f = fixture();
    const other = realpathSync(mkdtempSync(join(f.root, "other-")));
    const store = new FileCheckpointStore(f.checkpointsDir, { continuityWorkspaceDir: f.workspaceRealpath });
    await store.save({ continuityEvidence: { phase: "start", query: "exact" }, runId: "run", state: { phase: "start" }, step: 0 });
    const reference = encodeLocalCheckpointReference({ runId: "run", step: 0, workspaceRealpath: f.workspaceRealpath });
    await expect(readLocalCheckpointEvidenceStrict({ allowedWorkspaceRealpath: other, checkpointsDir: f.checkpointsDir, reference })).resolves.toMatchObject({ kind: "invalid" });

    const path = join(f.checkpointsDir, "v3", checkpointV3FileName(f.workspaceRealpath, "run"));
    const raw = readFileSync(path, "utf8");
    writeFileSync(path, raw.replace('"schemaVersion":3', '"schemaVersion":3,"schemaVersion":3'));
    await expect(readLocalCheckpointEvidenceStrict({ allowedWorkspaceRealpath: f.workspaceRealpath, checkpointsDir: f.checkpointsDir, reference })).resolves.toMatchObject({ kind: "invalid" });
  });

  it("does not follow a symlinked v3 root", async () => {
    const f = fixture();
    const outside = realpathSync(mkdtempSync(join(f.root, "outside-")));
    const store = new FileCheckpointStore(f.checkpointsDir, { continuityWorkspaceDir: f.workspaceRealpath });
    await store.save({ continuityEvidence: { phase: "start", query: "exact" }, runId: "run", state: { phase: "start" }, step: 0 });
    rmSync(join(f.checkpointsDir, "v3"), { recursive: true });
    symlinkSync(outside, join(f.checkpointsDir, "v3"));
    const reference = encodeLocalCheckpointReference({ runId: "run", step: 0, workspaceRealpath: f.workspaceRealpath });
    await expect(readLocalCheckpointEvidenceStrict({ allowedWorkspaceRealpath: f.workspaceRealpath, checkpointsDir: f.checkpointsDir, reference })).resolves.toMatchObject({ kind: "invalid" });
  });
});
