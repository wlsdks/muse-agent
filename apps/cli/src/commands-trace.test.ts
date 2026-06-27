import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { formatRunDetail, formatRunList, parseRunEvent, readLocalRuns } from "./commands-trace.js";

const event = (over: Record<string, unknown> = {}) => JSON.stringify({
  grounded: "grounded", message: "what is my VPN MTU?", recordedAt: "2026-06-28T10:00:00Z", success: true,
  response: { response: "1380 [from vpn.md]", toolsUsed: [], retrieval: [{ source: "vpn.md", score: 0.62 }] },
  ...over
});

describe("muse trace — local run inspector (time-travel)", () => {
  it("parseRunEvent extracts query, answer, retrieval, grounding from the LAST line", () => {
    const d = parseRunEvent("r1", `${event({ recordedAt: "old" })}\n${event()}`)!;
    expect(d.query).toBe("what is my VPN MTU?");
    expect(d.answer).toContain("1380");
    expect(d.grounded).toBe("grounded");
    expect(d.retrieval).toEqual([{ source: "vpn.md", score: 0.62 }]);
    expect(d.recordedAt).toBe("2026-06-28T10:00:00Z"); // last line wins
  });

  it("parseRunEvent tolerates an empty / corrupt file", () => {
    expect(parseRunEvent("r", "")).toBeUndefined();
    expect(parseRunEvent("r", "{bad json")).toBeUndefined();
  });

  it("readLocalRuns lists runs most-recent first; missing dir → []", async () => {
    expect(await readLocalRuns("/no/such/dir")).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), "muse-runs-"));
    try {
      writeFileSync(join(dir, "r-old.jsonl"), event({ recordedAt: "2026-06-27T10:00:00Z" }));
      writeFileSync(join(dir, "r-new.jsonl"), event({ recordedAt: "2026-06-28T10:00:00Z" }));
      const runs = await readLocalRuns(dir);
      expect(runs.map((r) => r.runId)).toEqual(["r-new", "r-old"]);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("formatRunDetail surfaces the retrieved sources+scores AND the checkpoint steps", () => {
    const out = formatRunDetail(parseRunEvent("r1", event())!, [{ step: 0, phase: "start" }, { step: 2, phase: "act" }]);
    expect(out).toContain("retrieved (why this answer)");
    expect(out).toContain("0.6200  vpn.md");
    expect(out).toContain("0:start → 2:act");
  });

  it("formatRunList marks a misgrounded / failed run distinctly", () => {
    const out = formatRunList([
      { runId: "g", query: "q", grounded: "grounded", success: true, recordedAt: "z" },
      { runId: "m", query: "q", grounded: "misgrounded", success: true, recordedAt: "z" }
    ]);
    expect(out).toContain("✓ g");
    expect(out).toContain("⚠ m");
  });
});
