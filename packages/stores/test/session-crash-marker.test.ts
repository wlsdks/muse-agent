import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { detectUncleanShutdown, markSessionCleanExit, markSessionStart } from "../src/index.js";

const dirs: string[] = [];
function tmpMarker(): string {
  const dir = mkdtempSync(join(tmpdir(), "muse-crash-"));
  dirs.push(dir);
  return join(dir, "session.marker");
}
afterEach(async () => { /* temp dirs are OS-cleaned; nothing to assert */ });

describe("session crash marker (SES-3/10)", () => {
  it("reports an unclean shutdown when a start marker survives (no clean exit)", async () => {
    const path = tmpMarker();
    await markSessionStart(path, { pid: 4242, startedAt: "2026-06-24T00:00:00.000Z" });
    const verdict = await detectUncleanShutdown(path);
    expect(verdict).toEqual({ pid: 4242, startedAt: "2026-06-24T00:00:00.000Z" });
  });

  it("reports clean after a clean exit removes the marker", async () => {
    const path = tmpMarker();
    await markSessionStart(path, { pid: 1, startedAt: "2026-06-24T00:00:00.000Z" });
    await markSessionCleanExit(path);
    expect(await detectUncleanShutdown(path)).toBeUndefined();
  });

  it("is clean when no marker has ever been written", async () => {
    expect(await detectUncleanShutdown(tmpMarker())).toBeUndefined();
  });

  it("clean-exit on a missing marker does not throw (idempotent)", async () => {
    await expect(markSessionCleanExit(tmpMarker())).resolves.toBeUndefined();
  });

  it("treats a corrupt marker as no recoverable info", async () => {
    const path = tmpMarker();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, "{not json", "utf8");
    expect(await detectUncleanShutdown(path)).toBeUndefined();
  });

  it.each([
    { pid: -1, startedAt: "2026-06-24T00:00:00.000Z" },
    { pid: 1.5, startedAt: "2026-06-24T00:00:00.000Z" },
    { pid: Number.MAX_SAFE_INTEGER + 1, startedAt: "2026-06-24T00:00:00.000Z" },
    { pid: 42, startedAt: "not-a-timestamp" }
  ])("treats a malformed marker shape as no recoverable info: %o", async (marker) => {
    const path = tmpMarker();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, JSON.stringify(marker), "utf8");

    expect(await detectUncleanShutdown(path)).toBeUndefined();
  });
});
