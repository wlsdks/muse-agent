import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

let dir: string;
let notesDir: string;
let patternsFiredFile: string;
const NOW = new Date(2026, 4, 12, 21, 30, 0); // Tuesday 21:30 — the fire slot

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-pattern-compose-"));
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

describe("runDuePatternNotices — composeSuggestion (LLM synthesis, fail-soft fallback)", () => {
  it("sends the COMPOSED suggestion when the composer returns one", async () => {
    const sent: OutboundMessage[] = [];
    const summary = await runDuePatternNotices({
      composeSuggestion: async () => "화요일 밤마다 일지를 쓰시던데, 지금 템플릿 열어둘까요?",
      destination: "555",
      now: () => NOW,
      patternsFiredFile,
      providerId: "telegram",
      registry: new MessagingProviderRegistry([capturingProvider(sent)]),
      signals: { notesDir, now: () => NOW.getTime() }
    });
    expect(summary.delivered).toBe(1);
    expect(sent[0]!.text).toBe("화요일 밤마다 일지를 쓰시던데, 지금 템플릿 열어둘까요?");
  });

  it("falls back to the detector's verbatim suggestion when the composer declines (undefined)", async () => {
    const sent: OutboundMessage[] = [];
    const summary = await runDuePatternNotices({
      composeSuggestion: async () => undefined,
      destination: "555",
      now: () => NOW,
      patternsFiredFile,
      providerId: "telegram",
      registry: new MessagingProviderRegistry([capturingProvider(sent)]),
      signals: { notesDir, now: () => NOW.getTime() }
    });
    expect(summary.delivered).toBe(1);
    expect(sent[0]!.text.length).toBeGreaterThan(0); // the verbatim match.suggestion, not empty
  });
});
