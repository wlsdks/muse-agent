import { describe, expect, it, vi } from "vitest";

import {
  bluetoothShortcutsCheck,
  brightnessShortcutCheck,
  cloudSyncFolderCheck,
  episodeIndexHealth,
  focusShortcutsCheck,
  memoryAutoExtractHealthCheck,
  messagingConfigCheck,
  notesIndexHealth,
  permissionModeDriftCheck,
  applySensitivePermissionRepair,
  hashSensitivePermissionRepairPlan,
  inventorySensitiveDirectories,
  planSensitivePermissionRepair,
  privacyRoutingCheck,
  readSensitiveFileModes,
  recallCalibrationCheck,
  TOOL_OUTPUT_CAP_ADVISORY_FLOOR_CHARS,
  platformPostureCheck,
  toolResultCapAdvisoryCheck,
  voiceSetupChecks,
  volatileMountCheck, promptCacheHealth } from "./commands-doctor-checks.js";

describe("memoryAutoExtractHealthCheck", () => {
  it("warns on unavailable data without exposing trace identifiers", () => {
    const check = memoryAutoExtractHealthCheck({
      consecutiveFailures: 0,
      freshness: "no-success",
      reasonCounts: { learned: 0, model_error: 0, nothing_new: 0, policy_rejected: 0, schema_error: 0, store_error: 0, timeout: 0 },
      sampleSize: 0,
      status: "no-data"
    });

    expect(check).toEqual({ detail: "unknown — no usable automatic-extraction outcome data yet", name: "memory learning", status: "warn" });
    expect(JSON.stringify(check)).not.toContain("runId");
  });
});

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

describe("bluetoothShortcutsCheck — Bluetooth shortcut presence", () => {
  it("both convention shortcuts present → ok", () => {
    const check = bluetoothShortcutsCheck({}, ["Muse Bluetooth On", "Muse Bluetooth Off"]);
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("Muse Bluetooth On");
  });

  it("a missing shortcut → warn naming which one + the Set Bluetooth setup", () => {
    const check = bluetoothShortcutsCheck({}, ["Muse Bluetooth On"]);
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("Muse Bluetooth Off");
    expect(check.detail).toContain("Set Bluetooth");
  });

  it("can't enumerate shortcuts (undefined) → warn 'couldn't list'", () => {
    const check = bluetoothShortcutsCheck({}, undefined);
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("couldn't list");
  });

  it("honors MUSE_BLUETOOTH_{ON,OFF}_SHORTCUT overrides", () => {
    const env = { MUSE_BLUETOOTH_OFF_SHORTCUT: "BT Off", MUSE_BLUETOOTH_ON_SHORTCUT: "BT On" };
    const ok = bluetoothShortcutsCheck(env, ["BT On", "BT Off"]);
    expect(ok.status).toBe("ok");
    const warn = bluetoothShortcutsCheck(env, ["BT On"]);
    expect(warn.status).toBe("warn");
    expect(warn.detail).toContain("BT Off");
  });
});

