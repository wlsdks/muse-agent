# Tool-name Calibration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a reusable, PA-Tool-style calibration tool that discovers the tool name local Qwen spontaneously expects and recommends a rename only when it measurably improves one-shot selection (validated by the same signal `eval:tools` trusts).

**Architecture:** A pure, model-free, deterministic core in `packages/tools` (name normalization, peakedness tally, margin-guarded rename decision, report formatting) — fully unit-tested — plus an Ollama-gated `scripts/calibrate-tool-names.mjs` (`pnpm calibrate:tools`) that wires the core to a live generative-naming probe and an `eval:tools`-style selection-rate measurement. The script is report-only; renames are human-applied.

**Tech Stack:** TypeScript (ESM, strict), Vitest, Node ESM scripts, `OllamaProvider` from `@muse/model`, local Ollama qwen3:8b.

---

## File Structure

- Create: `packages/tools/src/tool-name-calibration.ts` — the pure core (5 exported functions + 3 interfaces).
- Modify: `packages/tools/src/index.ts` — re-export the new core symbols (append near the other `export { … } from "./*.js"` lines around line 845+).
- Create: `packages/tools/test/tool-name-calibration.test.ts` — deterministic unit tests (no model).
- Create: `scripts/calibrate-tool-names.mjs` — the Ollama-gated calibration runner.
- Modify: `package.json` (repo root) — add the `calibrate:tools` script next to `eval:tools`.

The pure core and its test change together and own all decision logic. The script owns only live I/O wiring. Renaming the actual time tool (if warranted) touches `packages/tools/src/muse-tools-time.ts` and `scripts/eval-tool-selection.mjs` golden data — handled in the final task, gated on a live calibration result.

---

## Task 1: `normalizeToolName` — clean one candidate string to canonical snake_case

**Files:**
- Create: `packages/tools/src/tool-name-calibration.ts`
- Test: `packages/tools/test/tool-name-calibration.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

import { normalizeToolName } from "../src/tool-name-calibration.js";

describe("normalizeToolName", () => {
  it("lowercases and underscores spaces/hyphens", () => {
    expect(normalizeToolName("Get Current Time")).toBe("get_current_time");
    expect(normalizeToolName("what-is-the-time")).toBe("what_is_the_time");
  });

  it("strips surrounding quotes/backticks and trailing punctuation", () => {
    expect(normalizeToolName("`fetch_now`.")).toBe("fetch_now");
    expect(normalizeToolName("'Time_Now'")).toBe("time_now");
  });

  it("collapses repeated underscores and trims edge underscores", () => {
    expect(normalizeToolName("__time__now__")).toBe("time_now");
  });

  it("returns empty string for unusable input", () => {
    expect(normalizeToolName("")).toBe("");
    expect(normalizeToolName("123abc")).toBe("");
    expect(normalizeToolName("!!!")).toBe("");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @muse/tools test -- tool-name-calibration`
Expected: FAIL — cannot find module `../src/tool-name-calibration.js` / `normalizeToolName` is not a function.

- [ ] **Step 3: Write the minimal implementation**

Create `packages/tools/src/tool-name-calibration.ts`:

```ts
/**
 * PA-Tool style tool-name calibration (arXiv 2510.07248): discover the
 * name the local model spontaneously expects and recommend a rename only
 * when it beats the current name's one-shot selection rate by a margin.
 * This module is the pure, model-free decision core; the live probe +
 * selection measurement live in scripts/calibrate-tool-names.mjs.
 */

export function normalizeToolName(raw: string): string {
  if (typeof raw !== "string") return "";
  let s = raw.trim().toLowerCase();
  s = s.replace(/^[`'"]+|[`'"]+$/g, "").trim();
  s = s.replace(/[\s-]+/g, "_");
  s = s.replace(/[^a-z0-9_]/g, "");
  s = s.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return /^[a-z][a-z0-9_]*$/.test(s) ? s : "";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @muse/tools test -- tool-name-calibration`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/tools/src/tool-name-calibration.ts packages/tools/test/tool-name-calibration.test.ts
git commit -m "feat(tools): normalizeToolName for tool-name calibration core"
```

---

## Task 2: `extractCandidateNames` — pull plausible tool names from one model reply

