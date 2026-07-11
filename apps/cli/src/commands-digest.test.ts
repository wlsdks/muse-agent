import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { runDigestFlushIfDue } from "@muse/proactivity";
import { appendDigestItem, markDigestSent, type DigestQueueItem } from "@muse/stores";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { describeNextDigestFlush, registerDigestCommands } from "./commands-digest.js";

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

async function runDigest(args: string[]): Promise<{ readonly error?: string; readonly stdout: string }> {
  const stdout: string[] = [];
  const io = { stderr: () => {}, stdout: (m: string) => stdout.push(m) };
  let error: string | undefined;
  try {
    const program = new Command();
    program.exitOverride();
    registerDigestCommands(program, io);
    await program.parseAsync(["node", "muse", "digest", ...args]);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  return { error, stdout: stdout.join("") };
}

describe("muse digest list", () => {
  const prevQueue = process.env.MUSE_DIGEST_QUEUE_FILE;
  const prevSent = process.env.MUSE_DIGEST_SENT_FILE;
  const prevHour = process.env.MUSE_DIGEST_HOUR;
  let dir: string;
  let queueFile: string;
  let sentFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "muse-digest-cli-"));
    queueFile = join(dir, "digest-queue.json");
    sentFile = join(dir, "digest-sent.json");
    process.env.MUSE_DIGEST_QUEUE_FILE = queueFile;
    process.env.MUSE_DIGEST_SENT_FILE = sentFile;
  });
  afterEach(() => {
    if (prevQueue === undefined) delete process.env.MUSE_DIGEST_QUEUE_FILE; else process.env.MUSE_DIGEST_QUEUE_FILE = prevQueue;
    if (prevSent === undefined) delete process.env.MUSE_DIGEST_SENT_FILE; else process.env.MUSE_DIGEST_SENT_FILE = prevSent;
    if (prevHour === undefined) delete process.env.MUSE_DIGEST_HOUR; else process.env.MUSE_DIGEST_HOUR = prevHour;
  });

  it("empty queue: reports nothing pending + a next-flush hint", async () => {
    const r = await runDigest(["list"]);
    expect(r.error).toBeUndefined();
    expect(r.stdout).toContain("No notices pending.");
    expect(r.stdout).toContain("Next flush:");
  });

  it("empty queue --json: pending:0, items:[]", async () => {
    const r = await runDigest(["list", "--json"]);
    expect(r.error).toBeUndefined();
    const payload = JSON.parse(r.stdout) as { readonly items: readonly DigestQueueItem[]; readonly pending: number };
    expect(payload.pending).toBe(0);
    expect(payload.items).toEqual([]);
  });

  it("lists pending items formatted like the flush lines, with a pending count", async () => {
    await appendDigestItem(queueFile, { at: new Date(2026, 6, 12, 9, 5, 0), source: "pattern-firing", text: "you usually leave by 5pm" });
    await appendDigestItem(queueFile, { at: new Date(2026, 6, 12, 14, 0, 0), source: "ambient-notice", text: "related note found" });
    const r = await runDigest(["list"]);
    expect(r.error).toBeUndefined();
    expect(r.stdout).toContain("· [pattern-firing] 09:05 you usually leave by 5pm");
    expect(r.stdout).toContain("· [ambient-notice] 14:00 related note found");
    expect(r.stdout).toContain("2 pending");
  });

  it("--json returns the raw items + pending count", async () => {
    await appendDigestItem(queueFile, { at: new Date(2026, 6, 12, 9, 5, 0), source: "pattern-firing", text: "notice one" });
    const r = await runDigest(["list", "--json"]);
    const payload = JSON.parse(r.stdout) as { readonly items: readonly DigestQueueItem[]; readonly pending: number };
    expect(payload.pending).toBe(1);
    expect(payload.items[0]).toMatchObject({ source: "pattern-firing", text: "notice one" });
  });

  it("already sent today: next-flush hint pushes to tomorrow", async () => {
    // Pin the digest hour to the CURRENT local hour so "already sent today,
    // still inside/past the digest hour" deterministically resolves to
    // "tomorrow", regardless of when this suite runs.
    const currentHour = new Date().getHours();
    process.env.MUSE_DIGEST_HOUR = currentHour.toString();
    await markDigestSent(sentFile, new Date());
    const r = await runDigest(["list", "--json"]);
    const payload = JSON.parse(r.stdout) as { readonly nextFlush: string };
    expect(payload.nextFlush).toBe(`tomorrow at ${currentHour.toString().padStart(2, "0")}:00 local`);
  });

  it("after an overflow flush, the folded (newest) items are still shown by `muse digest list` — the hint is truthful, nothing was silently lost", async () => {
    const itemCount = 60;
    for (let i = 0; i < itemCount; i += 1) {
      await appendDigestItem(queueFile, {
        at: new Date(2026, 4, 12, 6, i, 0),
        source: "pattern-firing",
        text: `notice number ${i.toString()} with some extra padding text to grow the line past the safe length`
      });
    }
    const sent: OutboundMessage[] = [];
    const summary = await runDigestFlushIfDue({
      destination: "555",
      digestFile: queueFile,
      now: () => new Date(2026, 4, 12, 18, 5, 0),
      providerId: "telegram",
      registry: new MessagingProviderRegistry([capturingProvider(sent)]),
      sentFile
    });
    expect(summary.outcome).toBe("sent");
    expect(sent[0]!.text).toMatch(/· …and \d+ more \(see muse digest\)$/);

    const r = await runDigest(["list", "--json"]);
    const payload = JSON.parse(r.stdout) as { readonly items: readonly DigestQueueItem[]; readonly pending: number };
    // The queue is truthfully non-empty — the folded items were never deleted.
    expect(payload.pending).toBeGreaterThan(0);
    expect(payload.pending).toBeLessThan(itemCount);
  });
});

describe("describeNextDigestFlush — pure hint text", () => {
  it("before the digest hour: today at HH:00", () => {
    expect(describeNextDigestFlush(new Date(2026, 6, 12, 9, 0, 0), 18, false)).toBe("today at 18:00 local");
  });

  it("inside the digest hour, not yet sent: fires any moment", () => {
    expect(describeNextDigestFlush(new Date(2026, 6, 12, 18, 30, 0), 18, false)).toBe("any moment now (in the 18:00 window)");
  });

  it("inside the digest hour but already sent, or past it: tomorrow", () => {
    expect(describeNextDigestFlush(new Date(2026, 6, 12, 18, 30, 0), 18, true)).toBe("tomorrow at 18:00 local");
    expect(describeNextDigestFlush(new Date(2026, 6, 12, 20, 0, 0), 18, false)).toBe("tomorrow at 18:00 local");
  });
});
