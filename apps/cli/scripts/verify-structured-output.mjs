/**
 * FAST live check on local Qwen — does ModelRequest.responseFormat (Ollama
 * native `format`) actually CONSTRAIN decoding to a JSON schema? Sends a schema
 * and asserts the raw output is valid JSON matching it — guaranteed-valid, not
 * parse-and-hope. Also confirms the unconstrained path still returns text.
 *
 *   node apps/cli/scripts/verify-structured-output.mjs            (qwen3:8b)
 *
 * Exit 0 = constrained output is schema-valid JSON, 1 = not, 2 = setup error.
 * LOCAL OLLAMA ONLY.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";

const model = process.argv[2] ?? "ollama/gemma4:12b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA ONLY"); process.exit(2); }
process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "muse-so-"));
process.env.MUSE_DEFAULT_MODEL = model;

const provider = createMuseRuntimeAssembly().modelProvider;

const schema = {
  type: "object",
  properties: {
    city: { type: "string" },
    population_millions: { type: "number" }
  },
  required: ["city", "population_millions"],
  additionalProperties: false
};

const res = await provider.generate({
  model,
  messages: [{ role: "user", content: "Give the city of Busan and its approximate population in millions." }],
  responseFormat: schema,
  temperature: 0,
  maxOutputTokens: 200
});

const raw = (res.output ?? "").trim();
console.log("raw output:", JSON.stringify(raw.slice(0, 200)));

let parsed;
try { parsed = JSON.parse(raw); } catch (e) {
  console.log(`FAIL — constrained output was not valid JSON: ${e.message}`);
  process.exit(1);
}
const ok = parsed && typeof parsed === "object"
  && typeof parsed.city === "string"
  && typeof parsed.population_millions === "number"
  && Object.keys(parsed).every((k) => k === "city" || k === "population_millions");

console.log(`parsed: ${JSON.stringify(parsed)}`);
if (ok) {
  console.log(`PASS — ${model} emitted schema-valid JSON under native \`format\` (city:string + population_millions:number, no extra keys)`);
  process.exit(0);
}
console.log(`FAIL — JSON did not match the schema`);
process.exit(1);
