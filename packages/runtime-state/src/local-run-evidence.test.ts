import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeLocalRunReference } from "@muse/shared";
import { afterEach, describe, expect, it } from "vitest";

import { readLocalRunEvidenceStrict } from "./local-run-evidence.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture(runId = "run_exact") {
  const created = await mkdtemp(join(tmpdir(), "muse-run-evidence-"));
  roots.push(created);
  const workspaceRealpath = await realpath(created);
  const runsDir = join(workspaceRealpath, ".muse", "runs");
  await mkdir(runsDir, { recursive: true });
  const reference = encodeLocalRunReference({ runId, workspaceRealpath });
  return { file: join(runsDir, `${runId}.jsonl`), reference, runId, runsDir, workspaceRealpath };
}

function event(runId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiUrl: "http://127.0.0.1:3030",
    grounded: "grounded",
    message: "continue the exact work",
    model: null,
    recordedAt: "2026-07-22T00:00:00.000Z",
    response: {
      response: "finished the bounded step",
      secret: "must-not-cross-the-projection",
      toolArguments: { token: "secret" },
      toolsUsed: ["notes.search", "task_read"]
    },
    runId,
    source: "cli.local",
    success: true,
    type: "chat.completed",
    ...overrides
  };
}

describe("readLocalRunEvidenceStrict", () => {
  it("projects only bounded safe fields from the final fully validated event", async () => {
    const f = await fixture();
    await writeFile(f.file, `${JSON.stringify(event(f.runId, { message: "  continue   work  " }))}\n`, "utf8");
    const result = await readLocalRunEvidenceStrict({ allowedWorkspaceRealpath: f.workspaceRealpath, reference: f.reference });
    expect(result).toEqual({
      evidence: {
        answerSummary: "finished the bounded step",
        outcome: "grounded",
        query: "continue work",
        recordedAt: "2026-07-22T00:00:00.000Z",
        runId: f.runId,
        success: true,
        toolNames: ["notes.search", "task_read"],
        workspaceRealpath: f.workspaceRealpath
      },
      kind: "available"
    });
    expect(JSON.stringify(result)).not.toContain("must-not-cross");
    expect(JSON.stringify(result)).not.toContain("toolArguments");
  });

  it("validates every line and returns only the final event", async () => {
    const f = await fixture();
    await writeFile(f.file, `${JSON.stringify(event(f.runId, { message: "first" }))}\n${JSON.stringify(event(f.runId, { message: "second" }))}\n`, "utf8");
    const result = await readLocalRunEvidenceStrict({ allowedWorkspaceRealpath: f.workspaceRealpath, reference: f.reference });
    expect(result.kind).toBe("available");
    if (result.kind === "available") expect(result.evidence.query).toBe("second");
  });

  it("distinguishes an absent exact trace", async () => {
    const f = await fixture();
    expect(await readLocalRunEvidenceStrict({ allowedWorkspaceRealpath: f.workspaceRealpath, reference: f.reference })).toEqual({ kind: "absent" });
  });

  it("rejects a locator outside the explicitly allowed workspace", async () => {
    const f = await fixture();
    const other = await fixture("run_other");
    expect(await readLocalRunEvidenceStrict({ allowedWorkspaceRealpath: other.workspaceRealpath, reference: f.reference })).toMatchObject({ kind: "invalid" });
  });

  it("rejects symlinked run targets", async () => {
    const f = await fixture();
    const source = join(f.runsDir, "source.jsonl");
    await writeFile(source, `${JSON.stringify(event(f.runId))}\n`, "utf8");
    await symlink(source, f.file);
    expect(await readLocalRunEvidenceStrict({ allowedWorkspaceRealpath: f.workspaceRealpath, reference: f.reference })).toMatchObject({ kind: "invalid" });
  });

  it("rejects a symlinked run evidence root", async () => {
    const created = await mkdtemp(join(tmpdir(), "muse-run-root-link-"));
    const external = await mkdtemp(join(tmpdir(), "muse-run-root-external-"));
    roots.push(created, external);
    const workspaceRealpath = await realpath(created);
    await mkdir(join(workspaceRealpath, ".muse"), { recursive: true });
    await symlink(external, join(workspaceRealpath, ".muse", "runs"));
    const reference = encodeLocalRunReference({ runId: "run_exact", workspaceRealpath });
    expect(await readLocalRunEvidenceStrict({ allowedWorkspaceRealpath: workspaceRealpath, reference })).toMatchObject({ kind: "invalid" });
  });

  it.each([
    '{"apiUrl":"x","apiUrl":"y"}',
    "not-json"
  ])("rejects malformed or duplicate-key JSON byte-stably: %s", async (raw) => {
    const f = await fixture();
    await writeFile(f.file, `${raw}\n${JSON.stringify(event(f.runId))}\n`, "utf8");
    const before = await readFile(f.file);
    expect(await readLocalRunEvidenceStrict({ allowedWorkspaceRealpath: f.workspaceRealpath, reference: f.reference })).toMatchObject({ kind: "invalid" });
    expect(await readFile(f.file)).toEqual(before);
  });

  it.each([
    () => event("run_other"),
    () => {
      const value = event("run_exact");
      delete value.runId;
      return value;
    },
    () => event("run_exact", { extra: true }),
    () => event("run_exact", { grounded: "unknown" }),
    () => event("run_exact", { grounded: { verdict: "grounded" } }),
    () => event("run_exact", { message: "bad\u0000query" }),
    () => event("run_exact", { recordedAt: "2026-07-22T00:00:00Z" }),
    () => event("run_exact", { response: { response: "answer", toolsUsed: ["same", "same"] } })
  ])("rejects strict-schema violations without repair", async (makeEvent) => {
    const f = await fixture();
    await writeFile(f.file, `${JSON.stringify(makeEvent())}\n`, "utf8");
    expect(await readLocalRunEvidenceStrict({ allowedWorkspaceRealpath: f.workspaceRealpath, reference: f.reference })).toMatchObject({ kind: "invalid" });
  });

  it("bounds projected query and answer by UTF-8 bytes", async () => {
    const f = await fixture();
    await writeFile(f.file, `${JSON.stringify(event(f.runId, { message: "가".repeat(200), response: { response: "나".repeat(400), toolsUsed: [] } }))}\n`, "utf8");
    const result = await readLocalRunEvidenceStrict({ allowedWorkspaceRealpath: f.workspaceRealpath, reference: f.reference });
    expect(result.kind).toBe("available");
    if (result.kind === "available") {
      expect(Buffer.byteLength(result.evidence.query, "utf8")).toBeLessThanOrEqual(240);
      expect(Buffer.byteLength(result.evidence.answerSummary, "utf8")).toBeLessThanOrEqual(600);
      expect(result.evidence.query.endsWith("…")).toBe(true);
    }
  });

  it("accepts the producer's explicit null outcome without widening its type", async () => {
    const f = await fixture();
    await writeFile(f.file, `${JSON.stringify(event(f.runId, { grounded: null, success: false }))}\n`, "utf8");
    const result = await readLocalRunEvidenceStrict({ allowedWorkspaceRealpath: f.workspaceRealpath, reference: f.reference });
    expect(result.kind).toBe("available");
    if (result.kind === "available") expect(result.evidence.outcome).toBeNull();
  });

  it("rejects malformed UTF-8 instead of replacement-decoding evidence", async () => {
    const f = await fixture();
    const raw = Buffer.from(`${JSON.stringify(event(f.runId, { message: "MALFORMED" }))}\n`, "utf8");
    const marker = Buffer.from("MALFORMED", "utf8");
    const markerAt = raw.indexOf(marker);
    expect(markerAt).toBeGreaterThan(0);
    await writeFile(f.file, Buffer.concat([
      raw.subarray(0, markerAt),
      Buffer.from([0xc3, 0x28]),
      raw.subarray(markerAt + marker.byteLength)
    ]));
    expect(await readLocalRunEvidenceStrict({ allowedWorkspaceRealpath: f.workspaceRealpath, reference: f.reference })).toMatchObject({ kind: "invalid" });
  });

  it("enforces line-count and file-size caps", async () => {
    const f = await fixture();
    const line = JSON.stringify(event(f.runId));
    await writeFile(f.file, `${Array.from({ length: 129 }, () => line).join("\n")}\n`, "utf8");
    expect(await readLocalRunEvidenceStrict({ allowedWorkspaceRealpath: f.workspaceRealpath, reference: f.reference })).toMatchObject({ kind: "invalid" });
    await writeFile(f.file, Buffer.alloc(1_048_577, 0x20));
    expect(await readLocalRunEvidenceStrict({ allowedWorkspaceRealpath: f.workspaceRealpath, reference: f.reference })).toMatchObject({ kind: "invalid" });
  });

  it("enforces the per-line byte cap below the total file cap", async () => {
    const f = await fixture();
    const response = { padding: "x".repeat(270_000), response: "answer", toolsUsed: [] };
    const line = JSON.stringify(event(f.runId, { response }));
    expect(Buffer.byteLength(line, "utf8")).toBeGreaterThan(262_144);
    expect(Buffer.byteLength(line, "utf8")).toBeLessThan(1_048_576);
    await writeFile(f.file, `${line}\n`, "utf8");
    expect(await readLocalRunEvidenceStrict({ allowedWorkspaceRealpath: f.workspaceRealpath, reference: f.reference })).toMatchObject({ kind: "invalid" });
  });

  it.each([
    Array.from({ length: 33 }, (_, index) => `tool_${index.toString()}`),
    ["x".repeat(97)]
  ])("rejects tool names outside exact count/byte bounds", async (toolsUsed) => {
    const f = await fixture();
    await writeFile(f.file, `${JSON.stringify(event(f.runId, { response: { response: "answer", toolsUsed } }))}\n`, "utf8");
    expect(await readLocalRunEvidenceStrict({ allowedWorkspaceRealpath: f.workspaceRealpath, reference: f.reference })).toMatchObject({ kind: "invalid" });
  });
});
