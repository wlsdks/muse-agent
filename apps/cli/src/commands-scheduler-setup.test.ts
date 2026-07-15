import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SetupStatusSnapshot } from "@muse/autoconfigure";
import { recordProactiveHeartbeat } from "@muse/stores";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./setup-model.js", () => ({
  runModelSetup: (io: { stdout(s: string): void }) => { io.stdout("model step\n"); return Promise.resolve(); },
  SETUP_MODEL_PROVIDER_SPECS: []
}));
vi.mock("./setup-calendar.js", () => ({
  runCalendarSetup: (io: { stdout(s: string): void }) => { io.stdout("calendar step\n"); return Promise.resolve(); }
}));
vi.mock("./setup-messaging.js", () => ({
  runMessagingSetup: (io: { stdout(s: string): void }) => { io.stdout("messaging step\n"); return Promise.resolve(); }
}));

import {
  comparePreviewEntriesByWhen,
  formatDaemonLivenessNotice,
  formatSetupStatusLines,
  registerSchedulerCommands,
  runSetupWizard,
  SCHEDULER_ADD_DAEMON_STALE_MS,
  type PreviewEntry,
  type SchedulerSetupHelpers
} from "./commands-scheduler-setup.js";
import type { ProgramIO } from "./program.js";

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

  it("interleaves a followup among jobs + reminders by instant", () => {
    const job = entry("2026-05-23T10:00:00Z", "digest", "job");
    const fu = entry("2026-05-23T08:00:00Z", "check the deploy", "followup");
    const rem = entry("2026-05-23T09:00:00Z", "buy milk");
    expect([job, rem, fu].sort(comparePreviewEntriesByWhen).map((e) => `${e.kind}:${e.label}`))
      .toEqual(["followup:check the deploy", "reminder:buy milk", "job:digest"]);
  });
});

describe("muse scheduler next — scheduled followups appear alongside jobs + reminders", () => {
  const prevFollowups = process.env.MUSE_FOLLOWUPS_FILE;
  afterEach(() => {
    if (prevFollowups === undefined) delete process.env.MUSE_FOLLOWUPS_FILE;
    else process.env.MUSE_FOLLOWUPS_FILE = prevFollowups;
  });

  it("includes a `scheduled` followup and excludes a `cancelled` one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-sched-fu-"));
    const file = join(dir, "followups.json");
    writeFileSync(file, `${JSON.stringify({ followups: [
      { id: "fu_1", userId: "local", scheduledFor: "2026-05-23T08:00:00Z", createdAt: "2026-05-23T07:00:00Z", summary: "check the deploy", status: "scheduled" },
      { id: "fu_2", userId: "local", scheduledFor: "2026-05-23T08:30:00Z", createdAt: "2026-05-23T07:00:00Z", summary: "cancelled promise", status: "cancelled" }
    ] })}\n`, "utf8");
    process.env.MUSE_FOLLOWUPS_FILE = file;

    const outputs: unknown[] = [];
    const io = { stderr: () => {}, stdout: () => {} } as unknown as ProgramIO;
    const helpers = {
      // No scheduler/reminder API in the test → empty, so only the
      // followups exercise the new merge path.
      apiRequest: async () => ({}),
      writeOutput: (_io: ProgramIO, value: unknown) => { outputs.push(value); }
    };
    const program = new Command();
    program.exitOverride();
    registerSchedulerCommands(program, io, helpers);
    await program.parseAsync(["node", "muse", "scheduler", "next", "--json"], { from: "node" });

    const payload = outputs[0] as { entries: Array<{ kind: string; label: string }>; total: number };
    const followupEntries = payload.entries.filter((e) => e.kind === "followup");
    expect(followupEntries.map((e) => e.label)).toEqual(["check the deploy"]);
    expect(payload.entries.some((e) => e.label === "cancelled promise")).toBe(false);
  });
});

describe("formatDaemonLivenessNotice — pure formatter per verdict", () => {
  it("alive → one quiet confirmation line, no warning", () => {
    const out = formatDaemonLivenessNotice({ ageMs: 5_000, detail: "x", status: "alive" });
    expect(out).toContain("Daemon alive");
    expect(out).not.toContain("WARNING");
    expect(out).not.toContain("경고");
  });

  it("stale → prominent bilingual warning block with exact recovery commands", () => {
    const out = formatDaemonLivenessNotice({ ageMs: 999_999, detail: "x", status: "stale" });
    expect(out).toContain("WARNING");
    expect(out).toContain("muse daemon");
    expect(out).toContain("muse daemon --install");
    expect(out).toContain("경고");
  });

  it("unknown (never ran) → prominent bilingual warning block", () => {
    const out = formatDaemonLivenessNotice({ detail: "x", status: "unknown" });
    expect(out).toContain("WARNING");
    expect(out).toContain("경고");
  });
});

