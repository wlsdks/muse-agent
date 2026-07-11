import { describe, expect, it } from "vitest";

import {
  cloudSyncFolderCheck,
  episodeIndexHealth,
  focusShortcutsCheck,
  messagingConfigCheck,
  notesIndexHealth,
  permissionModeDriftCheck,
  privacyRoutingCheck,
  readSensitiveFileModes,
  recallCalibrationCheck,
  runnerSandboxPostureCheck,
  TOOL_OUTPUT_CAP_ADVISORY_FLOOR_CHARS,
  platformPostureCheck,
  toolResultCapAdvisoryCheck,
  voiceSetupChecks,
  volatileMountCheck
} from "./commands-doctor-checks.js";

describe("privacyRoutingCheck — mirrors resolvePrivacyRoutedModel's own precedence", () => {
  it("off by default (no env set)", () => {
    const check = privacyRoutingCheck({});
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("off");
  });

  it("on but MUSE_CLOUD_MODEL missing → warn (every turn still stays local)", () => {
    const check = privacyRoutingCheck({ MUSE_PRIVACY_ROUTING: "true" });
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("MUSE_CLOUD_MODEL is not set");
  });

  it("on with a configured cloud model → ok, names the model", () => {
    const check = privacyRoutingCheck({ MUSE_CLOUD_MODEL: "gemini/gemini-2.5-flash", MUSE_PRIVACY_ROUTING: "true" });
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("gemini/gemini-2.5-flash");
  });

  it("MUSE_LOCAL_ONLY wins even with routing fully configured — forced local", () => {
    const check = privacyRoutingCheck({ MUSE_CLOUD_MODEL: "gemini/gemini-2.5-flash", MUSE_LOCAL_ONLY: "true", MUSE_PRIVACY_ROUTING: "true" });
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("forced local");
  });
});

describe("focusShortcutsCheck — Focus/DND shortcut presence", () => {
  it("both convention shortcuts present → ok", () => {
    const check = focusShortcutsCheck({}, ["Morning Routine", "Muse Focus On", "Muse Focus Off"]);
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("Muse Focus On");
  });

  it("a missing shortcut → warn naming which one + the Set Focus setup", () => {
    const check = focusShortcutsCheck({}, ["Muse Focus On"]);
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("Muse Focus Off");
    expect(check.detail).toContain("Set Focus");
  });

  it("can't enumerate shortcuts (undefined) → warn 'couldn't list'", () => {
    const check = focusShortcutsCheck({}, undefined);
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("couldn't list");
  });

  it("honors MUSE_FOCUS_{ON,OFF}_SHORTCUT overrides", () => {
    const env = { MUSE_FOCUS_OFF_SHORTCUT: "집중 끄기", MUSE_FOCUS_ON_SHORTCUT: "집중 켜기" };
    const ok = focusShortcutsCheck(env, ["집중 켜기", "집중 끄기"]);
    expect(ok.status).toBe("ok");
    const warn = focusShortcutsCheck(env, ["집중 켜기"]);
    expect(warn.status).toBe("warn");
    expect(warn.detail).toContain("집중 끄기");
  });
});

