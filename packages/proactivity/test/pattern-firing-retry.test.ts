import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderError, MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runDuePatternNotices } from "../src/pattern-firing-loop.js";

// Fails transiently (retryable 503) on its first N sends, then succeeds —
// proving the pattern notice retries inline instead of waiting a whole
// daemon tick (or being dropped).
function flakyProvider(failures: number, sent: OutboundMessage[]): MessagingProvider {
  let calls = 0;
  return {
    describe: () => ({ description: "t", displayName: "T", id: "telegram" }),
    id: "telegram",
    async send(message: OutboundMessage): Promise<OutboundReceipt> {
      calls += 1;
      if (calls <= failures) {
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

describe("runDuePatternNotices — proactive pattern notice survives a transient messaging blip (P19)", () => {
  it("a fireable pattern whose send 503s once is still delivered and recorded fired", async () => {
    const sent: OutboundMessage[] = [];
    const summary = await runDuePatternNotices({
      destination: "555",
      now: () => NOW,
      patternsFiredFile,
      providerId: "telegram",
      registry: new MessagingProviderRegistry([flakyProvider(1, sent)]), // first send 503s, retry succeeds
      signals: { notesDir, now: () => NOW.getTime() }
    });
    expect(summary.fireable).toBeGreaterThan(0);
    expect(summary.delivered).toBe(1);
    expect(summary.errors).toEqual([]);
    expect(sent).toHaveLength(1);
  });
});
