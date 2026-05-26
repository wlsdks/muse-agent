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

    // Sibling baselines don't change across candidates — measure once per target.
    const siblingBaselines = new Map();
    for (const sib of underTest) {
      if (sib.name === target.name) continue;
      siblingBaselines.set(sib.name, await selectionRate(provider, tools, sib.goldenPrompts, sib.name));
    }

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
          const sibAfter = await selectionRate(provider, renamed, sib.goldenPrompts, sib.name);
          if (sibAfter < (siblingBaselines.get(sib.name) ?? 0)) { siblingRegression = true; break; }
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