describe("voiceSetupChecks — actionable STT/TTS setup guidance", () => {
  const byName = (checks: ReturnType<typeof voiceSetupChecks>, name: string) => checks.find((c) => c.name === name)!;

  it("both OFF (default env) → ok STT+TTS lines carrying the exact opt-in steps", () => {
    const checks = voiceSetupChecks({});
    const stt = byName(checks, "voice:stt");
    const tts = byName(checks, "voice:tts");
    expect(stt.status).toBe("ok"); // opt-in OFF is never a health failure
    expect(tts.status).toBe("ok");
    expect(stt.detail).toContain("MUSE_VOICE_STT=whisper-cpp");
    expect(stt.detail).toContain("brew install whisper-cpp");
    // The Korean-capable MULTILINGUAL model, NOT the English-only build.
    expect(stt.detail).toContain("ggml-base.bin");
    expect(stt.detail).toContain("Korean");
    expect(tts.detail).toContain("MUSE_VOICE_TTS=piper");
  });

  it("Korean TTS guidance names the KSS voice AND reproduces its non-commercial license verbatim", () => {
    const tts = byName(voiceSetupChecks({}), "voice:tts");
    expect(tts.detail).toContain("neurlang/piper-onnx-kss-korean");
    expect(tts.detail).toContain("CC-BY-NC-SA 4.0");
    expect(tts.detail.toLowerCase()).toContain("non-commercial");
  });

  it("reports STT ENABLED when MUSE_VOICE_STT=whisper-cpp", () => {
    const stt = byName(voiceSetupChecks({ MUSE_VOICE_STT: "whisper-cpp" }), "voice:stt");
    expect(stt.status).toBe("ok");
    expect(stt.detail).toContain("ENABLED");
    expect(stt.detail.toLowerCase()).toContain("multilingual");
  });

  it("reports TTS ENABLED when piper + a voice path are set", () => {
    const tts = byName(voiceSetupChecks({ MUSE_VOICE_TTS: "piper", MUSE_PIPER_VOICE: "/v/kss.onnx" }), "voice:tts");
    expect(tts.status).toBe("ok");
    expect(tts.detail).toContain("ENABLED");
    expect(tts.detail).toContain("/v/kss.onnx");
  });

  it("WARNS on half-configured Piper (MUSE_VOICE_TTS=piper but no MUSE_PIPER_VOICE)", () => {
    const tts = byName(voiceSetupChecks({ MUSE_VOICE_TTS: "piper" }), "voice:tts");
    expect(tts.status).toBe("warn");
    expect(tts.detail).toContain("MUSE_PIPER_VOICE");
    expect(tts.detail).toContain("will NOT register");
  });
});

describe("recallCalibrationCheck — surfaces the recall confidence floor's calibration posture", () => {
  it("ok + the calibrated bar for the v2-moe default embedder", () => {
    const r = recallCalibrationCheck("nomic-embed-text-v2-moe", {});
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("0.45");
    expect(r.detail).toContain("calibrated for nomic-embed-text-v2-moe");
  });

  it("ok + the 0.55 bar for the legacy nomic-embed-text", () => {
    const r = recallCalibrationCheck("nomic-embed-text", {});
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("0.55");
  });

  it("WARNS for an unknown embedder on the conservative fallback (may over-abstain)", () => {
    const r = recallCalibrationCheck("some-future-embedder", {});
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("conservative fallback");
    expect(r.detail).toContain("0.55");
  });

  it("reports an explicit MUSE_GROUNDING_MIN_COSINE override (beats the embedder bar)", () => {
    const r = recallCalibrationCheck("nomic-embed-text-v2-moe", { MUSE_GROUNDING_MIN_COSINE: "0.62" });
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("0.62");
    expect(r.detail).toContain("MUSE_GROUNDING_MIN_COSINE");
  });
});

describe("messagingConfigCheck", () => {
  it("reports none configured (opt-in) and the wired providers", () => {
    expect(messagingConfigCheck({}).detail).toContain("no messaging provider");
    const wired = messagingConfigCheck({ MUSE_TELEGRAM_BOT_TOKEN: "t", MUSE_SLACK_BOT_TOKEN: "s" });
    expect(wired.detail).toContain("telegram");
    expect(wired.detail).toContain("slack");
    expect(wired.status).toBe("ok");
  });
});

describe("notesIndexHealth", () => {
  it("warns when absent or stale, ok when present+fresh", () => {
    expect(notesIndexHealth({ exists: false, stale: false }).status).toBe("warn");
    expect(notesIndexHealth({ exists: true, stale: true }).status).toBe("warn");
    expect(notesIndexHealth({ exists: true, stale: false }).status).toBe("ok");
  });
});

describe("episodeIndexHealth", () => {
  it("ok when none, warns when unindexed or lagging, ok when fully indexed", () => {
    expect(episodeIndexHealth({ episodeCount: 0, indexedCount: 0 }).status).toBe("ok");
    expect(episodeIndexHealth({ episodeCount: 5, indexedCount: 0 }).status).toBe("warn");
    expect(episodeIndexHealth({ episodeCount: 5, indexedCount: 3 }).status).toBe("warn");
    expect(episodeIndexHealth({ episodeCount: 5, indexedCount: 5 }).status).toBe("ok");
  });
});

// DS-11 — state-directory integrity + tool-result-cap advisory.

