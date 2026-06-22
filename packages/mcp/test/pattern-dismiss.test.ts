import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  dismissPattern,
  isPatternDismissed,
  readPatternsFired,
  writePatternsFired
} from "@muse/stores";
import { runDuePatternNotices } from "../src/pattern-firing-loop.js";

function capturingProvider(sent: OutboundMessage[]): MessagingProvider {
  return {
    describe: () => ({ description: "t", displayName: "T", id: "telegram" }),
    id: "telegram",
    async send(message: OutboundMessage): Promise<OutboundReceipt> {
      sent.push(message);
      return { destination: message.destination, messageId: "m1", providerId: "telegram" };
    }
  };
}

describe("patterns-fired store — dismissal (learned avoidance)", () => {
  it("dismissPattern flags it; isPatternDismissed detects it; a plain fire does not", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "muse-dismiss-")), "fired.json");
    await writePatternsFired(file, [{ patternId: "p-fired", firedAtMs: 1000 }]);
    await dismissPattern(file, "p-dismissed", 2000);
    const records = await readPatternsFired(file);
    expect(isPatternDismissed(records, "p-dismissed")).toBe(true);
    expect(isPatternDismissed(records, "p-fired")).toBe(false);
  });
});

describe("runDuePatternNotices — a dismissed pattern never re-fires", () => {
  let dir: string;
  let notesDir: string;
  let patternsFiredFile: string;
  const NOW = new Date(2026, 4, 12, 21, 30, 0); // Tuesday 21:30 — fire slot

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-pattern-dismiss-"));
    notesDir = join(dir, "notes");
    patternsFiredFile = join(dir, "patterns-fired.json");
    await mkdir(join(notesDir, "journal"), { recursive: true });
    for (let k = 1; k <= 5; k += 1) {
      const file = join(notesDir, "journal", `entry-${k.toString()}.md`);
      await writeFile(file, `journal ${k.toString()}`, "utf8");
      const when = new Date(NOW.getTime() - k * 7 * 86_400_000);
      await utimes(file, when, when);
    }
  });
  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  it("fires once, then stays silent after the pattern is dismissed (even with cooldown cleared)", async () => {
    const sent: OutboundMessage[] = [];
    const opts = {
      destination: "555",
      now: () => NOW,
      patternsFiredFile,
      providerId: "telegram",
      registry: new MessagingProviderRegistry([capturingProvider(sent)]),
      signals: { notesDir, now: () => NOW.getTime() }
    };
    const first = await runDuePatternNotices(opts);
    expect(first.delivered).toBe(1);
    const pid = first.fired[0]!.id;

    // Dismiss it AND clear the cooldown record, so only the dismissal can
    // suppress the re-fire (isolates learned-avoidance from cooldown).
    await writePatternsFired(patternsFiredFile, [{ patternId: pid, firedAtMs: 0, dismissed: true }]);

    const second = await runDuePatternNotices(opts);
    expect(second.delivered).toBe(0);
    expect(sent).toHaveLength(1); // still just the first
  });
});
