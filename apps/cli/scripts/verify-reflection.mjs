/**
 * FAST live battery for /reflect on LOCAL qwen — does the cross-session
 * synthesis produce a GROUNDED insight when a thread recurs, and crucially
 * stay EMPTY (no fabricated pattern) when sessions share nothing? EN + KO +
 * the negative case that is the whole risk of small-model synthesis.
 *
 *   node apps/cli/scripts/verify-reflection.mjs            (qwen3:8b)
 *
 * Exit 0 if every case passes, 1 otherwise. LOCAL OLLAMA ONLY.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";

const model = process.argv[2] ?? "ollama/gemma4:12b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA ONLY"); process.exit(2); }
process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "muse-reflect-"));
process.env.MUSE_DEFAULT_MODEL = model;

const { synthesizeReflection } = await import("../dist/chat-reflection.js");
const asm = createMuseRuntimeAssembly();
const provider = asm.modelProvider;

const ep = (endedAt, summary, topics) => ({ endedAt, summary, topics });

// kind: "grounded" → must be non-empty AND mention one of `needles`;
//       "empty"    → must be "" (no fabricated pattern).
const cases = [
  {
    name: "EN recurring unresolved thread → grounded",
    kind: "grounded",
    needles: ["budget", "q3"],
    episodes: [
      ep("2026-05-01", "Reviewed the Q3 budget draft but didn't finalize the numbers.", ["Q3 budget"]),
      ep("2026-05-08", "Came back to the Q3 budget; still deciding on the marketing line item.", ["Q3 budget"]),
      ep("2026-05-15", "Discussed the Q3 budget again, agreed to revisit next week.", ["Q3 budget"])
    ]
  },
  {
    name: "KO recurring thread → grounded",
    kind: "grounded",
    needles: ["이사", "moving", "move", "집"],
    episodes: [
      ep("2026-05-02", "이사 갈 동네를 알아봤지만 아직 못 정함.", ["이사 준비"]),
      ep("2026-05-09", "이사 준비로 이삿짐 견적을 비교함.", ["이사 준비"]),
      ep("2026-05-16", "이사 날짜를 다음 달로 미룸.", ["이사 준비"])
    ]
  },
  {
    name: "NEGATIVE: unrelated one-offs → empty (no fabricated pattern)",
    kind: "empty",
    episodes: [
      ep("2026-05-03", "Fixed a flat bike tire.", ["bike"]),
      ep("2026-05-10", "Watched a documentary about volcanoes.", ["film"]),
      ep("2026-05-17", "Tried a new ramen place downtown.", ["food"])
    ]
  }
];

let failures = 0;
for (const c of cases) {
  const insight = await synthesizeReflection({ provider, model, episodes: c.episodes });
  const said = insight.toLowerCase();
  let ok;
  if (c.kind === "grounded") ok = insight.length > 0 && c.needles.some((n) => said.includes(n.toLowerCase()));
  else ok = insight.length === 0;
  console.log(`${ok ? "PASS" : "FAIL"} — ${c.name}\n   insight: ${JSON.stringify(insight)}`);
  if (!ok) failures += 1;
}

console.log(failures === 0 ? `\nALL PASS (${cases.length}) on ${model}` : `\n${failures}/${cases.length} FAILED on ${model}`);
process.exit(failures === 0 ? 0 : 1);