describe("cloudSyncFolderCheck", () => {
  it("warns when the state dir is under iCloud Drive", () => {
    const r = cloudSyncFolderCheck("/Users/jinan/Library/Mobile Documents/com~apple~CloudDocs/.muse");
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("iCloud Drive");
    expect(r.detail).toContain("cloud-sync");
  });

  it("warns when the state dir is under Dropbox / Google Drive / OneDrive", () => {
    expect(cloudSyncFolderCheck("/Users/jinan/Dropbox/.muse").status).toBe("warn");
    expect(cloudSyncFolderCheck("/Users/jinan/Google Drive/.muse").status).toBe("warn");
    expect(cloudSyncFolderCheck("/Users/jinan/OneDrive/.muse").status).toBe("warn");
  });

  it("ok for a normal, non-cloud-synced path", () => {
    const r = cloudSyncFolderCheck("/Users/jinan/.muse");
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("local, non-cloud-synced");
  });
});

describe("volatileMountCheck", () => {
  it("returns undefined (silently skipped) on a non-Linux platform", async () => {
    const r = await volatileMountCheck("/home/jinan/.muse", "darwin", () => Promise.resolve(""));
    expect(r).toBeUndefined();
  });

  it("warns when the state dir resolves to a tmpfs mount on Linux", async () => {
    const mounts = [
      "overlay / overlay rw,relatime 0 0",
      "tmpfs /home/jinan/.muse tmpfs rw,relatime 0 0"
    ].join("\n");
    const r = await volatileMountCheck("/home/jinan/.muse", "linux", () => Promise.resolve(mounts));
    expect(r?.status).toBe("warn");
    expect(r?.detail).toContain("tmpfs");
  });

  it("ok when the state dir resolves to a persistent (non-volatile) mount on Linux", async () => {
    const mounts = [
      "overlay / overlay rw,relatime 0 0",
      "ext4 /home ext4 rw,relatime 0 0"
    ].join("\n");
    const r = await volatileMountCheck("/home/jinan/.muse", "linux", () => Promise.resolve(mounts));
    expect(r?.status).toBe("ok");
    expect(r?.detail).not.toContain("tmpfs");
  });

  it("fails soft (ok, never throws) when /proc/mounts can't be read", async () => {
    const r = await volatileMountCheck("/home/jinan/.muse", "linux", () => Promise.reject(new Error("EACCES")));
    expect(r?.status).toBe("ok");
    expect(r?.detail).toContain("skipped");
  });
});

describe("readSensitiveFileModes + permissionModeDriftCheck", () => {
  it("flags a file drifted to 644 (world/group-readable)", async () => {
    const results = await readSensitiveFileModes(
      [{ label: "recall-hits.json", path: "/fake/recall-hits.json" }],
      () => Promise.resolve({ mode: 0o100644 })
    );
    const verdict = permissionModeDriftCheck(results);
    expect(verdict.status).toBe("warn");
    expect(verdict.detail).toContain("recall-hits.json");
    expect(verdict.detail).toContain("644");
  });

  it("does NOT flag a file at the expected 600 (owner-only)", async () => {
    const results = await readSensitiveFileModes(
      [{ label: "user-memory.json", path: "/fake/user-memory.json" }],
      () => Promise.resolve({ mode: 0o100600 })
    );
    const verdict = permissionModeDriftCheck(results);
    expect(verdict.status).toBe("ok");
    expect(verdict.detail).toContain("owner-only");
  });

  it("treats a mix of drifted and clean files correctly, and skips missing files without flagging them", async () => {
    const targets = [
      { label: "a.json", path: "/fake/a.json" },
      { label: "b.json", path: "/fake/b.json" },
      { label: "missing.json", path: "/fake/missing.json" }
    ];
    const results = await readSensitiveFileModes(targets, (p) => {
      if (p === "/fake/a.json") return Promise.resolve({ mode: 0o100644 });
      if (p === "/fake/b.json") return Promise.resolve({ mode: 0o100600 });
      return Promise.reject(new Error("ENOENT"));
    });
    const verdict = permissionModeDriftCheck(results);
    expect(verdict.status).toBe("warn");
    expect(verdict.detail).toContain("a.json");
    expect(verdict.detail).not.toContain("b.json (");
    expect(verdict.detail).not.toContain("missing.json");
  });

  it("reports ok with nothing-to-check when no target files exist yet", async () => {
    const results = await readSensitiveFileModes(
      [{ label: "user-memory.json", path: "/fake/user-memory.json" }],
      () => Promise.reject(new Error("ENOENT"))
    );
    expect(permissionModeDriftCheck(results).status).toBe("ok");
  });

  it("readSensitiveFileModes fails soft per-file — an injected stat error never throws", async () => {
    await expect(
      readSensitiveFileModes(
        [{ label: "x.json", path: "/fake/x.json" }],
        () => Promise.reject(new Error("boom"))
      )
    ).resolves.toEqual([{ label: "x.json", mode: undefined, path: "/fake/x.json" }]);
  });
});

