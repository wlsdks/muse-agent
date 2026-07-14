/**
 * Live battery for the MISGROUNDING false-positive guard (the trace-label edge
 * shipped in cab66be1). A "grounded" gate verdict gets a trace-time faithfulness
 * probe that can DOWNGRADE it to `misgrounded` so a confident GROUNDED!=TRUE
 * answer becomes error-analysis fuel instead of a hidden success. The danger is
 * the OTHER direction: false-flagging a genuinely-grounded answer as misgrounded
 * would POISON the fuel. Three false-positive shapes were found and fixed on the
 * live `muse ask` path (a conversational follow-up question, a cross-lingual
 * KO-answer/EN-note, and Muse's own `[from x.md]` citation marker); this battery
 * locks them in: a real grounded answer must stay `grounded`, never `misgrounded`.
 *
 *   node apps/cli/scripts/verify-misgrounding.mjs        (ollama/gemma4:12b)
 *
 * Exit 0 if every grounded answer keeps its label, 1 on a false-positive
 * regression. LOCAL OLLAMA ONLY; skips (exit 0) when Ollama / the embed model
 * is unreachable.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const model = process.argv[2] ?? "ollama/gemma4:12b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA ONLY"); process.exit(2); }
const baseUrl = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
try {
  await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
} catch {
  console.log(`verify-misgrounding skipped — local Ollama not reachable at ${baseUrl}. A skip is not a pass.`);
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "dist", "index.js");

// A scratch workspace + an ENGLISH note; the KO query exercises the cross-lingual
// probe path (KO answer scored against EN evidence), the EN query exercises the
// citation-marker + follow-up-question shapes — the three live-found false positives.
const ws = mkdtempSync(path.join(os.tmpdir(), "muse-misground-"));
const notesDir = path.join(ws, "notes");
mkdirSync(notesDir, { recursive: true });
writeFileSync(path.join(notesDir, "deadline.md"), "The project deadline is March 3rd 2026. The team lead is Sarah Chen. The budget is 50000 dollars.\n");

const env = {
  ...process.env,
  HOME: ws,
  MUSE_DEFAULT_MODEL: model,
  MUSE_NOTES_DIR: notesDir,
  MUSE_NOTES_INDEX_FILE: path.join(ws, "notes-index.json")
};

function askAndReadLabel(query) {
  const r = spawnSync(process.execPath, [cli, "ask", query], { cwd: ws, encoding: "utf8", env, timeout: 180000 });
  const runsDir = path.join(ws, ".muse", "runs");
  let files = [];
  try { files = readdirSync(runsDir).filter((f) => f.endsWith(".jsonl")); } catch { /* none yet */ }
  if (files.length === 0) return { label: "<no-trace>", answer: (r.stdout ?? "").trim() };
  files.sort(); // cli-<timestamp>.jsonl — lexicographic = chronological
  const newest = path.join(runsDir, files[files.length - 1]);
  const line = readFileSync(newest, "utf8").trim().split("\n").filter(Boolean).pop() ?? "{}";
  let label = "<parse-fail>";
  try { label = JSON.parse(line).grounded ?? "<null>"; } catch { /* keep parse-fail */ }
  return { label, answer: (r.stdout ?? "").trim() };
}

let failures = 0;
function check(name, res, evidenceRe) {
  // The invariant is TWO-sided: (1) a genuinely-grounded answer is labelled
  // `grounded`, never `misgrounded`; AND (2) the answer actually carries the
  // evidence VALUE. Asserting the label alone lets an always-"grounded" labeler
  // pass even when the answer is wrong/empty — so require the evidence token
  // (Sarah / March 3rd, in either language) to be present in the answer too.
  const groundedLabel = res.label === "grounded";
  const hasEvidence = evidenceRe.test(res.answer);
  const ok = groundedLabel && hasEvidence;
  console.log(`${ok ? "PASS" : "FAIL"} — ${name} (trace grounded=${res.label}, evidence-in-answer=${hasEvidence})`);
  if (!ok) failures += 1;
}

// KO deadline query → the date March 3rd (EN "march 3" or KO "3월 3일"); EN team-lead
// query → the name Sarah (language-invariant).
check("KO query over EN note grounds (cross-lingual) → grounded + names the deadline", askAndReadLabel("프로젝트 마감일이 언제야?"), /march\s*3|3\s*월\s*3|3\/3/iu);
check("EN query (citation marker + follow-up question) → grounded + names the team lead", askAndReadLabel("Who is the team lead?"), /sarah/iu);

console.log(failures === 0 ? `\nALL PASS (2) — no false misgrounding on ${model}` : `\n${failures}/2 FAILED on ${model} — a grounded answer was mislabelled (fuel-poisoning regression)`);
process.exit(failures === 0 ? 0 : 1);
