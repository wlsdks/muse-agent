import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readActionLog } from "@muse/stores";
import { describe, expect, it, vi } from "vitest";

import { createChannelRefusalRecorder } from "../src/channel-refusal-recorder.js";

function logFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-chan-refusal-")), "action-log.json");
}

describe("createChannelRefusalRecorder", () => {
  it("appends a `refused` action-log entry the user can review via `muse actions`", async () => {
    const file = logFile();
    const record = createChannelRefusalRecorder({
      actionLogFile: file,
      now: () => new Date("2026-05-22T03:00:00.000Z"),
      providerId: "telegram",
      source: "42"
    });

    await record({ arguments: { subject: "Q3", to: "bob@example.com" }, draft: 'to bob@example.com, subject "Q3"', risk: "execute", tool: "email_send", userId: "telegram:42" });

    const entries = await readActionLog(file);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.result).toBe("refused");
    expect(entry.userId).toBe("telegram:42");
    expect(entry.what).toContain("email_send");
    expect(entry.what).toContain('to bob@example.com, subject "Q3"');
    expect(entry.why).toContain("fail-closed gate refused");
    expect(entry.when).toBe("2026-05-22T03:00:00.000Z");
  });

  it("falls back to providerId:source as the userId when the refusal omits one", async () => {
    const file = logFile();
    const record = createChannelRefusalRecorder({ actionLogFile: file, providerId: "discord", source: "chan-9" });
    await record({ arguments: { url: "http://x.test/book" }, draft: "POST http://x.test/book", risk: "execute", tool: "web_action" });
    const entries = await readActionLog(file);
    expect(entries[0]!.userId).toBe("discord:chan-9");
  });

  it("delegates to the injected append fn with the resolved file", async () => {
    const append = vi.fn(async () => {});
    const record = createChannelRefusalRecorder({ actionLogFile: "/tmp/x.json", appendActionLog: append, providerId: "telegram", source: "1" });
    await record({ arguments: {}, draft: "", risk: "write", tool: "muse.notes.save" });
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]![0]).toBe("/tmp/x.json");
    expect(append.mock.calls[0]![1]).toMatchObject({ result: "refused", what: 'Muse wanted to run "muse.notes.save" (write)' });
  });
});
