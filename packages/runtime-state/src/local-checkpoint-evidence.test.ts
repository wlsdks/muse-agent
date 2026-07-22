import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeLocalCheckpointReference } from "@muse/shared";
import { afterEach, describe, expect, it } from "vitest";

import { checkpointV3FileName } from "./checkpoint-v3.js";
import { FileCheckpointStore } from "./file-checkpoint-store.js";
import { readLocalCheckpointEvidenceStrict } from "./local-checkpoint-evidence.js";

const roots: string[] = [];

interface MutableV3Envelope extends Record<string, unknown> {
  checkpoints: Array<{ state: unknown; step: number }>;
  provenance: { runId: string };
  schemaVersion?: number;
}

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

  it.each(["symlink", "directory"] as const)("rejects a %s checkpoint target", async (kind) => {
    const f = fixture();
    const runId = `target-${kind}`;
    await new FileCheckpointStore(f.checkpointsDir, { continuityWorkspaceDir: f.workspaceRealpath }).save({
      continuityEvidence: { phase: "act", query: "exact target" }, runId, state: { phase: "act" }, step: 1
    });
    const target = join(f.checkpointsDir, "v3", checkpointV3FileName(f.workspaceRealpath, runId));
    const original = readFileSync(target);
    rmSync(target);
    if (kind === "directory") mkdirSync(target);
    else {
      const outside = join(f.root, "outside.json");
      writeFileSync(outside, original);
      symlinkSync(outside, target);
    }
    const reference = encodeLocalCheckpointReference({ runId, step: 1, workspaceRealpath: f.workspaceRealpath });
    await expect(readLocalCheckpointEvidenceStrict({ allowedWorkspaceRealpath: f.workspaceRealpath, checkpointsDir: f.checkpointsDir, reference })).resolves.toMatchObject({ kind: "invalid" });
  });

  it("rejects an inode replacement after opening the exact target", async () => {
    const f = fixture();
    const runId = "racing-target";
    await new FileCheckpointStore(f.checkpointsDir, { continuityWorkspaceDir: f.workspaceRealpath }).save({
      continuityEvidence: { phase: "act", query: "before race" }, runId, state: { phase: "act" }, step: 1
    });
    const target = join(f.checkpointsDir, "v3", checkpointV3FileName(f.workspaceRealpath, runId));
    const replacement = `${target}.replacement`;
    writeFileSync(replacement, readFileSync(target));
    const reference = encodeLocalCheckpointReference({ runId, step: 1, workspaceRealpath: f.workspaceRealpath });

    await expect(readLocalCheckpointEvidenceStrict({
      allowedWorkspaceRealpath: f.workspaceRealpath,
      checkpointsDir: f.checkpointsDir,
      reference,
      testHooks: { afterOpen: () => renameSync(replacement, target) }
    })).resolves.toMatchObject({ kind: "invalid" });
  });

  it.each([
    ["fatal UTF-8", () => Buffer.from([0xff, 0xfe, 0xfd])],
    ["the 4 MiB file cap", () => Buffer.alloc(4 * 1_048_576 + 1, 0x20)]
  ] as const)("rejects evidence that violates %s", async (_name, bytes) => {
    const f = fixture();
    const runId = "bounded-file";
    await new FileCheckpointStore(f.checkpointsDir, { continuityWorkspaceDir: f.workspaceRealpath }).save({
      continuityEvidence: { phase: "start", query: "bounded" }, runId, state: { phase: "start" }, step: 0
    });
    const target = join(f.checkpointsDir, "v3", checkpointV3FileName(f.workspaceRealpath, runId));
    writeFileSync(target, bytes());
    const reference = encodeLocalCheckpointReference({ runId, step: 0, workspaceRealpath: f.workspaceRealpath });
    await expect(readLocalCheckpointEvidenceStrict({ allowedWorkspaceRealpath: f.workspaceRealpath, checkpointsDir: f.checkpointsDir, reference })).resolves.toMatchObject({ kind: "invalid" });
  });

  it.each([
    ["depth cap", (envelope: MutableV3Envelope) => {
      let nested: Record<string, unknown> = {};
      for (let index = 0; index < 70; index += 1) nested = { nested };
      envelope.checkpoints[0]!.state = nested;
    }],
    ["node cap", (envelope: MutableV3Envelope) => { envelope.checkpoints[0]!.state = { values: Array.from({ length: 65_536 }, () => 0) }; }],
    ["member cap", (envelope: MutableV3Envelope) => {
      envelope.checkpoints[0]!.state = Object.fromEntries(Array.from({ length: 65_537 }, (_, index) => [`k${index.toString()}`, 0]));
    }],
    ["array cap", (envelope: MutableV3Envelope) => { envelope.checkpoints[0]!.state = { values: Array.from({ length: 65_537 }, () => 0) }; }],
    ["unknown envelope key", (envelope: MutableV3Envelope) => { envelope.untrusted = true; }],
    ["missing envelope key", (envelope: MutableV3Envelope) => { delete envelope.schemaVersion; }],
    ["provenance mismatch", (envelope: MutableV3Envelope) => { envelope.provenance.runId = "different-run"; }],
    ["invalid exact step", (envelope: MutableV3Envelope) => { envelope.checkpoints[0]!.step = -1; }]
  ] as const)("rejects strict JSON/schema violation: %s", async (_name, mutate) => {
    const f = fixture();
    const runId = "strict-envelope";
    await new FileCheckpointStore(f.checkpointsDir, { continuityWorkspaceDir: f.workspaceRealpath }).save({
      continuityEvidence: { phase: "act", query: "strict" }, runId, state: { phase: "act" }, step: 1
    });
    const target = join(f.checkpointsDir, "v3", checkpointV3FileName(f.workspaceRealpath, runId));
    const envelope = JSON.parse(readFileSync(target, "utf8")) as MutableV3Envelope;
    mutate(envelope);
    writeFileSync(target, JSON.stringify(envelope));
    const reference = encodeLocalCheckpointReference({ runId, step: 1, workspaceRealpath: f.workspaceRealpath });
    await expect(readLocalCheckpointEvidenceStrict({ allowedWorkspaceRealpath: f.workspaceRealpath, checkpointsDir: f.checkpointsDir, reference })).resolves.toMatchObject({ kind: "invalid" });
  });
});