describe("toolResultCapAdvisoryCheck", () => {
  it("warns when MUSE_MAX_TOOL_OUTPUT_CHARS is set below the sane floor", () => {
    const r = toolResultCapAdvisoryCheck({ MUSE_MAX_TOOL_OUTPUT_CHARS: "50" });
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("50");
    expect(r.detail).toContain(TOOL_OUTPUT_CAP_ADVISORY_FLOOR_CHARS.toString());
  });

  it("does NOT warn at or above the sane floor", () => {
    expect(toolResultCapAdvisoryCheck({ MUSE_MAX_TOOL_OUTPUT_CHARS: String(TOOL_OUTPUT_CAP_ADVISORY_FLOOR_CHARS) }).status).toBe("ok");
    expect(toolResultCapAdvisoryCheck({ MUSE_MAX_TOOL_OUTPUT_CHARS: "8000" }).status).toBe("ok");
  });

  it("ok when unset (default applies)", () => {
    expect(toolResultCapAdvisoryCheck({}).status).toBe("ok");
  });

  it("ok (not a false positive) when the cap is explicitly disabled via 0", () => {
    const r = toolResultCapAdvisoryCheck({ MUSE_MAX_TOOL_OUTPUT_CHARS: "0" });
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("DISABLED");
  });

  it("fails soft (ok) on a non-numeric override instead of crashing", () => {
    const r = toolResultCapAdvisoryCheck({ MUSE_MAX_TOOL_OUTPUT_CHARS: "not-a-number" });
    expect(r.status).toBe("ok");
  });
});

describe("runnerSandboxPostureCheck — MUSE_RUNNER_SANDBOX=seatbelt posture", () => {
  it("ok, off by default (unset) — names the opt-in", () => {
    const r = runnerSandboxPostureCheck({}, "darwin");
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("off");
    expect(r.detail).toContain("MUSE_RUNNER_SANDBOX=seatbelt");
  });

  it("ok, seatbelt active on darwin", () => {
    const r = runnerSandboxPostureCheck({ MUSE_RUNNER_SANDBOX: "seatbelt" }, "darwin");
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("seatbelt active");
  });

  it("warn, seatbelt requested but unsupported off-darwin", () => {
    const r = runnerSandboxPostureCheck({ MUSE_RUNNER_SANDBOX: "seatbelt" }, "linux");
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("unsupported");
    expect(r.detail).toContain("unsandboxed");
  });

  it("ok when unset regardless of platform", () => {
    expect(runnerSandboxPostureCheck({}, "linux").status).toBe("ok");
  });

  it("ok when set to something other than 'seatbelt' (treated as off)", () => {
    const r = runnerSandboxPostureCheck({ MUSE_RUNNER_SANDBOX: "bogus" }, "darwin");
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("off");
  });
});

describe("platformPostureCheck", () => {
  it("darwin reports full posture as ok", () => {
    const check = platformPostureCheck("darwin");
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("audio=afplay");
    expect(check.detail).toContain("autostart=launchd");
    expect(check.detail).toContain("os-integrations=macos");
  });

  it("win32 reports the reduced posture honestly, still ok (fail-soft, not broken)", () => {
    const check = platformPostureCheck("win32");
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("audio=powershell");
    expect(check.detail).toContain("autostart=schtasks");
    expect(check.detail).toContain("os-integrations=windows");
    expect(check.detail).toContain("MUSE_WINDOWS_ACTUATORS");
    expect(check.detail).toContain("CI-verified only");
  });
});
