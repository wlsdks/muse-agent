import { mkdtemp, mkdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, readOutboundEffects } from "@muse/messaging";
import { describe, expect, it } from "vitest";

import { startPatternTick } from "./pattern-tick.js";

describe("startPatternTick", () => {
  it("forwards the canonical effect ledger for one accepted natural slot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-api-pattern-tick-"));
    const notesDir = join(dir, "notes");
    const patternsFiredFile = join(dir, "patterns-fired.json");
    const effectFile = join(dir, "outbound-effects.json");
    const now = new Date(2026, 4, 12, 21, 30, 0);
    await mkdir(join(notesDir, "journal"), { recursive: true });
    for (let k = 1; k <= 5; k += 1) {
      const file = join(notesDir, "journal", `entry-${k.toString()}.md`);
      await writeFile(file, `journal ${k.toString()}`, "utf8");
      const when = new Date(now.getTime() - k * 7 * 86_400_000);
      await utimes(file, when, when);
    }
    const registry = new MessagingProviderRegistry([{
      describe: () => ({ description: "test", displayName: "Test", id: "telegram" }),
      id: "telegram",
      send: async (message) => ({
        destination: message.destination,
        messageId: "api-pattern-accepted",
        providerId: "telegram"
      })
    }]);
    const handle = startPatternTick({
      destination: "@owner",
      effectFile,
      intervalMs: 60_000,
      notesDir,
      now: () => now,
      patternsFiredFile,
      providerId: "telegram",
      registry
    });
    try {
      await handle.tickOnce();
      expect(await readOutboundEffects(effectFile)).toHaveLength(1);
    } finally {
      handle.stop();
    }
  });
});
