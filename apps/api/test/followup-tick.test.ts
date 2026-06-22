import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MessagingProviderRegistry } from "@muse/messaging";
import type { ProactiveModelProviderLike } from "@muse/proactivity";
import { describe, expect, it } from "vitest";

import { startFollowupTick } from "../src/followup-tick.js";

interface MessageSent {
  readonly providerId: string;
  readonly destination: string;
  readonly text: string;
}

function fakeRegistry(sent: MessageSent[]): MessagingProviderRegistry {
  return {
    send: async (providerId: string, message: { destination: string; text: string }) => {
      sent.push({ destination: message.destination, providerId, text: message.text });
      return { destination: message.destination, messageId: "stub", providerId };
    }
  } as unknown as MessagingProviderRegistry;
}

function staticModelProvider(text: string): ProactiveModelProviderLike {
  return { generate: async () => ({ output: text }) };
}

function seedDueFollowup(file: string): void {
  writeFileSync(file, JSON.stringify({
    followups: [{
      createdAt: "2026-05-10T00:00:00Z",
      id: "fu_overdue",
      scheduledFor: "2026-05-11T07:30:00Z",
      status: "scheduled",
      summary: "Check on the Q3 budget memo",
      userId: "stark"
    }]
  }), "utf8");
}

describe("startFollowupTick", () => {
  it("tickOnce synthesizes, delivers, and marks fired", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-followup-tick-"));
    const file = join(dir, "followups.json");
    seedDueFollowup(file);
    const sent: MessageSent[] = [];
    const handle = startFollowupTick({
      destination: "@me",
      followupsFile: file,
      model: "gemini-2.0-flash",
      modelProvider: staticModelProvider("Quick check on the Q3 budget memo — any blockers?"),
      now: () => new Date("2026-05-11T08:00:00Z"),
      providerId: "telegram",
      registry: fakeRegistry(sent)
    });
    try {
      await handle.tickOnce();
      expect(sent).toEqual([{
        destination: "@me",
        providerId: "telegram",
        text: "Quick check on the Q3 budget memo — any blockers?"
      }]);
      const after = JSON.parse(readFileSync(file, "utf8")) as {
        followups: Array<{ id: string; status: string }>;
      };
      expect(after.followups[0]?.status).toBe("fired");
      // Second tick is a no-op.
      await handle.tickOnce();
      expect(sent).toHaveLength(1);
    } finally {
      handle.stop();
    }
  });

  it("skips firing inside the quiet-hour window", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-followup-quiet-"));
    const file = join(dir, "followups.json");
    seedDueFollowup(file);
    const sent: MessageSent[] = [];
    let modelCalls = 0;
    const handle = startFollowupTick({
      destination: "@me",
      followupsFile: file,
      model: "gemini-2.0-flash",
      modelProvider: {
        generate: async () => {
          modelCalls += 1;
          return { output: "Should not be sent." };
        }
      },
      // 02:00 local time falls inside 23-7 quiet window.
      now: () => new Date(2026, 4, 11, 2, 0, 0),
      providerId: "telegram",
      quietHours: { endHour: 7, startHour: 23 },
      registry: fakeRegistry(sent)
    });
    try {
      await handle.tickOnce();
      expect(modelCalls).toBe(0);
      expect(sent).toEqual([]);
      const after = JSON.parse(readFileSync(file, "utf8")) as {
        followups: Array<{ id: string; status: string }>;
      };
      expect(after.followups[0]?.status).toBe("scheduled");
    } finally {
      handle.stop();
    }
  });

  it("single-flight: a slow synth+send doesn't get double-entered by an overlapping tick", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-followup-flight-"));
    const file = join(dir, "followups.json");
    seedDueFollowup(file);
    let modelCalls = 0;
    const handle = startFollowupTick({
      destination: "@me",
      followupsFile: file,
      model: "gemini-2.0-flash",
      modelProvider: {
        generate: async () => {
          modelCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { output: "Following up." };
        }
      },
      now: () => new Date("2026-05-11T08:00:00Z"),
      providerId: "telegram",
      registry: fakeRegistry([])
    });
    try {
      const a = handle.tickOnce();
      const b = handle.tickOnce(); // should be skipped by single-flight
      await Promise.all([a, b]);
      expect(modelCalls).toBe(1);
    } finally {
      handle.stop();
    }
  });

  it("logger / errorLogger receive a summary line on firing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-followup-log-"));
    const file = join(dir, "followups.json");
    seedDueFollowup(file);
    const lines: string[] = [];
    const errs: string[] = [];
    const handle = startFollowupTick({
      destination: "@me",
      errorLogger: (message) => errs.push(message),
      followupsFile: file,
      logger: (message) => lines.push(message),
      model: "gemini-2.0-flash",
      modelProvider: staticModelProvider("Following up."),
      now: () => new Date("2026-05-11T08:00:00Z"),
      providerId: "telegram",
      registry: fakeRegistry([])
    });
    try {
      await handle.tickOnce();
      expect(lines.some((l) => l.includes("followup-tick: fired 1 of 1"))).toBe(true);
      expect(errs).toEqual([]);
    } finally {
      handle.stop();
    }
  });
});
