import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createNodeBackgroundSpawner } from "../src/index.js";

function tmpLog(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-nodespawn-")), "out.log");
}

const exitPromise = (child: { onExit(l: (c: number | null) => void): void }): Promise<number | null> =>
  new Promise((resolve) => child.onExit(resolve));

describe.skipIf(process.platform === "win32")("createNodeBackgroundSpawner (X-3 slice 4 — real detached spawn)", () => {
  it("spawns a real process, returns a pid, and fires onExit with the code", async () => {
    const spawner = createNodeBackgroundSpawner();
    const child = spawner.spawn(`"${process.execPath}" -e "process.exit(0)"`, { logFile: tmpLog() });
    expect(typeof child.pid).toBe("number");
    expect(child.pid).toBeGreaterThan(0);
    expect(await exitPromise(child)).toBe(0);
  });

  it("propagates a non-zero exit code", async () => {
    const spawner = createNodeBackgroundSpawner();
    const child = spawner.spawn(`"${process.execPath}" -e "process.exit(3)"`, { logFile: tmpLog() });
    expect(await exitPromise(child)).toBe(3);
  });

  it("captures the process output to the log file", async () => {
    const spawner = createNodeBackgroundSpawner();
    const logFile = tmpLog();
    const child = spawner.spawn(`"${process.execPath}" -e "process.stdout.write('hello-bg')"`, { logFile });
    await exitPromise(child);
    expect(readFileSync(logFile, "utf8")).toContain("hello-bg");
  });
});
