/**
 * Assembled-path: captureEndOfSessionEpisode (the production episode write seam)
 * refuses to store an ERROR-PRONE session (selective addition, arXiv:2505.16067).
 * Drives the real function via its test seams (readEnv/readLines/readBoundaries/
 * episodesFile) with no Ollama — a throwing summariser falls back to the peak-end
 * digest, so the control session is genuinely captured.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { SessionTurnLine } from "@muse/agent-core";
import { captureEndOfSessionEpisode } from "../src/chat-end-session.js";

const NOW = new Date("2026-06-14T12:00:00.000Z");

// Summariser always throws → summariseSession returns undefined → captureEnd…
// uses the deterministic peak-end digest (grounded by construction). This isolates
// the admission gate as the ONLY thing that can skip a multi-turn session.
const throwingProvider = { generate: async () => { throw new Error("no summariser in test"); } } as never;

function opts(turns: readonly SessionTurnLine[]) {
  const dir = mkdtempSync(join(tmpdir(), "muse-admission-"));
  return {
    episodesFile: join(dir, "episodes.json"),
    model: "m",
    modelProvider: throwingProvider,
    now: () => NOW,
    readBoundaries: async () => [{ tsIso: "2026-06-14T11:00:00.000Z", userId: "u" }],
    readEnv: () => ({ MUSE_EPISODIC_MEMORY_ENABLED: "true" }) as NodeJS.ProcessEnv,
    readLines: async () => turns,
    userId: "u"
  };
}

const errorProne: SessionTurnLine[] = [
  { content: "what's the capital of Australia?", role: "user" },
  { content: "Sydney.", role: "assistant" },
  { content: "no, that's wrong — it's Canberra", role: "user" }
];
const quality: SessionTurnLine[] = [
  { content: "summarise the plan for me", role: "user" },
  { content: "Here is the plan: ship Friday.", role: "assistant" },
  { content: "perfect, thanks!", role: "user" }
];

describe("captureEndOfSessionEpisode — outcome-quality write-admission", () => {
  it("DROPS an error-prone session's episode (not admitted)", async () => {
    const result = await captureEndOfSessionEpisode(opts(errorProne));
    expect(result.status).toBe("skipped");
    expect(result.status === "skipped" && result.reason).toContain("error-prone");
  });

  it("CAPTURES an approved session (admission passes, peak-end digest persists)", async () => {
    const result = await captureEndOfSessionEpisode(opts(quality));
    // The gate let it through — it reaches the (peak-end) capture, not the
    // error-prone skip. Neutralizing the gate would make the error-prone case
    // ALSO reach here (the revert-proof).
    expect(result.status).toBe("captured");
  });
});
