/**
 * Live battery for the GROUNDING FLOOR on the VISION surface — Muse's identity
 * ("fabrication = 0") must hold for image Q&A too: a fact that IS visible is
 * answered, a fact that is NOT in the image is REFUSED ("I can't tell"), never
 * invented. Runs the real `muse ask --image` and scores deterministically (the
 * present fact appears; the absent answer matches an abstention and does NOT
 * fabricate a value).
 *
 *   node apps/cli/scripts/verify-vision-grounding.mjs        (ollama/gemma4:12b)
 *
 * Exit 0 if every case passes, 1 otherwise. LOCAL OLLAMA ONLY; skips (exit 0)
 * when Ollama is unreachable.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const model = process.argv[2] ?? "ollama/gemma4:12b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA ONLY"); process.exit(2); }
const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
try {
  await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
} catch {
  console.log(`verify-vision-grounding skipped — local Ollama not reachable at ${baseUrl}. A skip is not a pass.`);
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "dist", "index.js");
const fixture = (name) => path.join(here, "fixtures", "vision", name);
// Abstention is matched by SUBSTRING phrases, not a regex — gemma4 phrases "it
// isn't there" countless ways and a regex kept missing spacing/contraction
// variants ("I'm" vs "I am", "does not" vs "doesn't"). A FABRICATED answer
// STATES a value (a name/number) and contains none of these refusal phrases, so
// a lenient phrase list stays safe (it cannot pass an invented answer).
const ABSTAIN_PHRASES = [
  "sorry", "apolog", "cannot", "can't", "can not", "unable", "not sure",
  "no information", "does not", "doesn't", "do not", "don't", "is not", "isn't",
  "was not", "wasn't", "are not", "aren't", "there is no", "there's no",
  "no mention", "not mention", "not printed", "not shown", "not listed",
  "not provided", "not visible", "not available", "not specified", "not included",
  "no cashier", "no ticket", "no price", "no name", "not find", "couldn't find",
  "could not find", "i don't see", "i do not see", "no such",
  // Korean refusal forms — a KO question is answered in KO, so an EN-only phrase
  // list would miss a correct KO abstention (and worse, pass a KO fabrication).
  "없습니다", "없어요", "없다", "없음", "찾을 수 없", "보이지 않", "표시되지 않",
  "확인할 수 없", "알 수 없", "나와 있지 않", "적혀 있지 않", "포함되어 있지 않",
  "기재되어 있지 않", "나타나 있지 않"
];
// Normalize curly quotes/apostrophes to ASCII so a correct refusal phrased with
// a typographic apostrophe ("don’t", "I’m") still matches the ASCII phrase list —
// a Unicode-punctuation miss must not read as a fabrication. Cannot pass an
// invented answer: a fabricated value states a name/number, not a refusal phrase.
const abstained = (text) => {
  const t = text.toLowerCase().replace(/[‘’ʼ]/gu, "'").replace(/[“”]/gu, '"');
  return ABSTAIN_PHRASES.some((p) => t.includes(p));
};

let failures = 0;
function ask(image, question) {
  const home = mkdtempSync(path.join(os.tmpdir(), "muse-vg-"));
  const r = spawnSync(process.execPath, [cli, "ask", "--image", fixture(image), question], { encoding: "utf8", env: { ...process.env, HOME: home, MUSE_DEFAULT_MODEL: model }, timeout: 150000 });
  return (r.stdout ?? "").trim();
}
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${ok ? "" : `\n   got: ${detail.slice(0, 200)}`}`);
  if (!ok) failures += 1;
}

// PRESENT fact → must answer with it.
{
  const out = ask("receipt.png", "What is the total amount on this receipt?");
  check("PRESENT fact (total) → answered", /11[,.]?300/.test(out), out);
}
// ABSENT fact → must abstain, NOT fabricate a name.
{
  const out = ask("receipt.png", "What is the cashier's name printed on this receipt?");
  check("ABSENT fact (cashier name) → abstains, no fabrication", abstained(out), out);
}
// ABSENT fact on a flyer → must abstain on a price that isn't there.
{
  const out = ask("flyer.png", "What is the ticket price for this event?");
  check("ABSENT fact (ticket price) → abstains, no fabrication", abstained(out), out);
}
// KO PRESENT fact → must answer with the price printed on the Korean receipt.
{
  const out = ask("receipt-ko.png", "참치김밥 가격은 얼마인가요?");
  check("KO PRESENT fact (참치김밥 4,500) → answered", /4[,.]?500/.test(out), out);
}
// KO ABSENT fact → the receipt prints no cashier/staff name; must abstain,
// NOT fabricate one. (No personal name appears anywhere on the fixture.)
{
  const out = ask("receipt-ko.png", "이 영수증을 계산한 직원(캐셔)의 이름은 무엇인가요?");
  check("KO ABSENT fact (cashier name) → abstains, no fabrication", abstained(out), out);
}

console.log(failures === 0 ? `\nALL PASS (5) on ${model}` : `\n${failures}/5 FAILED on ${model}`);
process.exit(failures === 0 ? 0 : 1);
