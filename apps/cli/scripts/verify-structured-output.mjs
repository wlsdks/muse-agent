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
const schemaExact = (value) =>
  value && typeof value === "object"
  && typeof value.city === "string"
  && typeof value.population_millions === "number"
  && Object.keys(value).every((k) => k === "city" || k === "population_millions");

const ok = schemaExact(parsed);
console.log(`parsed: ${JSON.stringify(parsed)}`);

// Control arm: the SAME question with NO responseFormat. If the UNCONSTRAINED
// model already emits the exact 2-key schema object on its own, then the
// constrained arm's clean JSON proves NOTHING about `responseFormat` (a no-op
// `format` would look identical). A model left to its own devices answers in
// prose, so the control must NOT be schema-exact — that gap is what attributes
// the constrained arm's guaranteed JSON to `responseFormat`, not model luck.
const control = await provider.generate({
  model,
  messages: [{ role: "user", content: "Give the city of Busan and its approximate population in millions." }],
  temperature: 0,
  maxOutputTokens: 200
});
const controlRaw = (control.output ?? "").trim();
let controlParsed;
try { controlParsed = JSON.parse(controlRaw); } catch { /* prose, as expected */ }
const controlIsSchemaExact = schemaExact(controlParsed);
console.log(`control (unconstrained) output: ${JSON.stringify(controlRaw.slice(0, 200))}`);

if (ok && !controlIsSchemaExact) {
  console.log(`PASS — ${model} emitted schema-valid JSON ONLY under native \`format\`; the unconstrained control did not (responseFormat is doing the constraining)`);
  process.exit(0);
}
if (!ok) {
  console.log(`FAIL — constrained JSON did not match the schema`);
} else {
  console.log(`FAIL — the unconstrained control ALSO produced schema-exact JSON, so this run cannot attribute the output to responseFormat`);
}
process.exit(1);
