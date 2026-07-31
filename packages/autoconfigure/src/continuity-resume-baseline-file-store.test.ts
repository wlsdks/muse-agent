import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  ContinuityResumeRuntimeBaselineV1
} from "@muse/attunegraph/continuity-resume-runtime";

vi.mock("@muse/attunegraph/continuity-resume-runtime", () => ({
  verifyContinuityResumeRuntimeBaseline: (value: unknown) => {
    if (
      typeof value !== "object"
      || value === null
      || Array.isArray(value)
      || Object.keys(value).sort().join(",")
        !== [
          "baselineVersion",
          "boundary",
          "graphObservationReceipt",
          "schemaVersion",
          "scope",
          "sourceObservationReceipt"
        ].sort().join(",")
    ) {
      throw new Error("invalid baseline");
    }
    const record = value as Record<string, unknown>;
    const boundary = record.boundary;
    const scope = record.scope;
    if (
      record.schemaVersion !== 1
      || record.baselineVersion !== "muse.continuity-resume-baseline.v1"
      || typeof boundary !== "object"
      || boundary === null
      || Array.isArray(boundary)
      || typeof scope !== "object"
      || scope === null
      || Array.isArray(scope)
    ) {
      throw new Error("invalid baseline");
    }
    const boundaryRecord = boundary as Record<string, unknown>;
    const sourceReceipt = record.sourceObservationReceipt;
    const graphReceipt = record.graphObservationReceipt;
    if (
      typeof boundaryRecord.boundaryId !== "string"
      || typeof (scope as Record<string, unknown>).sourceId !== "string"
      || typeof (scope as Record<string, unknown>).threadId !== "string"
      || typeof sourceReceipt !== "object"
      || sourceReceipt === null
      || Array.isArray(sourceReceipt)
      || Object.keys(sourceReceipt).join(",") !== "receipt"
      || typeof (sourceReceipt as Record<string, unknown>).receipt !== "string"
      || typeof graphReceipt !== "object"
      || graphReceipt === null
      || Array.isArray(graphReceipt)
      || Object.keys(graphReceipt).join(",") !== "receipt"
      || typeof (graphReceipt as Record<string, unknown>).receipt !== "string"
    ) {
      throw new Error("invalid baseline");
    }
    return value;
  }
}));

import {
  ContinuityResumeBaselineFileStore,
  ContinuityResumeBaselineFileStoreUnavailableError
} from "./continuity-resume-baseline-file-store.js";

const scope = (index: number) => ({
  sourceId: "source:local",
  threadId: `thread:${index.toString()}`
});

function baseline(index: number, boundary = 1): ContinuityResumeRuntimeBaselineV1 {
  return {
    schemaVersion: 1,
    baselineVersion: "muse.continuity-resume-baseline.v1",
    scope: scope(index),
    boundary: {
      scope: scope(index),
      boundaryId: `crb_v1_${boundary.toString().padStart(64, "0")}`
    },
    sourceObservationReceipt: { receipt: `source-${index.toString()}` },
    graphObservationReceipt: { receipt: `graph-${index.toString()}` }
  } as unknown as ContinuityResumeRuntimeBaselineV1;
}

async function tempFile(): Promise<string> {
  return join(
    await mkdtemp(join(tmpdir(), "muse-resume-baselines-")),
    "baselines.json"
  );
}

