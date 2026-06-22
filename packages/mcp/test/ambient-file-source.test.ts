import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileAmbientSignalSource, parseAmbientNoticeRules, runAmbientNoticeTick, type ProactiveNoticeSink } from "@muse/proactivity";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-ambient-"));
  file = join(dir, "ambient.json");
});
afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("FileAmbientSignalSource", () => {
  it("reads string fields from the ambient JSON file", async () => {
    await writeFile(file, JSON.stringify({ app: "Calendar", clipboard: 12345, window: "Team Standup — 14:00" }), "utf8");
    const signal = await new FileAmbientSignalSource(file).snapshot();
    expect(signal).toEqual({ app: "Calendar", window: "Team Standup — 14:00" }); // non-string clipboard dropped
  });

  it("fail-open: missing file / malformed JSON / empty object → undefined", async () => {
    expect(await new FileAmbientSignalSource(join(dir, "nope.json")).snapshot()).toBeUndefined();
    await writeFile(file, "{ not json", "utf8");
    expect(await new FileAmbientSignalSource(file).snapshot()).toBeUndefined();
    await writeFile(file, JSON.stringify({ app: "" }), "utf8");
    expect(await new FileAmbientSignalSource(file).snapshot()).toBeUndefined();
  });
});

describe("parseAmbientNoticeRules", () => {
  it("parses valid rules and drops invalid / pattern-less ones", () => {
    const rules = parseAmbientNoticeRules(JSON.stringify([
      { id: "standup", match: { window: "standup" }, message: "Open notes.", title: "Standup" },
      { id: "bad-no-match", match: {}, message: "x", title: "x" },
      { id: "", match: { app: "x" }, message: "x", title: "x" },
      { match: { app: "x" }, message: "x", title: "x" }
    ]));
    expect(rules).toHaveLength(1);
    expect(rules[0]!.id).toBe("standup");
  });

  it("fail-open: malformed JSON / non-array → []", () => {
    expect(parseAmbientNoticeRules("{ not json")).toEqual([]);
    expect(parseAmbientNoticeRules(JSON.stringify({ not: "an array" }))).toEqual([]);
  });
});

describe("file-driven ambient perception end-to-end", () => {
  it("a real ambient file drives a proactive notice through the sink", async () => {
    await writeFile(file, JSON.stringify({ app: "Calendar", window: "Team Standup — 14:00" }), "utf8");
    const rules = parseAmbientNoticeRules(JSON.stringify([
      { id: "standup", match: { window: "standup" }, message: "Standup at 14:00 — open your notes.", title: "Standup" }
    ]));
    const delivered: { text: string; title: string; kind: string }[] = [];
    const sink: ProactiveNoticeSink = { deliver: (notice) => { delivered.push(notice); } };

    const summary = await runAmbientNoticeTick({ rules, sink, source: new FileAmbientSignalSource(file) });

    expect(summary.delivered).toBe(1);
    expect(delivered[0]!.text).toContain("Standup at 14:00");
  });
});
