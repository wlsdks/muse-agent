/**
 * FAST live battery for behavior→preference inference on LOCAL qwen — does a
 * correction that reveals a durable STYLE preference yield a grounded
 * preference, and crucially return NONE for a one-off FACTUAL fix (no
 * fabricated trait)? The negative case is the whole risk.
 *
 *   node apps/cli/scripts/verify-preference-inference.mjs   (qwen3:8b)
 *
 * Exit 0 if every case passes, 1 otherwise. LOCAL OLLAMA QWEN ONLY.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import { inferPreferenceFromCorrection } from "@muse/agent-core";

const model = process.argv[2] ?? "ollama/qwen3:8b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA QWEN ONLY"); process.exit(2); }
process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "muse-pref-"));
process.env.MUSE_DEFAULT_MODEL = model;

const asm = createMuseRuntimeAssembly();
const modelProvider = asm.modelProvider;

// kind "pref" → must infer a preference whose value hits a needle;
// kind "none" → must return undefined (one-off fact, no fabricated trait).
const cases = [
  {
    name: "EN style correction → inferred preference",
    kind: "pref",
    needles: ["bullet", "concise", "short", "list", "brief"],
    exchange: { request: "summarise the doc", priorAnswer: "Here is a long flowing paragraph that goes on...", correction: "no — give me concise bullet points, not prose" }
  },
  {
    name: "KO style correction → inferred preference",
    kind: "pref",
    needles: ["짧", "핵심", "concise", "brief", "bullet", "간결"],
    exchange: { request: "이거 정리해줘", priorAnswer: "장황한 문단이 이어집니다...", correction: "그게 아니라 짧게 핵심만 정리해줘" }
  },
  {
    name: "NEGATIVE: one-off factual fix → NONE (no fabricated trait)",
    kind: "none",
    exchange: { request: "when is my meeting?", priorAnswer: "Your meeting is at 3pm.", correction: "no, it's at 4pm" }
  }
];

let failures = 0;
for (const c of cases) {
  const pref = await inferPreferenceFromCorrection(c.exchange, { model, modelProvider });
  let ok;
  if (c.kind === "pref") {
    const v = (pref?.value ?? "").toLowerCase();
    ok = Boolean(pref) && c.needles.some((n) => v.includes(n.toLowerCase()));
  } else {
    ok = pref === undefined;
  }
  console.log(`${ok ? "PASS" : "FAIL"} — ${c.name}\n   pref: ${JSON.stringify(pref)}`);
  if (!ok) failures += 1;
}

console.log(failures === 0 ? `\nALL PASS (${cases.length}) on ${model}` : `\n${failures}/${cases.length} FAILED on ${model}`);
process.exit(failures === 0 ? 0 : 1);
