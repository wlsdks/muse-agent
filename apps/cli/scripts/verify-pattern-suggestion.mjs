/**
 * FAST live battery for behavior→suggestion synthesis on LOCAL qwen — does the
 * pattern suggestion stay GROUNDED in the given facts (mention the real
 * recurring thing) on a strong pattern, and crucially return NONE (no
 * fabricated offer) when the facts are too thin? The negative case is the
 * whole risk of small-model proactive suggestion.
 *
 *   node apps/cli/scripts/verify-pattern-suggestion.mjs        (qwen3:8b)
 *
 * Exit 0 if every case passes, 1 otherwise. LOCAL OLLAMA QWEN ONLY.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import { synthesizePatternSuggestion } from "@muse/agent-core";

const model = process.argv[2] ?? "ollama/qwen3:8b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA QWEN ONLY"); process.exit(2); }
process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "muse-pattern-"));
process.env.MUSE_DEFAULT_MODEL = model;

const asm = createMuseRuntimeAssembly();
const modelProvider = asm.modelProvider;

// kind: "grounded" → non-empty AND mentions one of `needles` (didn't invent);
//       "none"     → undefined (declined; no fabricated offer).
const cases = [
  {
    name: "strong weekly-task pattern → grounded offer",
    kind: "grounded",
    needles: ["report", "보고서", "monday", "월요"],
    input: {
      category: "weekly-task",
      confidence: 0.86,
      fallbackSuggestion: "You often add a report task on Mondays.",
      groundedFacts: "weekly recurring task on Monday; recent: 'weekly report'; seen 4× over 5 weeks"
    }
  },
  {
    name: "strong time-of-day pattern → grounded offer",
    kind: "grounded",
    needles: ["journal", "일지", "evening", "저녁", "tuesday", "화요"],
    input: {
      category: "time-of-day-action",
      confidence: 0.8,
      fallbackSuggestion: "You usually journal on Tuesday evenings.",
      groundedFacts: "recurring action: Tuesday evening, area 'journal'; 5× over 5 days"
    }
  },
  {
    name: "NEGATIVE: thin facts → NONE (no fabricated offer)",
    kind: "none",
    input: {
      category: "time-of-day-action",
      confidence: 0.2,
      fallbackSuggestion: "",
      groundedFacts: "no clear recurring pattern; 1 occurrence; area 'misc'"
    }
  },
  {
    // A harder negative: two UNRELATED one-offs with no recurring day are not a
    // pattern — must NOT be dressed up as a recurring habit. STABLE 3/3 NONE.
    name: "NEGATIVE: two unrelated one-offs → NONE (no manufactured pattern)",
    kind: "none",
    input: {
      category: "weekly-task",
      confidence: 0.3,
      fallbackSuggestion: "",
      groundedFacts: "only 2 events, unrelated topics, no recurring day"
    }
  }
];

let failures = 0;
for (const c of cases) {
  const out = await synthesizePatternSuggestion(c.input, { model, modelProvider });
  let ok;
  if (c.kind === "grounded") {
    const said = (out ?? "").toLowerCase();
    ok = Boolean(out) && c.needles.some((n) => said.includes(n.toLowerCase()));
  } else {
    ok = out === undefined;
  }
  console.log(`${ok ? "PASS" : "FAIL"} — ${c.name}\n   out: ${JSON.stringify(out)}`);
  if (!ok) failures += 1;
}

console.log(failures === 0 ? `\nALL PASS (${cases.length}) on ${model}` : `\n${failures}/${cases.length} FAILED on ${model}`);
process.exit(failures === 0 ? 0 : 1);
