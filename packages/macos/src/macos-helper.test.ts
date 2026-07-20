/**
 * The helper bridge is a DEGRADATION surface: the binary may be missing (fresh
 * checkout), unpermitted (Accessibility not granted), wedged, or replaced by
 * something that is not our binary at all. Every one of those must arrive as a
 * typed result the caller can branch on — never a throw that fails a turn, and
 * never a silent empty answer that reads like "you have no windows open".
 */

import { describe, expect, it } from "vitest";

import { readMacHelper, readMacWindows, MAC_HELPER_READS } from "./macos-helper.js";
import type { MacCommandResult } from "./macos-exec.js";

const ok = (stdout: string): MacCommandResult => ({ exitCode: 0, stderr: "", stdout, timedOut: false });

describe("mac helper bridge — degradation", () => {
  it("reports unavailable (not a throw) when the binary is not installed", async () => {
    const result = await readMacHelper("windows");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("helper_unavailable");
  });

  it("treats an empty binaryPath the same as an absent one", async () => {
    const result = await readMacHelper("windows", { binaryPath: "   " });
    expect(result.ok === false && result.code).toBe("helper_unavailable");
  });

  it("surfaces a permission denial with the helper's own code, not a generic failure", async () => {
    const result = await readMacHelper("windows", {
      binaryPath: "/x/muse-mac-helper",
      run: async () => ok(JSON.stringify({ code: "ax_permission_denied", message: "grant it in System Settings", ok: false }))
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("ax_permission_denied");
    expect(result.ok === false && result.message).toContain("System Settings");
  });

  it("distinguishes a CRASH (non-zero exit) from the helper reporting its own error", async () => {
    // The helper exits 0 even for its own errors, so a non-zero exit means the
    // process itself died — a different thing to tell the user.
    const result = await readMacHelper("focus", {
      binaryPath: "/x/muse-mac-helper",
      run: async () => ({ exitCode: 134, stderr: "dyld: missing symbol", stdout: "", timedOut: false })
    });
    expect(result.ok === false && result.code).toBe("helper_crashed");
    expect(result.ok === false && result.message).toContain("dyld");
  });

  it("reports a timeout distinctly", async () => {
    const result = await readMacHelper("windows", {
      binaryPath: "/x/muse-mac-helper",
      run: async () => ({ exitCode: null, stderr: "", stdout: "", timedOut: true })
    });
    expect(result.ok === false && result.code).toBe("helper_timeout");
  });

  it("classifies a MISSING binary as unavailable, not as a spawn malfunction", async () => {
    // Verified against a real spawn: a path that does not exist surfaces as
    // ENOENT here, and "not installed" is the actionable thing to tell the
    // caller — it means fall back, whereas a spawn malfunction means something
    // is wrong with the install.
    const result = await readMacHelper("apps", {
      binaryPath: "/nope/muse-mac-helper",
      run: async () => { throw new Error("spawn /nope/muse-mac-helper ENOENT"); }
    });
    expect(result.ok === false && result.code).toBe("helper_unavailable");
    expect(result.ok === false && result.message).toContain("/nope/muse-mac-helper");
  });

  it("reports a genuine spawn failure distinctly from a missing binary", async () => {
    const result = await readMacHelper("apps", {
      binaryPath: "/x/muse-mac-helper",
      run: async () => { throw new Error("EACCES: permission denied"); }
    });
    expect(result.ok === false && result.code).toBe("helper_spawn_failed");
    expect(result.ok === false && result.message).toContain("EACCES");
  });

  it("rejects non-JSON output instead of guessing at it", async () => {
    // A different binary at that path, or a crash banner, must not be parsed
    // optimistically into a partial answer.
    for (const junk of ["", "   ", "not json", "<html>error</html>", "null", "[1,2]"]) {
      const result = await readMacHelper("apps", { binaryPath: "/x/h", run: async () => ok(junk) });
      expect(result.ok, `"${junk}" must not parse as ok`).toBe(false);
    }
  });
});

describe("mac helper bridge — success path", () => {
  it("returns the parsed payload for a well-formed response", async () => {
    const result = await readMacHelper("focus", {
      binaryPath: "/x/h",
      run: async () => ok(JSON.stringify({ app: "Safari", ok: true, windowTitle: "Muse" }))
    });
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.data.app).toBe("Safari");
  });

  it("passes the subcommand through as the single argv item", async () => {
    for (const read of MAC_HELPER_READS) {
      let argvSeen: readonly string[] = [];
      await readMacHelper(read, {
        binaryPath: "/x/h",
        run: async (_bin, argv) => { argvSeen = argv; return ok('{"ok":true}'); }
      });
      expect(argvSeen).toEqual([read]);
    }
  });

  it("readMacWindows returns typed windows", async () => {
    const payload = { ok: true, windows: [{ app: "Safari", focused: true, height: 800, title: "Muse", width: 1200, x: 0, y: 25 }] };
    const result = await readMacWindows({ binaryPath: "/x/h", run: async () => ok(JSON.stringify(payload)) });
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.windows[0]?.app).toBe("Safari");
    expect(result.ok === true && result.windows[0]?.width).toBe(1200);
  });

  it("readMacWindows rejects a response whose windows field is not an array", async () => {
    const result = await readMacWindows({ binaryPath: "/x/h", run: async () => ok('{"ok":true,"windows":"lots"}') });
    expect(result.ok === false && result.code).toBe("malformed_output");
  });

  it("readMacWindows forwards a failure rather than returning an empty list", async () => {
    // An empty window list and "we could not read your windows" are different
    // answers; conflating them would let Muse claim the screen is empty.
    const result = await readMacWindows({
      binaryPath: "/x/h",
      run: async () => ok(JSON.stringify({ code: "ax_permission_denied", message: "denied", ok: false }))
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("ax_permission_denied");
  });
});