describe("ContinuityResumeBaselineFileStore", () => {
  it("stores and loads a baseline through owner-private exact-schema bytes", async () => {
    const file = await tempFile();
    const store = new ContinuityResumeBaselineFileStore(file);
    await expect(
      store.compareAndSet(scope(1), undefined, baseline(1))
    ).resolves.toBe("stored");
    await expect(store.load(scope(1))).resolves.toEqual(baseline(1));
    if (process.platform !== "win32") {
      expect((await lstat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it("returns unchanged without rewriting bytes or refreshing retention order", async () => {
    const file = await tempFile();
    const store = new ContinuityResumeBaselineFileStore(file);
    await store.compareAndSet(scope(1), undefined, baseline(1));
    await store.compareAndSet(scope(2), undefined, baseline(2));
    const before = await readFile(file);
    await expect(
      store.compareAndSet(
        scope(1),
        baseline(1).boundary.boundaryId,
        baseline(1)
      )
    ).resolves.toBe("unchanged");
    expect(await readFile(file)).toEqual(before);
  });

  it("preserves unrelated scopes and deterministically conflicts across instances", async () => {
    const file = await tempFile();
    const first = new ContinuityResumeBaselineFileStore(file);
    const second = new ContinuityResumeBaselineFileStore(file);
    await first.compareAndSet(scope(1), undefined, baseline(1));
    await first.compareAndSet(scope(2), undefined, baseline(2));
    const before = await readFile(file);
    await expect(
      second.compareAndSet(scope(1), undefined, baseline(1, 2))
    ).resolves.toBe("conflict");
    expect(await readFile(file)).toEqual(before);
    await expect(second.load(scope(2))).resolves.toEqual(baseline(2));
  });

  it("keeps at most 16 baselines in oldest-to-newest retention order", async () => {
    const file = await tempFile();
    const store = new ContinuityResumeBaselineFileStore(file);
    for (let index = 0; index < 17; index += 1) {
      await store.compareAndSet(scope(index), undefined, baseline(index));
    }
    await expect(store.load(scope(0))).resolves.toBeUndefined();
    await expect(store.load(scope(16))).resolves.toEqual(baseline(16));
    const envelope = JSON.parse(await readFile(file, "utf8")) as {
      baselines: Array<{ boundary: { scope: { threadId: string } } }>;
    };
    expect(envelope.baselines).toHaveLength(16);
    expect(envelope.baselines[0]!.boundary.scope.threadId).toBe("thread:1");
    expect(envelope.baselines[15]!.boundary.scope.threadId).toBe("thread:16");
  });

  it("refuses malformed, unknown-field, duplicate-scope, and oversized state without repair", async () => {
    const cases = [
      "{\"schemaVersion\":1",
      JSON.stringify({ schemaVersion: 1, baselines: [], unknown: true }),
      JSON.stringify({
        schemaVersion: 1,
        baselines: [baseline(1), baseline(1)]
      }),
      JSON.stringify({
        schemaVersion: 1,
        baselines: [{
          ...baseline(1),
          sourceObservationReceipt: { invalid: true }
        }]
      }),
      "x".repeat(8 * 1024 * 1024 + 1)
    ];
    for (const contents of cases) {
      const file = await tempFile();
      await writeFile(file, contents, { mode: 0o600 });
      await chmod(file, 0o600);
      const before = await readFile(file);
      const store = new ContinuityResumeBaselineFileStore(file);
      await expect(store.load(scope(1))).rejects.toBeInstanceOf(
        ContinuityResumeBaselineFileStoreUnavailableError
      );
      await expect(
        store.compareAndSet(scope(1), undefined, baseline(1))
      ).rejects.toBeInstanceOf(
        ContinuityResumeBaselineFileStoreUnavailableError
      );
      expect(await readFile(file)).toEqual(before);
    }
  }, 45_000);

  it("refuses non-private, symlink, and multi-link state without modifying it", async () => {
    if (process.platform === "win32") return;
    const privateTarget = await tempFile();
    await writeFile(
      privateTarget,
      JSON.stringify({ schemaVersion: 1, baselines: [] }),
      { mode: 0o600 }
    );

    const nonPrivate = await tempFile();
    await writeFile(
      nonPrivate,
      JSON.stringify({ schemaVersion: 1, baselines: [] }),
      { mode: 0o644 }
    );
    await chmod(nonPrivate, 0o644);

    const symlinkFile = await tempFile();
    await symlink(privateTarget, symlinkFile);

    const hardLinkFile = await tempFile();
    await link(privateTarget, hardLinkFile);

    for (const file of [nonPrivate, symlinkFile, hardLinkFile]) {
      const store = new ContinuityResumeBaselineFileStore(file);
      await expect(store.load(scope(1))).rejects.toBeInstanceOf(
        ContinuityResumeBaselineFileStoreUnavailableError
      );
    }
  });

  it("rejects paths that are not absolute, normalized, and NUL-free", () => {
    for (const file of [
      "relative.json",
      "/tmp/../tmp/baselines.json",
      "/tmp/baselines.json\0suffix"
    ]) {
      expect(() => new ContinuityResumeBaselineFileStore(file)).toThrow(
        ContinuityResumeBaselineFileStoreUnavailableError
      );
    }
  });
});
