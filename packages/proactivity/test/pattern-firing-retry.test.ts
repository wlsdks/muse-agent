import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderError, MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { readPatternsFired } from "@muse/stores";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runDuePatternNotices } from "../src/pattern-firing-loop.js";

// A transient-looking provider failure is still delivery-ambiguous. Durable
// slot dispatch therefore makes one call and seals unknown instead of risking
// an inline duplicate.
function flakyProvider(failures: number, sent: OutboundMessage[], counts: { calls: number }): MessagingProvider {
  return {
    describe: () => ({ description: "t", displayName: "T", id: "telegram" }),
    id: "telegram",
    async send(message: OutboundMessage): Promise<OutboundReceipt> {
      counts.calls += 1;
      if (counts.calls <= failures) {
        throw new MessagingProviderError("telegram", "UPSTREAM_FAILED", "transient 503", 503);
      }
      sent.push(message);
      return { destination: message.destination, messageId: "m1", providerId: "telegram" };
    }
  };
}

let dir: string;
let notesDir: string;
let patternsFiredFile: string;
// A Tuesday 21:30 — the "now" slot the journal pattern fires in.
const NOW = new Date(2026, 4, 12, 21, 30, 0);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-pattern-retry-"));
  notesDir = join(dir, "notes");
  patternsFiredFile = join(dir, "patterns-fired.json");
  await mkdir(join(notesDir, "journal"), { recursive: true });
  // Five prior Tuesdays at 21:30, all under journal/ — a strong weekly pattern.
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

describe("runDuePatternNotices — transient messaging failures are delivery-ambiguous", () => {
  it("a fireable pattern whose send 503s is attempted once, sealed unknown, and not cooled down", async () => {
    const sent: OutboundMessage[] = [];
    const counts = { calls: 0 };
    const summary = await runDuePatternNotices({
      destination: "555",
      now: () => NOW,
      patternsFiredFile,
      providerId: "telegram",
      registry: new MessagingProviderRegistry([flakyProvider(1, sent, counts)]),
      signals: { notesDir, now: () => NOW.getTime() }
    });
    expect(summary.fireable).toBeGreaterThan(0);
    expect(summary.delivered).toBe(0);
    expect(summary.errors.join("\n")).toContain("delivery is unknown");
    expect(counts.calls).toBe(1);
    expect(sent).toHaveLength(0);
    expect(await readPatternsFired(patternsFiredFile)).toEqual([]);
  });
});