describe("muse scheduler add — daemon liveness warning (R2-1)", () => {
  const prevJobsFile = process.env.MUSE_SCHEDULED_JOBS_FILE;
  afterEach(() => {
    if (prevJobsFile === undefined) delete process.env.MUSE_SCHEDULED_JOBS_FILE;
    else process.env.MUSE_SCHEDULED_JOBS_FILE = prevJobsFile;
  });

  async function runAdd(
    args: string[],
    seam: Pick<SchedulerSetupHelpers, "heartbeatDir" | "now">
  ): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "muse-sched-add-"));
    process.env.MUSE_SCHEDULED_JOBS_FILE = join(dir, "scheduled-jobs.json");
    const stdout: string[] = [];
    const io = { stderr: () => {}, stdout: (s: string) => stdout.push(s) } as unknown as ProgramIO;
    const helpers: SchedulerSetupHelpers = {
      apiRequest: async () => ({}),
      writeOutput: () => {},
      ...seam
    };
    const program = new Command();
    program.exitOverride();
    registerSchedulerCommands(program, io, helpers);
    await program.parseAsync(["node", "muse", "scheduler", "add", ...args], { from: "node" });
    return stdout.join("");
  }

  it("fresh daemon-loop heartbeat → quiet confirmation line, no warning block", async () => {
    const hbDir = mkdtempSync(join(tmpdir(), "muse-sched-hb-fresh-"));
    await recordProactiveHeartbeat(hbDir, "daemon-loop", () => new Date("2026-07-01T09:59:30Z"));
    const out = await runAdd(
      ["say hi", "--every", "daily 9am"],
      { heartbeatDir: hbDir, now: () => new Date("2026-07-01T10:00:00Z") }
    );
    expect(out).toContain("Scheduled 'say hi'");
    expect(out).toContain("Daemon alive");
    expect(out).not.toContain("WARNING");
  });

  it("stale daemon-loop heartbeat (older than 3x the tick interval) → prominent bilingual warning block", async () => {
    const hbDir = mkdtempSync(join(tmpdir(), "muse-sched-hb-stale-"));
    const now = new Date("2026-07-01T10:00:00Z");
    await recordProactiveHeartbeat(hbDir, "daemon-loop", () => new Date(now.getTime() - SCHEDULER_ADD_DAEMON_STALE_MS - 1_000));
    const out = await runAdd(["say hi", "--every", "daily 9am"], { heartbeatDir: hbDir, now: () => now });
    expect(out).toContain("WARNING");
    expect(out).toContain("muse daemon --install");
    expect(out).toContain("경고");
  });

  it("absent heartbeat (daemon never ran on this box) → prominent bilingual warning block", async () => {
    const hbDir = mkdtempSync(join(tmpdir(), "muse-sched-hb-absent-"));
    const out = await runAdd(["say hi", "--every", "daily 9am"], { heartbeatDir: hbDir });
    expect(out).toContain("WARNING");
    expect(out).toContain("경고");
  });

  it("--disabled job skips the liveness check — it needs `scheduler resume`, not the daemon", async () => {
    const hbDir = mkdtempSync(join(tmpdir(), "muse-sched-hb-disabled-"));
    const out = await runAdd(["say hi", "--every", "daily 9am", "--disabled"], { heartbeatDir: hbDir });
    expect(out).toContain("Scheduled 'say hi'");
    expect(out).not.toContain("WARNING");
    expect(out).not.toContain("Daemon alive");
  });
});

