/**
 * Live battery for GROUNDED VISION ACTIONS — does gemma4 read a real document
 * image and route it to the right draft-first action? Asserts the terminal
 * classification + the key extracted fields for each kind (receipt / event /
 * contact), the capability `muse ask --image --auto` ships. Fixtures are checked
 * in under fixtures/vision/ (rendered receipts/flyers/cards) so this is portable
 * and CI-gateable — not a one-off manual check.
 *
 *   node apps/cli/scripts/verify-vision-actions.mjs        (ollama/gemma4:12b)
 *
 * Exit 0 if every case passes, 1 otherwise. LOCAL OLLAMA ONLY; skips (exit 0)
 * when Ollama is unreachable — a skip is NOT a pass.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OllamaProvider } from "@muse/model";

import { classifyVisionAction } from "../dist/vision-actions.js";

const model = process.argv[2] ?? "ollama/gemma4:12b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA ONLY"); process.exit(2); }
const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
try {
  await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
} catch {
  console.log(`verify-vision-actions skipped — local Ollama not reachable at ${baseUrl}. A skip is not a pass.`);
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(path.join(here, "fixtures", "vision", name)).toString("base64");
const provider = new OllamaProvider({});

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${ok ? "" : `\n   got: ${detail}`}`);
  if (!ok) failures += 1;
}

const cases = [
  {
    name: "receipt → route note, merchant+total extracted",
    file: "receipt.png",
    grounded: ["merchant"],
    assert: (a) => a.route === "note" && /blue bottle/i.test(String(a.fields.merchant ?? "")) && /11[,.]?300/.test(String(a.fields.total ?? ""))
  },
  {
    name: "flyer → route calendar, title+startsAt+location extracted",
    file: "flyer.png",
    grounded: ["title", "location"],
    assert: (a) => a.route === "calendar" && /jazz/i.test(String(a.fields.title ?? "")) && /18/.test(String(a.fields.startsAt ?? "")) && /itaewon/i.test(String(a.fields.location ?? ""))
  },
  {
    name: "business card → route contact, name+phone extracted",
    file: "card.png",
    grounded: ["name"],
    assert: (a) => a.route === "contact" && /sarah kim/i.test(String(a.fields.name ?? "")) && /9876/.test(String(a.fields.phone ?? "") + String(a.fields.email ?? ""))
  },
  {
    name: "document → route note, title + transcribed body",
    file: "document.png",
    grounded: ["title"],
    assert: (a) => a.route === "note" && /kickoff|action/i.test(String(a.fields.title ?? "")) && /api contract|staging|design review/i.test(String(a.fields.body ?? ""))
  }
];

for (const c of cases) {
  const action = await classifyVisionAction(provider, { model, imageBase64: fixture(c.file), mimeType: "image/png" });
  const routedOk = !("ok" in action && action.ok === false) && c.assert(action);
  // The grounding gate must NOT false-drop a field that IS visible in the fixture
  // (over-drop would block a legit --apply). Assert the headline field(s) ground.
  const overDropped = (c.grounded ?? []).filter((f) => Array.isArray(action.unverified) && action.unverified.includes(f));
  const ok = routedOk && overDropped.length === 0;
  check(c.name, ok, `${JSON.stringify(action)}${overDropped.length ? ` — GROUNDING OVER-DROPPED: ${overDropped.join(",")}` : ""}`);
}

console.log(failures === 0 ? `\nALL PASS (${cases.length}) on ${model}` : `\n${failures}/${cases.length} FAILED on ${model}`);
process.exit(failures === 0 ? 0 : 1);
