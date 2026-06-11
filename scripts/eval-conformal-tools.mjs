/**
 * eval:conformal-tools — KnowNo-style conformal tool selection, OFFLINE report.
 *
 * Frames tool choice as MCQA (options A..F incl. "none"), reads the option
 * probabilities from the first content token's top_logprobs (Ollama >=0.30.6),
 * and calibrates a leave-one-out conformal threshold at alpha so each prompt
 * gets a PREDICTION SET of tools: |set|=1 -> call it, |set|>1 -> the runtime
 * would CLARIFY instead of guessing (KnowNo, arXiv 2307.01928 — statistical
 * task-success guarantee). Report-only: no runtime behavior changes until the
 * numbers justify wiring.
 *
 *   node scripts/eval-conformal-tools.mjs          (gemma4:12b, alpha 0.1)
 *
 * LOCAL OLLAMA ONLY; skips (exit 0) when unreachable.
 */
import { OllamaProvider } from "../packages/model/dist/index.js";

const MODEL = process.env.MUSE_EVAL_MODEL ?? "gemma4:12b";
const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
const ALPHA = Number(process.env.MUSE_CONFORMAL_ALPHA ?? "0.1");

const TOOLS = [
  { desc: "Current date/time lookup. Use for 'what time/date is it now'; not for date arithmetic.", name: "time_now" },
  { desc: "Duration between TWO given timestamps. Not for 'how long ago from now'.", name: "time_diff" },
  { desc: "Add a duration to a given base date. Use for 'N days after X'.", name: "time_add" },
  { desc: "How long ago/until a single timestamp is, relative to NOW.", name: "time_relative" },
  { desc: "Date of the next named weekday. Use for 'when is next Friday'.", name: "next_weekday_date" },
  { desc: "Cron expression for a specific datetime.", name: "cron_for_datetime" }
];
const NONE_LABEL = "none of these (no tool needed)";

const CASES = [
  { expect: "time_now", prompt: "What time is it now?" },
  { expect: "time_now", prompt: "What day of the week is it right now in Seoul?" },
  { expect: "time_now", prompt: "오늘 며칠이야?" },
  { expect: "time_diff", prompt: "How many hours between 9am and 5:30pm today?" },
  { expect: "time_add", prompt: "What is 3 days after 2026-05-26?" },
  { expect: "time_relative", prompt: "How long ago was 2026-05-01 from now?" },
  { expect: "time_relative", prompt: "2026-05-01이 얼마나 지난 거야?" },
  { expect: "next_weekday_date", prompt: "When is the next Friday?" },
  { expect: "next_weekday_date", prompt: "다음 주 금요일이 며칠이야?" },
  { expect: "cron_for_datetime", prompt: "Give me a cron expression for 2026-12-25 08:00." },
  { expect: "none", prompt: "시간 참 빨리 간다, 벌써 금요일이네." },
  { expect: "none", prompt: "What a beautiful Friday morning, isn't it?" },
  { expect: "none", prompt: "오늘 정말 긴 하루였어." },
  { expect: "none", prompt: "Time really does fly when you're having fun." }
];

const LETTERS = ["A", "B", "C", "D", "E", "F", "G"];

function buildMcqaPrompt(userPrompt) {
  const options = [...TOOLS.map((tool, i) => `${LETTERS[i]}) ${tool.name} — ${tool.desc}`), `${LETTERS[TOOLS.length]}) ${NONE_LABEL}`];
  return [
    "Which ONE option correctly handles the user's request? Reply with the single option letter only.",
    "",
    `Request: "${userPrompt}"`,
    "",
    ...options
  ].join("\n");
}

const labelOf = (index) => (index < TOOLS.length ? TOOLS[index].name : "none");

/** Option probabilities from the first content token's top_logprobs. */
function optionProbs(rawLogprobs) {
  const probs = new Map();
  for (const entry of rawLogprobs ?? []) {
    if (typeof entry.token !== "string" || entry.token.startsWith("<|")) continue;
    for (const alt of entry.top_logprobs ?? []) {
      const match = /^[\s*("']*([A-G])\b/iu.exec(alt.token ?? "");
      if (!match) continue;
      const letter = match[1].toUpperCase();
      const index = LETTERS.indexOf(letter);
      if (index < 0 || index > TOOLS.length) continue;
      const p = Math.exp(alt.logprob ?? -Infinity);
      probs.set(index, Math.max(probs.get(index) ?? 0, p));
    }
    if (probs.size > 0) break; // first content token only
  }
  const total = [...probs.values()].reduce((a, b) => a + b, 0);
  if (total <= 0) return probs;
  return new Map([...probs.entries()].map(([k, v]) => [k, v / total]));
}

async function main() {
  try {
    const resp = await fetch(`${OLLAMA_BASE}/api/tags`);
    if (!resp.ok) throw new Error(String(resp.status));
  } catch {
    console.log(`conformal-tools skipped — Ollama unreachable at ${OLLAMA_BASE}.`);
    return;
  }
  const provider = new OllamaProvider({ defaultModel: MODEL });

  const scoredCases = [];
  for (const testCase of CASES) {
    const res = await provider.generate({
      logprobs: true,
      maxOutputTokens: 4,
      messages: [{ content: buildMcqaPrompt(testCase.prompt), role: "user" }],
      model: MODEL,
      temperature: 0,
      topLogprobs: 20
    });
    const probs = optionProbs(res.raw?.logprobs);
    const trueIndex = testCase.expect === "none" ? TOOLS.length : TOOLS.findIndex((tool) => tool.name === testCase.expect);
    scoredCases.push({ ...testCase, probs, trueP: probs.get(trueIndex) ?? 0 });
  }

  // Leave-one-out split conformal: nonconformity = 1 - p(true option).
  let covered = 0;
  let clarify = 0;
  let wrongConfident = 0;
  const setSizes = [];
  const lines = [];
  for (let i = 0; i < scoredCases.length; i += 1) {
    const cal = scoredCases.filter((_, j) => j !== i).map((c) => 1 - c.trueP).sort((a, b) => a - b);
    const rank = Math.ceil((cal.length + 1) * (1 - ALPHA)) - 1;
    const q = cal[Math.min(rank, cal.length - 1)];
    const testCase = scoredCases[i];
    const set = [...testCase.probs.entries()].filter(([, p]) => p >= 1 - q).map(([k]) => labelOf(k));
    const trueLabel = testCase.expect;
    const inSet = set.includes(trueLabel);
    if (inSet) covered += 1;
    if (set.length > 1) clarify += 1;
    if (set.length === 1 && set[0] !== trueLabel) wrongConfident += 1;
    setSizes.push(set.length);
    lines.push(`| ${testCase.prompt.slice(0, 42)} | ${trueLabel} | {${set.join(", ")}} | ${inSet ? "✓" : "✗"} |`);
  }

  const n = scoredCases.length;
  console.log(`# KnowNo conformal tool selection — offline report (${MODEL}, α=${ALPHA}, LOO over ${n} cases)\n`);
  console.log("| prompt | true | prediction set | covered |");
  console.log("|---|---|---|---|");
  for (const line of lines) console.log(line);
  console.log("");
  console.log(`- coverage (true label in set): ${covered}/${n} (target ≥ ${(1 - ALPHA) * 100}%)`);
  console.log(`- would-have-clarified (|set|>1): ${clarify}/${n}`);
  console.log(`- wrong-but-confident (|set|=1, wrong): ${wrongConfident}/${n}`);
  console.log(`- mean set size: ${(setSizes.reduce((a, b) => a + b, 0) / n).toFixed(2)}`);
}

await main();
