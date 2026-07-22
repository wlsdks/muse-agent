import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { attachContinuityRunReferences, formatRunDetail, formatRunList, parseRunEvent, readLocalRuns } from "./commands-trace.js";

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
    expect(out).toContain("diagnostic-only / not linkable");
  });

  it("emits a Continuity locator only for a strict internally-bound trace", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "muse-trace-continuity-"));
    const runsDir = join(workspace, ".muse", "runs");
    mkdirSync(runsDir, { recursive: true });
    try {
      const strict = {
        apiUrl: "http://127.0.0.1:3030",
        grounded: "grounded",
        message: "strict query",
        model: null,
        recordedAt: "2026-07-22T00:00:00.000Z",
        response: { response: "strict answer", toolsUsed: [] },
        runId: "run_strict",
        source: "cli.local",
        success: true,
        type: "chat.completed"
      };
      writeFileSync(join(runsDir, "run_strict.jsonl"), `${JSON.stringify(strict)}\n`);
      writeFileSync(join(runsDir, "run_legacy.jsonl"), event({ recordedAt: "2026-07-21T00:00:00.000Z" }));
      const runs = await attachContinuityRunReferences(workspace, await readLocalRuns(runsDir));
      expect(runs.find((run) => run.runId === "run_strict")?.continuityReference).toMatch(/^muse-run-v1:/u);
      expect(runs.find((run) => run.runId === "run_legacy")?.continuityReference).toBeUndefined();
      const output = formatRunList(runs);
      expect(output).toContain("continuity: muse-run-v1:");
      expect(output).toContain("diagnostic-only / not linkable");
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("keeps diagnostic trace output available when workspace authority cannot be a locator", async () => {
    const runs = [{ grounded: "grounded", query: "q", recordedAt: "2026-07-22T00:00:00.000Z", runId: "run_exact", success: true }];
    await expect(attachContinuityRunReferences("/", runs)).resolves.toEqual(runs);
    expect(formatRunList(await attachContinuityRunReferences("/", runs))).toContain("diagnostic-only / not linkable");
  });
});

describe("muse trace — GROUNDED≠TRUE integrity signals in the detail", () => {
  const ev = (response: Record<string, unknown>) => JSON.stringify({
    grounded: "grounded", message: "q", recordedAt: "2026-06-28T10:00:00Z", success: true,
    response: { response: "answer", toolsUsed: [], ...response }
  });

  it("parseRunEvent surfaces sourceCheck when a 'grounded' answer rested on untrusted/uncited sources", () => {
    const d = parseRunEvent("r", ev({ sourceCheck: { untrustedOnly: true, citationUnsupported: false, citationUncited: true } }))!;
    expect(d.sourceCheck).toEqual({ untrustedOnly: true, citationUnsupported: false, citationUncited: true });
  });

  it("parseRunEvent omits sourceCheck when the answer is clean (no false noise)", () => {
    const d = parseRunEvent("r", ev({ sourceCheck: { untrustedOnly: false, citationUnsupported: false, citationUncited: false } }))!;
    expect(d.sourceCheck).toBeUndefined();
  });

  it("parseRunEvent surfaces decomposition trust signals (fan-out contradiction / truncation)", () => {
    const d = parseRunEvent("r", ev({ decomposition: { subtaskCount: 3, truncated: true, subtaskConflicts: ["A vs B"] } }))!;
    expect(d.decomposition).toEqual({ truncated: true, subtaskConflicts: ["A vs B"] });
  });

  it("formatRunDetail shows the ⚠ grounded≠true caveat AND the fan-out caveat", () => {
    const out = formatRunDetail(parseRunEvent("r", ev({
      sourceCheck: { untrustedOnly: true, citationUnsupported: false, citationUncited: false },
      decomposition: { subtaskCount: 2, truncated: false, synthesisIncomplete: ["task X"] }
    }))!, []);
    expect(out).toContain("⚠ grounded≠true: rested only on UNTRUSTED sources");
    expect(out).toContain("⚠ fan-out: dropped 1 sub-result(s)");
  });

  it("formatRunDetail shows NO caveat line for a clean grounded answer", () => {
    expect(formatRunDetail(parseRunEvent("r", ev({}))!, [])).not.toContain("grounded≠true");
  });
});