function baseSnap(): SetupStatusSnapshot {
  return {
    actuators: { email: false, home: false, status: "info", web: true },
    calendar: {
      credentials: { file: "/c/credentials.json", status: "info" },
      local: { file: "/c/calendar.json", status: "info" }
    },
    dailyBrief: { enabled: false, nextStep: "muse setup briefing", status: "info" },
    email: { source: "none", status: "info" },
    localOnly: { detail: "off (no cloud credentials configured)", enabled: false, status: "ok" },
    webEgress: { detail: "on", enabled: true, status: "ok" },
    mcp: { externalServerCount: 0, file: "/c/mcp.json", status: "info" },
    messaging: { providers: [], status: "info" },
    model: { keysFile: "/c/models.json", providerKeys: [], status: "ok" },
    notes: { dir: "/c/notes", status: "info" },
    proactive: { agentTurn: false, enabled: false, leadMinutes: 10, sidecarFile: "/c/p.json", status: "info", tickMs: 60000 },
    reminder: { agentTurn: false, enabled: false, status: "info", tickMs: 60000 },
    remote: { status: "info", tailscaleFound: false },
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

describe("formatSetupStatusLines — email/remote rows (R2-3)", () => {
  it("oauth-connected email renders auto-refresh, no next-step arrow", () => {
    const snap: SetupStatusSnapshot = { ...baseSnap(), email: { source: "oauth", status: "ok" } };
    const out = formatSetupStatusLines(snap).join("\n");
    expect(out).toContain("email — connected (oauth, auto-refresh)");
  });

  it("env-token email names the hourly-expiry caveat", () => {
    const snap: SetupStatusSnapshot = { ...baseSnap(), email: { source: "env", status: "ok" } };
    const out = formatSetupStatusLines(snap).join("\n");
    expect(out).toContain("email — via MUSE_GMAIL_TOKEN (hourly expiry)");
  });

  it("not-set-up email points at `muse setup email`", () => {
    const snap: SetupStatusSnapshot = {
      ...baseSnap(),
      email: { nextStep: "muse setup email", source: "none", status: "info" }
    };
    const out = formatSetupStatusLines(snap).join("\n");
    expect(out).toContain("email — not set up");
    expect(out).toContain("→ muse setup email");
  });

  it("tailscale found points at `muse remote enable`", () => {
    const snap: SetupStatusSnapshot = {
      ...baseSnap(),
      remote: { nextStep: "muse remote enable", status: "ok", tailscaleFound: true }
    };
    const out = formatSetupStatusLines(snap).join("\n");
    expect(out).toContain("remote — tailscale found");
    expect(out).toContain("→ muse remote enable");
  });

  it("tailscale not found points at the remote-access guide", () => {
    const snap: SetupStatusSnapshot = {
      ...baseSnap(),
      remote: { nextStep: "docs/guides/remote-access.md", status: "info", tailscaleFound: false }
    };
    const out = formatSetupStatusLines(snap).join("\n");
    expect(out).toContain("remote — not found");
    expect(out).toContain("→ docs/guides/remote-access.md");
  });
});

describe("formatSetupStatusLines — daily brief row (R2-3 pattern, muse setup briefing)", () => {
  it("not set up points at `muse setup briefing`", () => {
    const snap: SetupStatusSnapshot = { ...baseSnap() };
    const out = formatSetupStatusLines(snap).join("\n");
    expect(out).toContain("daily brief — not set up");
    expect(out).toContain("→ muse setup briefing");
  });

  it("enabled renders its configured time, no next-step arrow", () => {
    const snap: SetupStatusSnapshot = { ...baseSnap(), dailyBrief: { enabled: true, status: "ok", time: "07:15" } };
    const out = formatSetupStatusLines(snap).join("\n");
    expect(out).toContain("daily brief — enabled, 07:15 local");
    expect(out).not.toContain("→ muse setup briefing");
  });
});

describe("runSetupWizard — banner/section lines carry their own newline (do not run together)", () => {
  it("every wizard stdout line ends with a newline so steps are not concatenated", async () => {
    const chunks: string[] = [];
    await runSetupWizard({ stderr: () => {}, stdout: (s) => chunks.push(s) });
    // ProgramIO.stdout appends nothing — the caller owns the trailing \n.
    // A bare line missing it would run into the next on one terminal line.
    for (const chunk of chunks) {
      expect(chunk.endsWith("\n"), `wizard chunk lacked a trailing newline: ${JSON.stringify(chunk)}`).toBe(true);
    }
    // And the section headers must each be their OWN line, never glued to text.
    const joined = chunks.join("");
    expect(joined).toContain("[1/3] Model provider\n");
    expect(joined).not.toContain("[1/3] Model provider─");
    expect(joined).not.toContain("Three steps: model → calendar → messaging.You can stop");
  });
});
