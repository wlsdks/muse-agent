import type { SetupStatusSnapshot } from "@muse/autoconfigure";
import { describe, expect, it } from "vitest";

import { comparePreviewEntriesByWhen, formatSetupStatusLines, type PreviewEntry } from "./commands-scheduler-setup.js";

const entry = (when: string, label: string, kind: PreviewEntry["kind"] = "reminder"): PreviewEntry =>
  ({ kind, label, when });

describe("comparePreviewEntriesByWhen — `muse scheduler next` orders by instant, not lexicographic `when`", () => {
  it("orders a timezone-offset reminder dueAt by its real instant (a lexicographic sort would invert it)", () => {
    // a: 2026-05-22T23:00:00-05:00 == 2026-05-23T04:00:00Z (LATER instant)
    // b: 2026-05-23T01:00:00Z (EARLIER instant)
    // Lexicographically "2026-05-22T23…" < "2026-05-23T01…" → a would sort first; by instant b is sooner.
    const a = entry("2026-05-22T23:00:00-05:00", "later");
    const b = entry("2026-05-23T01:00:00Z", "earlier");
    expect([a, b].sort(comparePreviewEntriesByWhen).map((e) => e.label)).toEqual(["earlier", "later"]);
  });

  it("mixes a job nextRunAt and a reminder dueAt in true soonest-first order", () => {
    const job = entry("2026-05-23T02:00:00.000Z", "digest job", "job");
    const rem = entry("2026-05-22T22:30:00-05:00", "buy milk"); // == 2026-05-23T03:30Z (after the job)
    expect([rem, job].sort(comparePreviewEntriesByWhen).map((e) => e.label)).toEqual(["digest job", "buy milk"]);
  });

  it("keeps a deterministic order for equal instants (label tiebreak) and unparseable values", () => {
    const same = "2026-05-23T09:00:00.000Z";
    expect([entry(same, "zebra"), entry(same, "apple")].sort(comparePreviewEntriesByWhen).map((e) => e.label))
      .toEqual(["apple", "zebra"]);
    const x = entry("not-a-date", "x");
    const y = entry("also-bad", "y");
    expect([x, y].sort(comparePreviewEntriesByWhen)).toHaveLength(2);
  });
});

function baseSnap(): SetupStatusSnapshot {
  return {
    actuators: { email: false, home: false, status: "info", web: true },
    calendar: {
      credentials: { file: "/c/credentials.json", status: "info" },
      local: { file: "/c/calendar.json", status: "info" }
    },
    mcp: { externalServerCount: 0, file: "/c/mcp.json", status: "info" },
    messaging: { providers: [], status: "info" },
    model: { keysFile: "/c/models.json", providerKeys: [], status: "ok" },
    notes: { dir: "/c/notes", status: "info" },
    proactive: { agentTurn: false, enabled: false, leadMinutes: 10, sidecarFile: "/c/p.json", status: "info", tickMs: 60000 },
    reminder: { agentTurn: false, enabled: false, status: "info", tickMs: 60000 },
    tasks: { file: "/c/tasks.json", status: "info" },
    userMemory: { autoExtract: true, status: "ok" },
    voice: { source: "none", sttBackend: "none", status: "info", ttsBackend: "none" },
    webSearch: { enabled: true, maxUses: 5, source: "default", status: "ok" }
  };
}

describe("formatSetupStatusLines — an `ok` section's advisory nextStep is still surfaced", () => {
  it("renders the voice fallback warning even though the voice status is `ok`", () => {
    const snap: SetupStatusSnapshot = {
      ...baseSnap(),
      voice: {
        nextStep: "MUSE_VOICE_TTS=piper needs MUSE_PIPER_VOICE (path to a .onnx voice file); without it TTS fell back to openai-tts.",
        source: "openai_api_key",
        sttBackend: "openai-whisper",
        status: "ok",
        ttsBackend: "openai-tts"
      }
    };
    const out = formatSetupStatusLines(snap).join("\n");
    expect(out).toContain("voice — stt=openai-whisper, tts=openai-tts");
    // The advisory must appear despite status:ok — it was being swallowed.
    expect(out).toContain("→ MUSE_VOICE_TTS=piper needs MUSE_PIPER_VOICE");
  });

  it("an `ok` voice with no nextStep emits no advisory arrow for voice", () => {
    const snap: SetupStatusSnapshot = {
      ...baseSnap(),
      voice: { source: "muse_voice_openai_api_key", sttBackend: "openai-whisper", status: "ok", ttsBackend: "openai-tts" }
    };
    const out = formatSetupStatusLines(snap).join("\n");
    expect(out).toContain("voice — stt=openai-whisper, tts=openai-tts");
    expect(out).not.toContain("MUSE_PIPER_VOICE");
  });
});
