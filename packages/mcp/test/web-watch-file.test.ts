import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createFileSnapshot, createWebWatchRunner, webWatchesFromConfig, type ProactiveNoticeSink } from "@muse/proactivity";

function tmpFile(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "muse-filewatch-"));
  const path = join(dir, name);
  writeFileSync(path, body, "utf8");
  return path;
}

describe("createFileSnapshot", () => {
  it("returns the file's text, or undefined when missing", async () => {
    const path = tmpFile("log.txt", "all good\n");
    expect(await createFileSnapshot(path)()).toBe("all good\n");
    expect(await createFileSnapshot(join(tmpdir(), "muse-does-not-exist-xyz.txt"))()).toBeUndefined();
  });
});

describe("webWatchesFromConfig — file source", () => {
  it("builds a file watch from { source: 'file', path } and snapshots that file", async () => {
    const path = tmpFile("app.log", "INFO booted");
    const watches = webWatchesFromConfig(
      JSON.stringify([{ id: "f1", source: "file", path, message: "New ERROR", rule: { appears: "ERROR" }, title: "App log" }])
    );
    expect(watches).toHaveLength(1);
    expect(await watches[0]!.snapshot()).toBe("INFO booted");
  });

  it("drops a file entry missing its path", () => {
    const watches = webWatchesFromConfig(
      JSON.stringify([{ id: "bad", source: "file", message: "m", rule: { appears: "x" }, title: "t" }])
    );
    expect(watches).toEqual([]);
  });

  it("fires a proactive notice when the watched file newly contains the term", async () => {
    const path = tmpFile("watch.log", "starting up");
    const [watch] = webWatchesFromConfig(
      JSON.stringify([{ id: "errwatch", source: "file", path, message: "ERROR in watch.log", rule: { appears: "ERROR" }, title: "Errors" }])
    );
    const delivered: string[] = [];
    const sink: ProactiveNoticeSink = { deliver: async (n) => { delivered.push(n.text); } };
    const runner = createWebWatchRunner({ sink, watches: [watch!] });

    await runner.tick(); // baseline: no ERROR yet
    expect(delivered).toEqual([]);
    writeFileSync(path, "starting up\nERROR: disk full", "utf8");
    await runner.tick(); // ERROR newly appeared
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("ERROR in watch.log");
  });
});
