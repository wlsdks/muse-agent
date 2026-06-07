/**
 * EFFICACY A/B for the reasoning principles (first-principles + contrarian,
 * docs/strategy/reasoning-principles.md). Verifying a mechanism RUNS is not the
 * same as verifying it WORKS — 진안's standing point. This measures the actual
 * EFFECT: it asks the SAME reasoning questions (whose answer must be DERIVED from
 * the notes, not recalled or guessed) through `muse ask` with the principles ON
 * (default) vs OFF (MUSE_ASK_REASONING_PRINCIPLES=0), then a blind qwen judge
 * picks which answer reasons better from the notes (order randomized to kill
 * position bias). Reports the win rate. An honest "tie" is a valid finding — it
 * tells us a 3-line prompt nudge is weak on a small model, and the real value is
 * the deterministic mechanisms.
 *
 *   node apps/cli/scripts/verify-reasoning-efficacy.mjs [repeats]
 *
 * LOCAL OLLAMA ONLY (qwen3:8b answerer + judge, nomic-embed-text index). Skips
 * (exit 0) if Ollama / a required model is unreachable — a skip is not a pass.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(fileURLToPath(new URL("../dist/index.js", import.meta.url)));
const baseUrl = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
const ANSWER_MODEL = process.env.MUSE_EFFICACY_MODEL ?? "gemma4:12b";
const repeats = Math.max(1, Number(process.argv[2] ?? "2") || 2);

async function reachable() {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 3000);
    const r = await fetch(`${baseUrl}/api/tags`, { signal: c.signal });
    clearTimeout(t);
    if (!r.ok) return false;
    const { models = [] } = await r.json();
    const names = models.map((m) => m.name ?? m.model ?? "");
    return names.some((n) => n.startsWith(ANSWER_MODEL.split(":")[0]));
  } catch { return false; }
}
if (!(await reachable())) {
  console.log(`verify-reasoning-efficacy skipped — local Ollama / ${ANSWER_MODEL} not reachable at ${baseUrl}. A skip is not a pass.`);
  process.exit(0);
}

// A corpus whose answers must be DERIVED (combine facts / apply a constraint),
// not recalled — exactly where "reason from first principles" should help.
const NOTES = {
  "net.md": "The office VPN tunnel caps packet MTU at 1380 bytes. The internal LAN uses 9000-byte jumbo frames for fast file copies.",
  "backup.md": "Nightly backups start at 2:00 and run for 3 hours. The morning report job starts at 6:00 and needs the backup finished first.",
  "plan.md": "Pro plan: 20 dollars per month for 1 seat. Team plan: 50 dollars per month for up to 5 seats."
};
const QUESTIONS = [
  "If I copy a file using 9000-byte jumbo frames over the VPN, will it go through smoothly?",
  "Could the nightly backup ever overrun into the 6:00 report job?",
  "Our team has 4 people — is one Team plan or 4 Pro seats cheaper?",
  "If our team grows to 7 people, can we still cover everyone with one Team plan?"
];
const NOTES_TEXT = Object.entries(NOTES).map(([f, t]) => `[${f}] ${t}`).join("\n");

function ask(question, principlesOn) {
  return new Promise((resolve) => {
    const home = mkdtempSync(join(tmpdir(), "eff-"));
    const notesDir = join(home, "notes");
    mkdirSync(notesDir, { recursive: true });
    mkdirSync(join(home, ".config"), { recursive: true });
    for (const [f, t] of Object.entries(NOTES)) writeFileSync(join(notesDir, f), `${t}\n`);
    const env = {
      ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"),
      MUSE_LOCAL_ONLY: "true", MUSE_NOTES_DIR: notesDir, MUSE_NOTES_INDEX_FILE: join(home, "ix.json"),
      MUSE_ASK_REASONING_PRINCIPLES: principlesOn ? "1" : "0"
    };
    execFile("node", [CLI, "notes", "reindex"], { env }, () => {
      execFile("node", [CLI, "ask", question], { env, timeout: 90_000, maxBuffer: 1 << 20 }, (_e, stdout = "") => {
        rmSync(home, { recursive: true, force: true });
        // Keep only the model prose lines (drop the citation-receipt/banner lines).
        const answer = stdout.split("\n").filter((l) => !/^\s*(•|\(|📎|⚖️|🔎|🔧|🔬|—)/.test(l) && l.trim().length > 0).join(" ").trim();
        resolve(answer.slice(0, 1200));
      });
    });
  });
}

async function judge(question, ansA, ansB) {
  const prompt = `Two AI answers to the same question, both grounded in the same personal notes.\n\nNotes:\n${NOTES_TEXT}\n\nQuestion: ${question}\n\nAnswer A:\n${ansA}\n\nAnswer B:\n${ansB}\n\nWhich answer reasons BETTER from the notes — more correct, more specific to the given facts, and actually DERIVING the conclusion (e.g. comparing the numbers / applying the constraint) rather than giving generic advice? Reply with ONLY one token: A, B, or TIE.`;
  try {
    const r = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      body: JSON.stringify({ model: ANSWER_MODEL, prompt, stream: false, options: { temperature: 0 } })
    });
    const { response = "" } = await r.json();
    const m = response.toUpperCase().match(/\b(A|B|TIE)\b/);
    return m ? m[1] : "TIE";
  } catch { return "TIE"; }
}

let onWins = 0, offWins = 0, ties = 0, n = 0;
for (let rep = 0; rep < repeats; rep += 1) {
  for (const q of QUESTIONS) {
    const onAns = await ask(q, true);
    const offAns = await ask(q, false);
    // Randomize which arm is "A" to kill position bias.
    const onIsA = (rep + QUESTIONS.indexOf(q)) % 2 === 0;
    const verdict = await judge(q, onIsA ? onAns : offAns, onIsA ? offAns : onAns);
    const winner = verdict === "TIE" ? "TIE" : (verdict === "A") === onIsA ? "ON" : "OFF";
    if (winner === "ON") onWins += 1; else if (winner === "OFF") offWins += 1; else ties += 1;
    n += 1;
    console.log(`  [${winner.padEnd(3)}] ${q.slice(0, 58)}`);
  }
}

console.log(`\nReasoning-principles efficacy over ${n} judgments (${repeats} repeat(s)):`);
console.log(`  principles ON wins : ${onWins}`);
console.log(`  baseline   OFF wins: ${offWins}`);
console.log(`  ties               : ${ties}`);
const net = onWins - offWins;
console.log(net > 0
  ? `\n=> Principles HELP (+${net} net wins). The mechanism has a measurable positive effect.`
  : net < 0
    ? `\n=> Principles HURT (${net} net). Honest negative result — reconsider/refine.`
    : `\n=> NEUTRAL (tie). A 3-line nudge is weak on a small model; the deterministic mechanisms carry the value.`);
process.exit(0);
