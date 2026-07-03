import { describe, expect, it } from "vitest";

import {
  cloudSyncFolderCheck,
  episodeIndexHealth,
  messagingConfigCheck,
  notesIndexHealth,
  permissionModeDriftCheck,
  readSensitiveFileModes,
  recallCalibrationCheck,
  TOOL_OUTPUT_CAP_ADVISORY_FLOOR_CHARS,
  toolResultCapAdvisoryCheck,
  volatileMountCheck
} from "./commands-doctor-checks.js";

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