describe("brightnessShortcutCheck — Brightness shortcut presence", () => {
  it("the convention shortcut present → ok", () => {
    const check = brightnessShortcutCheck({}, ["Morning Routine", "Muse Set Brightness"]);
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("Muse Set Brightness");
  });

  it("missing → warn naming the Set Brightness setup", () => {
    const check = brightnessShortcutCheck({}, ["Morning Routine"]);
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("Set Brightness");
  });

  it("can't enumerate shortcuts (undefined) → warn 'couldn't list'", () => {
    const check = brightnessShortcutCheck({}, undefined);
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("couldn't list");
  });

  it("honors MUSE_BRIGHTNESS_SHORTCUT override", () => {
    const env = { MUSE_BRIGHTNESS_SHORTCUT: "My Bright" };
    const ok = brightnessShortcutCheck(env, ["My Bright"]);
    expect(ok.status).toBe("ok");
    const warn = brightnessShortcutCheck(env, ["Muse Set Brightness"]);
    expect(warn.status).toBe("warn");
    expect(warn.detail).toContain("My Bright");
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
    const r = cloudSyncFolderCheck("/Users/test-user/Library/Mobile Documents/com~apple~CloudDocs/.muse");
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("iCloud Drive");
    expect(r.detail).toContain("cloud-sync");
  });

  it("warns when the state dir is under Dropbox / Google Drive / OneDrive", () => {
    expect(cloudSyncFolderCheck("/Users/test-user/Dropbox/.muse").status).toBe("warn");
    expect(cloudSyncFolderCheck("/Users/test-user/Google Drive/.muse").status).toBe("warn");
    expect(cloudSyncFolderCheck("/Users/test-user/OneDrive/.muse").status).toBe("warn");
  });

  it("ok for a normal, non-cloud-synced path", () => {
    const r = cloudSyncFolderCheck("/Users/test-user/.muse");
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
  const rootIdentity = { dev: 1, ino: 1, realpath: "/muse" };
  const repairItem = (
    label: string,
    ino = 2
  ) => ({
    label,
    observedDev: 1,
    observedIno: ino,
    observedMode: 0o644,
    path: `/muse/${label}`,
    state: "repairable" as const
  });

  it("inventories only exact notes/checkpoints directories at expected 0700 without mutation", async () => {
    const lstat = vi.fn(async (path: string) => ({
      isDirectory: () => true,
      isSymbolicLink: () => false,
      mode: path.endsWith("/notes") ? 0o40755 : 0o40700
    }));

    const items = await inventorySensitiveDirectories(
      "/home/test/.muse",
      { HOME: "/home/test" },
      undefined,
      { lstat, realpath: async (path) => path }
    );

    expect(items).toEqual([
      {
        expectedMode: 0o700,
        id: "notes",
        observedMode: 0o755,
        path: "/home/test/.muse/notes",
        repairCandidate: true,
        state: "repairable"
      },
      {
        expectedMode: 0o700,
        id: "checkpoints",
        observedMode: 0o700,
        path: "/home/test/.muse/checkpoints",
        repairCandidate: false,
        state: "already-owner-only"
      }
    ]);
    expect(lstat).toHaveBeenCalledTimes(3);
  });

  it.each([
    {
      candidates: ["/home/test/.muse/unknown"],
      env: { HOME: "/home/test" },
      reason: "allowlist",
      rootKind: "directory"
    },
    {
      candidates: ["/outside/notes"],
      env: { HOME: "/home/test", MUSE_NOTES_DIR: "/outside/notes" },
      reason: "outside",
      rootKind: "directory"
    },
    {
      candidates: ["/home/test/.muse/notes"],
      env: { HOME: "/home/test" },
      reason: "root is a symbolic link",
      rootKind: "symlink"
    }
  ])(
    "rejects unknown, outside-scope, and symlink-root candidates ($reason)",
    async ({ candidates, env, reason, rootKind }) => {
      const items = await inventorySensitiveDirectories(
        "/home/test/.muse",
        env,
        candidates,
        {
          lstat: async (path) => ({
            isDirectory: () => path === "/home/test/.muse" && rootKind !== "symlink",
            isSymbolicLink: () => path === "/home/test/.muse" && rootKind === "symlink",
            mode: path === "/home/test/.muse" && rootKind === "symlink" ? 0o120777 : 0o40755
          }),
          realpath: async (path) => path
        }
      );

      expect(items).toEqual([
        expect.objectContaining({
          expectedMode: 0o700,
          reason: expect.stringContaining(reason),
          repairCandidate: false,
          state: "rejected"
        })
      ]);
    }
  );

  it("rejects an exact target that is itself a symlink", async () => {
    const items = await inventorySensitiveDirectories(
      "/home/test/.muse",
      { HOME: "/home/test" },
      ["/home/test/.muse/notes"],
      {
        lstat: async (path) => ({
          isDirectory: () => path === "/home/test/.muse",
          isSymbolicLink: () => path.endsWith("/notes"),
          mode: path.endsWith("/notes") ? 0o120777 : 0o40700
        }),
        realpath: async (path) => path
      }
    );

    expect(items).toEqual([
      expect.objectContaining({
        id: "notes",
        reason: expect.stringContaining("symbolic"),
        repairCandidate: false,
        state: "rejected"
      })
    ]);
  });

  it("marks an exact missing directory as non-repairable inventory", async () => {
    const items = await inventorySensitiveDirectories(
      "/home/test/.muse",
      { HOME: "/home/test" },
      ["/home/test/.muse/checkpoints"],
      {
        lstat: async (path) => {
          if (path.endsWith("/checkpoints")) throw new Error("ENOENT");
          return { isDirectory: () => true, isSymbolicLink: () => false, mode: 0o40700 };
        },
        realpath: async (path) => path
      }
    );

    expect(items).toEqual([
      {
        expectedMode: 0o700,
        id: "checkpoints",
        path: "/home/test/.muse/checkpoints",
        repairCandidate: false,
        state: "missing"
      }
    ]);
  });

  it("rejects exact targets when the Muse root traverses a symlinked HOME ancestor", async () => {
    const items = await inventorySensitiveDirectories(
      "/alias-home/.muse",
      { HOME: "/alias-home" },
      undefined,
      {
        lstat: async () => ({
          isDirectory: () => true,
          isSymbolicLink: () => false,
          mode: 0o40755
        }),
        realpath: async (path) => path === "/alias-home/.muse"
          ? "/physical-home/.muse"
          : path
      }
    );

    expect(items).toHaveLength(2);
    expect(items).toEqual(items.map(() => expect.objectContaining({
      reason: expect.stringContaining("symbolic-link ancestor"),
      repairCandidate: false,
      state: "rejected"
    })));
  });

  it("revalidates no-follow handles before applying a plan and never touches a rejected target", async () => {
    const plan = {
      items: [
        repairItem("repair.json"),
        { label: "outside.json", path: "/elsewhere/outside.json", reason: "outside", state: "rejected" as const }
      ],
      root: "/muse",
      rootIdentity
    };
    const chmod = vi.fn(async () => undefined);
    const result = await applySensitivePermissionRepair(plan, {
      lstat: async (path) => ({ dev: 1, ino: path === "/muse" ? 1 : 2, isFile: () => true, isSymbolicLink: () => false, mode: 0o100644 }),
      open: async () => ({ chmod, close: async () => undefined, stat: async () => ({ isFile: () => true, isSymbolicLink: () => false, mode: 0o100644 }) }),
      realpath: async (path) => path
    });
    expect(result).toEqual(expect.objectContaining({
      applied: [],
      changes: [],
      planHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      rejected: "plan contains a rejected target"
    }));
    expect(chmod).not.toHaveBeenCalled();
  });

  it.each([
    { path: "/muse/secret.json", reason: "symbolic", symlinkPath: "/muse" },
    { path: "/muse/linked/secret.json", reason: "direct children", symlinkPath: "/muse/linked" }
  ])(
    "rejects unsafe owned path $path before opening the target",
    async ({ path: targetPath, reason, symlinkPath }) => {
      const plan = await planSensitivePermissionRepair(
        "/muse",
        [{ label: "secret.json", path: targetPath }],
        {
          lstat: async (path) => ({
            dev: 1,
            ino: path === "/muse" ? 1 : 2,
            isFile: () => path.endsWith("secret.json"),
            isSymbolicLink: () => path === symlinkPath,
            mode: path === symlinkPath ? 0o120777 : 0o100644
          }),
          realpath: async (path) => path
        }
      );
      expect(plan.items).toEqual([
        expect.objectContaining({ label: "secret.json", reason: expect.stringContaining(reason), state: "rejected" })
      ]);

      const open = vi.fn();
      const receipt = await applySensitivePermissionRepair({
        items: [{ ...repairItem("secret.json"), path: targetPath }],
        root: "/muse",
        rootIdentity
      }, {
        lstat: async (path) => ({
          dev: 1,
          ino: path === "/muse" ? 1 : 2,
          isFile: () => path.endsWith("secret.json"),
          isSymbolicLink: () => path === symlinkPath,
          mode: path === symlinkPath ? 0o120777 : 0o100644
        }),
        open,
        realpath: async (path) => path
      });
      expect(receipt).toEqual({
        applied: [],
        changes: [],
        planHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        rejected: targetPath.includes("/linked/")
          ? "target ancestor changed or is unsafe (nested-target): secret.json"
          : "plan root identity is missing or changed"
      });
      expect(open).not.toHaveBeenCalled();
    }
  );

  it("applies 0600 only after every no-follow handle still matches the dry-run mode", async () => {
    let mode = 0o100644;
    const chmod = vi.fn(async (nextMode: number) => {
      mode = 0o100000 | nextMode;
    });
    const result = await applySensitivePermissionRepair({
      items: [repairItem("repair.json")],
      root: "/muse",
      rootIdentity
    }, {
      lstat: async (path) => ({ dev: 1, ino: path === "/muse" ? 1 : 2, isFile: () => true, isSymbolicLink: () => false, mode }),
      open: async () => ({ chmod, close: async () => undefined, stat: async () => ({ dev: 1, ino: 2, isFile: () => true, isSymbolicLink: () => false, mode }) }),
      realpath: async (path) => path
    });
    expect(result).toEqual({
      applied: ["/muse/repair.json"],
      changes: [{
        afterMode: 0o600,
        beforeMode: 0o644,
        path: "/muse/repair.json",
        verification: "verified"
      }],
      planHash: expect.stringMatching(/^[0-9a-f]{64}$/u)
    });
    expect(chmod).toHaveBeenCalledWith(0o600);
  });

  it("returns a receipt for earlier successful files when a later chmod fails", async () => {
    const modes = new Map([
      ["/muse/a.json", 0o100644],
      ["/muse/b.json", 0o100644]
    ]);
    const result = await applySensitivePermissionRepair({
      items: [
        repairItem("a.json", 2),
        repairItem("b.json", 3)
      ],
      root: "/muse",
      rootIdentity
    }, {
      lstat: async (path) => ({
        dev: 1,
        ino: path === "/muse" ? 1 : path.endsWith("/a.json") ? 2 : 3,
        isFile: () => path !== "/muse",
        isSymbolicLink: () => false,
        mode: modes.get(path) ?? 0o40700
      }),
      open: async (path) => ({
        chmod: async (nextMode) => {
          if (path.endsWith("/b.json")) throw new Error("injected chmod failure");
          modes.set(path, 0o100000 | nextMode);
        },
        close: async () => undefined,
        stat: async () => ({
          dev: 1,
          ino: path.endsWith("/a.json") ? 2 : 3,
          isFile: () => true,
          isSymbolicLink: () => false,
          mode: modes.get(path)!
        })
      }),
      realpath: async (path) => path
    });

    expect(result).toEqual({
      applied: ["/muse/a.json"],
      changes: [{
        afterMode: 0o600,
        beforeMode: 0o644,
        path: "/muse/a.json",
        verification: "verified"
      }],
      planHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      rejected: "chmod failed before changing target: b.json"
    });
    expect(modes.get("/muse/a.json")! & 0o777).toBe(0o600);
    expect(modes.get("/muse/b.json")! & 0o777).toBe(0o644);
  });

  it("records an unverified change instead of losing the receipt when post-chmod stat fails", async () => {
    let chmodCompleted = false;
    const result = await applySensitivePermissionRepair({
      items: [repairItem("repair.json")],
      root: "/muse",
      rootIdentity
    }, {
      lstat: async (path) => ({ dev: 1, ino: path === "/muse" ? 1 : 2, isFile: () => true, isSymbolicLink: () => false, mode: 0o100644 }),
      open: async () => ({
        chmod: async () => { chmodCompleted = true; },
        close: async () => undefined,
        stat: async () => {
          if (chmodCompleted) throw new Error("injected stat failure");
          return { dev: 1, ino: 2, isFile: () => true, isSymbolicLink: () => false, mode: 0o100644 };
        }
      }),
      realpath: async (path) => path
    });

    expect(result).toEqual({
      applied: [],
      changes: [{
        beforeMode: 0o644,
        path: "/muse/repair.json",
        verification: "unverified"
      }],
      planHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      rejected: "target mode could not be verified after chmod: repair.json"
    });
  });

  it("preserves a verified receipt and reports descriptor cleanup failure", async () => {
    let mode = 0o100644;
    const result = await applySensitivePermissionRepair({
      items: [repairItem("repair.json")],
      root: "/muse",
      rootIdentity
    }, {
      lstat: async (path) => ({ dev: 1, ino: path === "/muse" ? 1 : 2, isFile: () => true, isSymbolicLink: () => false, mode }),
      open: async () => ({
        chmod: async (nextMode) => { mode = 0o100000 | nextMode; },
        close: async () => { throw new Error("injected close failure"); },
        stat: async () => ({ dev: 1, ino: 2, isFile: () => true, isSymbolicLink: () => false, mode })
      }),
      realpath: async (path) => path
    });

    expect(result).toEqual({
      applied: ["/muse/repair.json"],
      changes: [{
        afterMode: 0o600,
        beforeMode: 0o644,
        path: "/muse/repair.json",
        verification: "verified"
      }],
      cleanupFailures: ["repair.json"],
      planHash: expect.stringMatching(/^[0-9a-f]{64}$/u)
    });
  });

  it("leaves the opened file unchanged when the owned root becomes a symlink during open", async () => {
    let rootUnsafe = false;
    const chmod = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const result = await applySensitivePermissionRepair({
      items: [repairItem("repair.json")],
      root: "/muse",
      rootIdentity
    }, {
      lstat: async (path) => ({
        dev: 1,
        ino: path === "/muse" ? 1 : 2,
        isFile: () => path !== "/muse",
        isSymbolicLink: () => path === "/muse" && rootUnsafe,
        mode: path === "/muse" && rootUnsafe ? 0o120777 : 0o100644
      }),
      open: async () => {
        rootUnsafe = true;
        return {
          chmod,
          close,
          stat: async () => ({
            dev: 1,
            ino: 2,
            isFile: () => true,
            isSymbolicLink: () => false,
            mode: 0o100644
          })
        };
      },
      realpath: async (path) => path
    });
    expect(result).toEqual({
      applied: [],
      changes: [],
      planHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      rejected: "target changed or is unsafe: repair.json"
    });
    expect(chmod).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("plans only a loose regular file under the exact Muse root", async () => {
    const plan = await planSensitivePermissionRepair(
      "/muse",
      [
        { label: "loose.json", path: "/muse/loose.json" },
        { label: "clean.json", path: "/muse/clean.json" },
        { label: "missing.json", path: "/muse/missing.json" },
        { label: "outside.json", path: "/elsewhere/outside.json" },
        { label: "link.json", path: "/muse/link.json" }
      ],
      {
        lstat: async (path) => {
          if (path.endsWith("missing.json")) throw new Error("ENOENT");
          if (path.endsWith("link.json")) return { dev: 1, ino: 5, isFile: () => false, isSymbolicLink: () => true, mode: 0o120777 };
          return {
            dev: 1,
            ino: path === "/muse" ? 1 : path.endsWith("loose.json") ? 2 : 3,
            isFile: () => true,
            isSymbolicLink: () => false,
            mode: path.endsWith("loose.json") ? 0o100644 : 0o100600
          };
        },
        realpath: async (path) => path
      }
    );

    expect(plan.items.map((item) => [item.label, item.state])).toEqual([
      ["loose.json", "repairable"],
      ["clean.json", "already-owner-only"],
      ["missing.json", "missing"],
      ["outside.json", "rejected"],
      ["link.json", "rejected"]
    ]);
    expect(plan.items.find((item) => item.label === "link.json")?.reason).toContain("symbolic");
    expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(plan.planHash).toBe(hashSensitivePermissionRepairPlan(plan));
    expect(hashSensitivePermissionRepairPlan({
      ...plan,
      items: plan.items.map((item, index) => index === 0
        ? { ...item, observedMode: 0o600 }
        : item)
    })).not.toBe(plan.planHash);
    expect(hashSensitivePermissionRepairPlan({
      ...plan,
      items: plan.items.map((item, index) => index === 0
        ? { ...item, observedIno: (item.observedIno ?? 0) + 1 }
        : item)
    })).not.toBe(plan.planHash);
  });

  it("rejects a Muse root reached through a symlinked parent before planning repair", async () => {
    const plan = await planSensitivePermissionRepair(
      "/alias-home/.muse",
      [{ label: "secret.json", path: "/alias-home/.muse/secret.json" }],
      {
        lstat: async (path) => ({
          dev: 1,
          ino: path.endsWith("/.muse") ? 1 : 2,
          isFile: () => path.endsWith(".json"),
          isSymbolicLink: () => false,
          mode: path.endsWith(".json") ? 0o100644 : 0o40700
        }),
        realpath: async (path) => path === "/alias-home/.muse" ? "/physical-home/.muse" : path
      }
    );

    expect(plan.items).toEqual([
      expect.objectContaining({
        reason: expect.stringContaining("physical path"),
        state: "rejected"
      })
    ]);
  });

  it("rejects same-mode file and root identity swaps before chmod", async () => {
    const fileChmod = vi.fn(async () => undefined);
    const swappedFile = await applySensitivePermissionRepair({
      items: [repairItem("repair.json")],
      root: "/muse",
      rootIdentity
    }, {
      lstat: async (path) => ({
        dev: 1,
        ino: path === "/muse" ? 1 : 99,
        isFile: () => path !== "/muse",
        isSymbolicLink: () => false,
        mode: path === "/muse" ? 0o40700 : 0o100644
      }),
      open: async () => ({
        chmod: fileChmod,
        close: async () => undefined,
        stat: async () => ({
          dev: 1,
          ino: 99,
          isFile: () => true,
          isSymbolicLink: () => false,
          mode: 0o100644
        })
      }),
      realpath: async (path) => path
    });
    expect(swappedFile).toEqual(expect.objectContaining({
      applied: [],
      rejected: "target changed or is unsafe: repair.json"
    }));
    expect(fileChmod).not.toHaveBeenCalled();

    const rootChmod = vi.fn(async () => undefined);
    const open = vi.fn(async () => ({
      chmod: rootChmod,
      close: async () => undefined,
      stat: async () => ({
        dev: 1,
        ino: 2,
        isFile: () => true,
        isSymbolicLink: () => false,
        mode: 0o100644
      })
    }));
    const swappedRoot = await applySensitivePermissionRepair({
      items: [repairItem("repair.json")],
      root: "/muse",
      rootIdentity
    }, {
      lstat: async (path) => ({
        dev: 1,
        ino: path === "/muse" ? 77 : 2,
        isFile: () => path !== "/muse",
        isSymbolicLink: () => false,
        mode: path === "/muse" ? 0o40700 : 0o100644
      }),
      open,
      realpath: async (path) => path
    });
    expect(swappedRoot).toEqual(expect.objectContaining({
      applied: [],
      rejected: "plan root identity is missing or changed"
    }));
    expect(open).not.toHaveBeenCalled();
    expect(rootChmod).not.toHaveBeenCalled();
  });

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

describe("promptCacheHealth — Ollama's prefix cache is MEASURED, not guessed", () => {
  it("warns when a repeated prefix costs about as much as a cold one (the cache is defeated)", () => {
    // The real reading from a default Ollama install: 2274ms cold, 2139ms warm.
    const r = promptCacheHealth({ coldMs: 2274, tokens: 1622, warmMs: 2139 });
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("DEFEATED");
    expect(r.detail).toContain("OLLAMA_NUM_PARALLEL=1");
  });

  it("passes when the repeat is nearly free (the cache is alive)", () => {
    // The real reading with OLLAMA_NUM_PARALLEL=1: 3163ms cold, 66ms warm.
    const r = promptCacheHealth({ coldMs: 3163, tokens: 1622, warmMs: 66 });
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("prompt cache OK");
  });

  it("does not warn on a borderline-but-real speedup (half the cold cost)", () => {
    expect(promptCacheHealth({ coldMs: 1000, tokens: 500, warmMs: 400 }).status).toBe("ok");
    expect(promptCacheHealth({ coldMs: 1000, tokens: 500, warmMs: 600 }).status).toBe("warn");
  });

  it("never divides by zero on a degenerate probe", () => {
    expect(promptCacheHealth({ coldMs: 0, tokens: 0, warmMs: 0 }).status).toBe("warn");
  });
});