**Files:**
- Modify: `packages/tools/src/tool-name-calibration.ts`
- Test: `packages/tools/test/tool-name-calibration.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/tools/test/tool-name-calibration.test.ts`:

```ts
import { extractCandidateNames } from "../src/tool-name-calibration.js";

describe("extractCandidateNames", () => {
  it("extracts a backticked verb_noun from prose", () => {
    expect(extractCandidateNames("I'd name it `get_current_time`.")).toEqual(["get_current_time"]);
  });

  it("extracts multiple multi-part names in order, deduped", () => {
    expect(extractCandidateNames("Maybe current_time or time_now")).toEqual(["current_time", "time_now"]);
  });

  it("falls back to a single bare token reply", () => {
    expect(extractCandidateNames("clock")).toEqual(["clock"]);
  });

  it("returns [] when the reply is prose with no name-like token", () => {
    expect(extractCandidateNames("no idea")).toEqual([]);
    expect(extractCandidateNames("")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @muse/tools test -- tool-name-calibration`
Expected: FAIL — `extractCandidateNames` is not a function.

- [ ] **Step 3: Write the minimal implementation**

Append to `packages/tools/src/tool-name-calibration.ts`:

```ts
export function extractCandidateNames(raw: string): string[] {
  if (typeof raw !== "string") return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (name: string): void => {
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  };
  const multi = raw.match(/[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)+/g) ?? [];
  for (const m of multi) push(normalizeToolName(m));
  if (out.length > 0) return out;
  const trimmed = raw.trim().replace(/^[`'"]+|[`'"]+$/g, "").trim();
  if (trimmed.length > 0 && trimmed.length <= 40 && !/\s/.test(trimmed)) {
    push(normalizeToolName(trimmed));
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @muse/tools test -- tool-name-calibration`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/tools/src/tool-name-calibration.ts packages/tools/test/tool-name-calibration.test.ts
git commit -m "feat(tools): extractCandidateNames from a model naming-probe reply"
```

---

## Task 3: `tallyPeakedness` — frequency distribution over per-reply primary names

**Files:**
- Modify: `packages/tools/src/tool-name-calibration.ts`
- Test: `packages/tools/test/tool-name-calibration.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the test file:

```ts
import { tallyPeakedness } from "../src/tool-name-calibration.js";

describe("tallyPeakedness", () => {
  it("counts and shares the dominant name first", () => {
    const rows = tallyPeakedness(["time_now", "time_now", "clock_now"]);
    expect(rows).toEqual([
      { name: "time_now", count: 2, share: 2 / 3 },
      { name: "clock_now", count: 1, share: 1 / 3 }
    ]);
  });

  it("drops invalid/empty samples and divides by valid count", () => {
    const rows = tallyPeakedness(["", "time_now", "!!!", "time_now"]);
    expect(rows).toEqual([{ name: "time_now", count: 2, share: 1 }]);
  });

  it("returns [] when there are no valid samples", () => {
    expect(tallyPeakedness(["", "!!!"])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @muse/tools test -- tool-name-calibration`
Expected: FAIL — `tallyPeakedness` is not a function.

- [ ] **Step 3: Write the minimal implementation**

Append to `packages/tools/src/tool-name-calibration.ts`:

```ts
export interface PeakednessRow {
  readonly name: string;
  readonly count: number;
  readonly share: number;
}

export function tallyPeakedness(samples: readonly string[]): PeakednessRow[] {
  const counts = new Map<string, number>();
  let totalValid = 0;
  for (const sample of samples) {
    const name = normalizeToolName(sample);
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
    totalValid += 1;
  }
  if (totalValid === 0) return [];
  const rows = [...counts.entries()].map(([name, count]) => ({
    name,
    count,
    share: count / totalValid
  }));
  rows.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return rows;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @muse/tools test -- tool-name-calibration`
Expected: PASS (11 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/tools/src/tool-name-calibration.ts packages/tools/test/tool-name-calibration.test.ts
git commit -m "feat(tools): tallyPeakedness frequency distribution"
```

---

## Task 4: `recommendRename` — margin-guarded decision with collision/regression rejection

**Files:**
- Modify: `packages/tools/src/tool-name-calibration.ts`
- Test: `packages/tools/test/tool-name-calibration.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the test file:

```ts
import { recommendRename } from "../src/tool-name-calibration.js";

describe("recommendRename", () => {
  const base = { current: "current_clock_value", baselineRate: 0.4, margin: 0.1 };

  it("recommends a candidate that beats baseline by the margin", () => {
    const d = recommendRename({
      ...base,
      candidates: [{ name: "time_now", rate: 0.95, siblingRegression: false, collidesWithSibling: false }]
    });
    expect(d).toEqual({ recommend: true, from: "current_clock_value", to: "time_now", reason: expect.stringContaining("0.95") });
  });

  it("does not recommend when the lift is below the margin", () => {
    const d = recommendRename({
      current: "time_now",
      baselineRate: 0.8,
      margin: 0.1,
      candidates: [{ name: "clock_now", rate: 0.85, siblingRegression: false, collidesWithSibling: false }]
    });
    expect(d.recommend).toBe(false);
    expect(d.to).toBeUndefined();
    expect(d.reason).toContain("margin");
  });

  it("rejects a candidate that collides with a sibling", () => {
    const d = recommendRename({
      ...base,
      candidates: [{ name: "time_diff", rate: 0.99, siblingRegression: false, collidesWithSibling: true }]
    });
    expect(d.recommend).toBe(false);
    expect(d.reason).toContain("collision");
  });

  it("rejects a candidate that regresses a sibling", () => {
    const d = recommendRename({
      ...base,
      candidates: [{ name: "now_clock", rate: 0.95, siblingRegression: true, collidesWithSibling: false }]
    });
    expect(d.recommend).toBe(false);
    expect(d.reason).toContain("regress");
  });

  it("picks the highest-rate qualifying candidate", () => {
    const d = recommendRename({
      ...base,
      candidates: [
        { name: "time_now", rate: 0.7, siblingRegression: false, collidesWithSibling: false },
        { name: "clock_reading", rate: 0.9, siblingRegression: false, collidesWithSibling: false }
      ]
    });
    expect(d.to).toBe("clock_reading");
  });

  it("reports no valid candidate when the candidate list is empty", () => {
    const d = recommendRename({ ...base, candidates: [] });
    expect(d.recommend).toBe(false);
    expect(d.reason).toContain("no valid candidate");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @muse/tools test -- tool-name-calibration`
Expected: FAIL — `recommendRename` is not a function.

- [ ] **Step 3: Write the minimal implementation**

Append to `packages/tools/src/tool-name-calibration.ts`:

```ts
export interface RenameCandidate {
  readonly name: string;
  readonly rate: number;
  readonly siblingRegression: boolean;
  readonly collidesWithSibling: boolean;
}

export interface RenameDecisionInput {
  readonly current: string;
  readonly baselineRate: number;
  readonly candidates: readonly RenameCandidate[];
  readonly margin: number;
}

export interface RenameDecision {
  readonly recommend: boolean;
  readonly from: string;
  readonly to?: string;
  readonly reason: string;
}

export function recommendRename(input: RenameDecisionInput): RenameDecision {
  const { current, baselineRate, candidates, margin } = input;
  const threshold = baselineRate + margin;
  if (candidates.length === 0) {
    return { recommend: false, from: current, reason: "no valid candidate discovered" };
  }
  const qualifying = candidates
    .filter((c) => c.name !== current && c.rate >= threshold && !c.siblingRegression && !c.collidesWithSibling)
    .sort((a, b) => b.rate - a.rate);
  if (qualifying.length > 0) {
    const best = qualifying[0];
    return {
      recommend: true,
      from: current,
      to: best.name,
      reason: `selection rate ${best.rate.toFixed(2)} beats baseline ${baselineRate.toFixed(2)} by >= margin ${margin.toFixed(2)}`
    };
  }
  const metMargin = candidates.filter((c) => c.name !== current && c.rate >= threshold);
  if (metMargin.some((c) => c.collidesWithSibling)) {
    return { recommend: false, from: current, reason: "best candidate rejected: name collision with sibling tool" };
  }
  if (metMargin.some((c) => c.siblingRegression)) {
    return { recommend: false, from: current, reason: "best candidate rejected: it regresses a sibling tool's selection" };
  }
  return { recommend: false, from: current, reason: `no candidate beats baseline ${baselineRate.toFixed(2)} by margin ${margin.toFixed(2)}` };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @muse/tools test -- tool-name-calibration`
Expected: PASS (17 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/tools/src/tool-name-calibration.ts packages/tools/test/tool-name-calibration.test.ts
git commit -m "feat(tools): recommendRename margin guard with collision/regression rejection"
```

---

## Task 5: `formatCalibrationReport` + export the core from the package index

**Files:**
- Modify: `packages/tools/src/tool-name-calibration.ts`
- Modify: `packages/tools/src/index.ts`
- Test: `packages/tools/test/tool-name-calibration.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the test file:

```ts
import { formatCalibrationReport, type CalibrationResult } from "../src/tool-name-calibration.js";

describe("formatCalibrationReport", () => {
  const result: CalibrationResult = {
    tool: "time_now",
    job: "return the current wall-clock time",
    peakedness: [{ name: "time_now", count: 8, share: 0.8 }],
    baselineRate: 0.9,
    candidates: [{ name: "current_time", rate: 0.92, siblingRegression: false, collidesWithSibling: false }],
    decision: { recommend: false, from: "time_now", reason: "no candidate beats baseline 0.90 by margin 0.10" }
  };

  it("returns the json passthrough unchanged", () => {
    expect(formatCalibrationReport([result]).json).toEqual([result]);
  });

  it("renders the tool name, peakedness leader and decision in the text", () => {
    const { text } = formatCalibrationReport([result]);
    expect(text).toContain("time_now");
    expect(text).toContain("80%");
    expect(text).toContain("no candidate beats baseline");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @muse/tools test -- tool-name-calibration`
Expected: FAIL — `formatCalibrationReport` / `CalibrationResult` not exported.

- [ ] **Step 3: Write the minimal implementation**

Append to `packages/tools/src/tool-name-calibration.ts`:

```ts
export interface CalibrationResult {
  readonly tool: string;
  readonly job: string;
  readonly peakedness: readonly PeakednessRow[];
  readonly baselineRate: number;
  readonly candidates: readonly RenameCandidate[];
  readonly decision: RenameDecision;
}

export function formatCalibrationReport(results: readonly CalibrationResult[]): {
  text: string;
  json: readonly CalibrationResult[];
} {
  const lines: string[] = [];
  for (const r of results) {
    const leader = r.peakedness[0];
    const peak = leader ? `${leader.name} ${(leader.share * 100).toFixed(0)}%` : "(none)";
    lines.push(`■ ${r.tool}  baseline=${(r.baselineRate * 100).toFixed(0)}%  model-preferred=${peak}`);
    for (const c of r.candidates) {
      const flags = [c.collidesWithSibling ? "collision" : "", c.siblingRegression ? "sibling-regress" : ""].filter(Boolean).join(",");
      lines.push(`    candidate ${c.name}: ${(c.rate * 100).toFixed(0)}%${flags ? ` [${flags}]` : ""}`);
    }
    const verdict = r.decision.recommend ? `RENAME → ${r.decision.to}` : "keep current";
    lines.push(`    → ${verdict} (${r.decision.reason})`);
  }
  return { text: lines.join("\n"), json: results };
}
```

Then append to `packages/tools/src/index.ts` (after the existing `export { … } from "./*.js"` block near line 845):

```ts
export {
  normalizeToolName,
  extractCandidateNames,
  tallyPeakedness,
  recommendRename,
  formatCalibrationReport,
  type PeakednessRow,
  type RenameCandidate,
  type RenameDecisionInput,
  type RenameDecision,
  type CalibrationResult
} from "./tool-name-calibration.js";
```

- [ ] **Step 4: Run the test + build to verify**

Run: `pnpm --filter @muse/tools test -- tool-name-calibration`
Expected: PASS (19 tests total).

Run: `pnpm --filter @muse/tools build`
Expected: exit 0 (tsc clean — confirms the index re-export type names match).

- [ ] **Step 5: Commit**

```bash
git add packages/tools/src/tool-name-calibration.ts packages/tools/src/index.ts packages/tools/test/tool-name-calibration.test.ts
git commit -m "feat(tools): formatCalibrationReport + export calibration core"
```

---

## Task 6: The Ollama-gated calibration script + `calibrate:tools` npm script

**Files:**
- Create: `scripts/calibrate-tool-names.mjs`
- Modify: `package.json` (root)

- [ ] **Step 1: Add the npm script**

In root `package.json` `"scripts"`, add immediately after the `"eval:tools"` line:

```json
"calibrate:tools": "pnpm --filter @muse/model build && pnpm --filter @muse/tools build && node scripts/calibrate-tool-names.mjs",
```

- [ ] **Step 2: Create the script**

Create `scripts/calibrate-tool-names.mjs`:

```js
/**
 * calibrate:tools — PA-Tool style tool-name calibration (arXiv 2510.07248).
 *
 * For the observed confusable time-tool set, (1) probe the local model for the
 * name it spontaneously expects for each tool's job (peakedness), (2) measure
 * the one-shot selection rate of each candidate name within the sibling set
 * (the same signal eval:tools trusts), and (3) recommend a rename only when a
 * candidate beats the current name by a margin without colliding with or
 * regressing a sibling. REPORT-ONLY — it never edits source.
 *
 * LOCAL OLLAMA ONLY. Skips (exit 0) when Ollama is unreachable.
 *
 *   pnpm calibrate:tools
 *   pnpm calibrate:tools -- --json
 *   MUSE_CALIBRATE_PROBE_SAMPLES=12 MUSE_CALIBRATE_REPEAT=5 \
 *   MUSE_CALIBRATE_MARGIN=0.10 MUSE_EVAL_MODEL=qwen3:8b pnpm calibrate:tools
 */

import { OllamaProvider } from "../packages/model/dist/index.js";
import {
  extractCandidateNames,
  formatCalibrationReport,
  recommendRename,
  tallyPeakedness
} from "../packages/tools/dist/tool-name-calibration.js";

const MODEL = process.env.MUSE_EVAL_MODEL ?? "qwen3:8b";
const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
const PROBE_SAMPLES = Math.max(3, Math.trunc(Number(process.env.MUSE_CALIBRATE_PROBE_SAMPLES ?? "12")));
const REPEAT = Math.max(1, Math.trunc(Number(process.env.MUSE_CALIBRATE_REPEAT ?? "5")));
const MARGIN = Number(process.env.MUSE_CALIBRATE_MARGIN ?? "0.10");
const TOP_K = 3;
const JSON_OUT = process.argv.includes("--json");

async function ollamaReachable() {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const body = await res.json();
    return (body?.models ?? []).some((m) => typeof m?.name === "string" && m.name.includes(MODEL.replace(/^ollama\//, "")));
  } catch {
    return false;
  }
}

async function buildTimeSet() {
  const time = await import("../packages/tools/dist/muse-tools-time.js");
  const now = () => new Date();
  const instances = [
    time.createTimeNowTool(now), time.createTimeDiffTool(), time.createTimeAddTool(),
    time.createTimeRelativeTool(now), time.createNextWeekdayTool(now), time.createCronForDatetimeTool()
  ];
  const tools = instances.map((t) => ({ name: t.definition.name, description: t.definition.description, inputSchema: t.definition.inputSchema }));
  // Tools under test = the historically-confused trio; siblings = the full set.
  const underTest = [
    { name: "time_now", goldenPrompts: ["What time is it now?", "What day of the week is it right now in Seoul?", "What's today's date?"] },
    { name: "time_diff", goldenPrompts: ["How many hours between 9am and 5:30pm today?", "How many days are between 2026-05-01 and 2026-06-15?"] },
    { name: "next_weekday_date", goldenPrompts: ["When is the next Friday?", "What's the date of next Monday?"] }
  ];
  return { tools, underTest };
}

async function probeName(provider, job) {
  const samples = [];
  for (let i = 0; i < PROBE_SAMPLES; i += 1) {
    let reply = "";
    try {
      const response = await provider.generate({
        model: MODEL,
        messages: [{ role: "user", content: `Name a single tool/function in snake_case (verb_noun) that does ONLY this job: ${job}\nReply with ONLY the name, nothing else.` }],
        temperature: 0.7,
        maxOutputTokens: 24
      });
      reply = response.output ?? "";
    } catch {
      reply = "";
    }
    samples.push(extractCandidateNames(reply)[0] ?? "");
  }
  return tallyPeakedness(samples);
}

async function selectionRate(provider, tools, goldenPrompts, expectedName) {
  let passes = 0;
  let total = 0;
  for (const prompt of goldenPrompts) {
    for (let run = 0; run < REPEAT; run += 1) {
      total += 1;
      try {
        const response = await provider.generate({ model: MODEL, messages: [{ role: "user", content: prompt }], tools, temperature: 0, maxOutputTokens: 160 });
        const picked = (response.toolCalls ?? [])[0]?.name;
        if (picked === expectedName) passes += 1;
      } catch {
        // a thrown run counts as a miss
      }
    }
  }
  return total === 0 ? 0 : passes / total;
}

function withRenamed(tools, from, to) {
  return tools.map((t) => (t.name === from ? { ...t, name: to } : t));
}

async function main() {
  if (!(await ollamaReachable())) {
    console.log(`calibrate:tools skipped — Ollama (${OLLAMA_BASE}) or model ${MODEL} unreachable. Start \`ollama serve\` with ${MODEL}.`);
    return;
  }
  const provider = new OllamaProvider({ defaultModel: MODEL });
  const { tools, underTest } = await buildTimeSet();
  const siblingNames = new Set(tools.map((t) => t.name));
  const results = [];

  for (const target of underTest) {
    const def = tools.find((t) => t.name === target.name);
    if (!def) continue;
    const peakedness = await probeName(provider, def.description);
    const baselineRate = await selectionRate(provider, tools, target.goldenPrompts, target.name);

    const candidateNames = peakedness.map((p) => p.name).filter((n) => n !== target.name).slice(0, TOP_K);
    const candidates = [];
    for (const name of candidateNames) {
      const collidesWithSibling = siblingNames.has(name);
      let rate = 0;
      let siblingRegression = false;
      if (!collidesWithSibling) {
        const renamed = withRenamed(tools, target.name, name);
        rate = await selectionRate(provider, renamed, target.goldenPrompts, name);
        for (const sib of underTest) {
          if (sib.name === target.name) continue;
          const sibBefore = await selectionRate(provider, tools, sib.goldenPrompts, sib.name);
          const sibAfter = await selectionRate(provider, renamed, sib.goldenPrompts, sib.name);
          if (sibAfter < sibBefore) { siblingRegression = true; break; }
        }
      }
      candidates.push({ name, rate, siblingRegression, collidesWithSibling });
    }
    const decision = recommendRename({ current: target.name, baselineRate, candidates, margin: MARGIN });
    results.push({ tool: target.name, job: def.description, peakedness, baselineRate, candidates, decision });
  }

  const report = formatCalibrationReport(results);
  if (JSON_OUT) {
    console.log(JSON.stringify(report.json, null, 2));
  } else {
    console.log(`\ncalibrate:tools — model ${MODEL}, probe×${PROBE_SAMPLES}, selection×${REPEAT}, margin ${MARGIN}\n`);
    console.log(report.text);
    const renames = results.filter((r) => r.decision.recommend);
    console.log(`\n${renames.length} rename(s) warranted${renames.length ? ": " + renames.map((r) => `${r.decision.from}→${r.decision.to}`).join(", ") : " (names already model-peaked)"}.`);
  }
}

await main();
```

- [ ] **Step 3: Verify the script loads and is gated (no live model needed for this step)**

Run: `node scripts/calibrate-tool-names.mjs` (works whether or not Ollama is up).
Expected: either the "calibrate:tools skipped — Ollama … unreachable" line (exit 0), OR a printed calibration report. Either output proves the script wires the core correctly and the gate works. (The `pnpm calibrate:tools` form additionally builds `@muse/model` + `@muse/tools` first.)

- [ ] **Step 4: Commit**

```bash
git add scripts/calibrate-tool-names.mjs package.json
git commit -m "feat(tools): calibrate:tools — Ollama-gated tool-name calibration runner"
```

---

## Task 7: Live calibration run + apply any warranted rename + prove `eval:tools`

> This task is gated on a reachable local Ollama qwen3:8b. If Ollama is down, fixing the environment is the prerequisite (per `testing.md` — a skip is not proof). Do NOT fabricate a rename: apply one ONLY if the live report recommends it.

- [ ] **Step 1: Run the live calibration**

Run: `pnpm calibrate:tools`
Expected: a printed report ending with either "N rename(s) warranted: …" or "(names already model-peaked)".

- [ ] **Step 2: Capture the baseline `eval:tools` score**

Run: `pnpm eval:tools`
Expected: PASS; note the printed `real-time-tools (confusable set)` percentage as the baseline.

- [ ] **Step 3a: If a rename is warranted — apply it**

For each recommended `from→to`:
- In `packages/tools/src/muse-tools-time.ts`, change that tool's `name: "<from>"` to `name: "<to>"` and update any in-description cross-reference to the old name (e.g. the `time_now` description's "that is next_weekday_date" line).
- In `scripts/eval-tool-selection.mjs`, update the `expectTool: "<from>"` golden entries (both the real-tools and time-tools scenarios) to `"<to>"`.
- Search for other references: `grep -rn "<from>" packages apps scripts --include=*.ts --include=*.mjs` and update test/golden references (NOT historical doc/CHANGELOG text).

Run: `pnpm --filter @muse/tools build && pnpm --filter @muse/tools test`
Expected: exit 0.

Run: `pnpm eval:tools`
Expected: PASS, with the `real-time-tools` percentage **>= the Step 2 baseline**.

- [ ] **Step 3b: If NO rename is warranted — record the verified outcome**

No source change. The deliverable is the calibration tool itself; Task-1–6 unit tests already prove it recommends a fix when one exists (fixture i) and stays conservative otherwise. `eval:tools` remains green at the Step 2 baseline.

- [ ] **Step 4: Final gates**

Run: `pnpm lint`
Expected: 0 errors / 0 warnings.

Run: `pnpm --filter @muse/tools test`
Expected: PASS.

- [ ] **Step 5: Update the capability ledger + commit**

Append one line to `docs/goals/CAPABILITIES.md`:

```
- [Reach] Tool names are calibrated to the local model's expectation — `pnpm calibrate:tools` probes qwen3:8b for the name it spontaneously expects per tool's job (peakedness) and recommends a rename only when it beats the current name's one-shot selection rate by a margin without colliding with / regressing a sibling (report-only) — `packages/tools` tool-name-calibration.test.ts (normalize/extract/tally + the margin-guard decision: recommends a warranted rename, holds below margin, rejects collision/regression) + `pnpm calibrate:tools` live qwen3:8b run + `pnpm eval:tools` confusable time-set >= baseline — PA-Tool (arXiv 2510.07248)
```

Commit (include `muse-tools-time.ts` + `eval-tool-selection.mjs` only if Step 3a applied):

```bash
git add docs/goals/CAPABILITIES.md
# plus, only if a rename was applied:
# git add packages/tools/src/muse-tools-time.ts scripts/eval-tool-selection.mjs
git commit -m "feat(tools): calibrate confusable time-tool names to the local model (PA-Tool)"
```

---

## Self-Review Notes

- **Spec coverage:** core (Task 1–5) ↔ spec §Architecture(a); script + gating (Task 6) ↔ §Architecture(b)+§Data flow+§Error handling; verification (Task 7) ↔ §Testing & verification plan steps 1–4; self-verification fixtures (Task 4) ↔ spec §Testing fixtures i–iv (i=recommend warranted, ii=below margin, iii=collision, iv=regression). YAGNI/non-goals respected (no `aliases` field, no all-35 sweep, no eval refactor, report-only).
- **Type consistency:** `RenameCandidate`, `RenameDecision`, `PeakednessRow`, `CalibrationResult` defined in Task 3/4/5 and reused verbatim by the script (Task 6) and the index export (Task 5). Function names (`normalizeToolName`, `extractCandidateNames`, `tallyPeakedness`, `recommendRename`, `formatCalibrationReport`) are identical across tasks, index export, and script import.
- **No placeholders:** every code step shows complete code; every run step states the exact command + expected output. Task 7 is intentionally branch-conditional (3a/3b) on a live result — both branches are fully specified, which is correctness, not a placeholder.
