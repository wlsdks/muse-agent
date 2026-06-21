/**
 * Assembled-path: captureEndOfSessionEpisode (the production episode write seam)
 * declines to store a low-salience session — one whose summary is content-thin AND
 * the model self-rated trivial (importance 1) — so idle chatter never becomes a
 * citable [session: …] source that dilutes recall (SSGM, arXiv:2603.11768). A stub
 * summariser returns the parsed {summary, topics, importance}; no Ollama.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { SessionTurnLine } from "@muse/agent-core";
import { captureEndOfSessionEpisode } from "../src/chat-end-session.js";

const NOW = new Date("2026-06-14T12:00:00.000Z");

// Stub summariser returns a fixed parsed payload (summary / topics / importance).
const provider = (output: string) => ({ generate: async () => ({ id: "r", model: "m", output }) }) as never;

function opts(turns: readonly SessionTurnLine[], output: string) {
  const dir = mkdtempSync(join(tmpdir(), "muse-salience-"));
  const episodesFile = join(dir, "episodes.json");
  return {
    episodesFile,
    model: "m",
    modelProvider: provider(output),
    now: () => NOW,
    readBoundaries: async () => [{ tsIso: "2026-06-14T11:00:00.000Z", userId: "u" }],
    readEnv: () => ({ MUSE_EPISODIC_MEMORY_ENABLED: "true" }) as NodeJS.ProcessEnv,
    readLines: async () => turns,
    userId: "u"
  };
}

// Greeting-only session (no corrections → passes the fire-35 admission gate). The
// summary tokens appear in the transcript so the grounding gate passes — isolating
// the salience gate as the only thing that can skip it.
const idle: SessionTurnLine[] = [
  { content: "hey", role: "user" },
  { content: "hi there", role: "assistant" },
  { content: "bye now", role: "user" }
];
const idleSummary = "hey bye now\ntopics:\nimportance: 1"; // thin + self-rated trivial

const rich: SessionTurnLine[] = [
  { content: "summarise the plan", role: "user" },
  { content: "shipped the Q3 budget review Friday using bullet points and assigned owners", role: "assistant" },
  { content: "great", role: "user" }
];
const richSummary = "shipped the Q3 budget review Friday using bullet points and assigned owners\ntopics: planning\nimportance: 1";

describe("captureEndOfSessionEpisode — episode-write salience admission (SSGM arXiv:2603.11768)", () => {
  it("SKIPS a content-thin, self-rated-trivial session (not persisted)", async () => {
    const o = opts(idle, idleSummary);
    const result = await captureEndOfSessionEpisode(o);
    expect(result.status).toBe("skipped");
    expect(result.status === "skipped" && result.reason).toContain("low-salience");
    // Terminal store state: nothing written.
    let stored: string;
    try { stored = readFileSync(o.episodesFile, "utf8"); } catch { stored = ""; }
    expect(stored).not.toContain("hey bye now");
  });

  it("CAPTURES a content-rich session even at importance 1 (thinness AND triviality both required)", async () => {
    const result = await captureEndOfSessionEpisode(opts(rich, richSummary));
    expect(result.status).toBe("captured"); // rich summary → retained despite importance 1
  });
});

describe("captureEndOfSessionEpisode — episode-provenance trust bit (episode-laundering defense, MemoryGraft arXiv:2512.16962)", () => {
  it("marks the episode trusted:false when the session rested on untrusted sources", async () => {
    const result = await captureEndOfSessionEpisode({ ...opts(rich, richSummary), untrustedSession: true });
    expect(result.status).toBe("captured");
    expect(result.status === "captured" && result.episode.trusted).toBe(false);
  });

  it("leaves the trust bit ABSENT for a clean session (no over-marking the user's own history)", async () => {
    const result = await captureEndOfSessionEpisode({ ...opts(rich, richSummary), untrustedSession: false });
    expect(result.status).toBe("captured");
    expect(result.status === "captured" && result.episode.trusted).toBeUndefined();
  });

  it("marks trusted:false from a PERSISTED per-turn flag even without the in-memory option (EP-1b: one-shot/resumed turns from a prior process)", async () => {
    // The assistant turn carries untrustedOnly (as persisted to last-chat.jsonl by a
    // one-shot `muse chat` or a prior Ink process) — NO untrustedSession option here.
    const richUntrusted: SessionTurnLine[] = [
      { content: "summarise the plan", role: "user" },
      { content: "shipped the Q3 budget review Friday using bullet points and assigned owners", role: "assistant", untrustedOnly: true },
      { content: "great", role: "user" }
    ];
    const result = await captureEndOfSessionEpisode(opts(richUntrusted, richSummary));
    expect(result.status).toBe("captured");
    expect(result.status === "captured" && result.episode.trusted).toBe(false);
  });
});
