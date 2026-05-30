/**
 * LIVE battery for GROUNDED REFLECTION ("dreaming") on LOCAL qwen3:8b. Muse's
 * idle-time memory consolidation (Generative Agents reflection, arXiv:2304.03442)
 * with the identity twist: every synthesised insight must be GROUNDED in the
 * user's real episodes — the model cannot invent a source.
 *
 * Proves on the real local model:
 *   - a clear recurring theme across episodes → ≥1 reflection whose insight names
 *     the theme and whose sources are the right REAL episode ids.
 *   - the grounding invariant holds for EVERY returned reflection: each sourceId
 *     is an actual input id and supportCount ≥ 2 (no confabulated self-model).
 *
 *   node apps/cli/scripts/verify-reflection-synthesis.mjs   (qwen3:8b)
 *
 * Exit 0 if every case passes; skip (exit 0) if Ollama is unreachable. LOCAL
 * OLLAMA QWEN ONLY.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import { synthesizeReflections } from "@muse/agent-core";

const model = process.argv[2] ?? "ollama/qwen3:8b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA QWEN ONLY"); process.exit(2); }
const baseUrl = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");

async function reachable() {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 3_000);
    const r = await fetch(`${baseUrl}/api/tags`, { signal: c.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}
if (!(await reachable())) {
  console.log(`verify-reflection-synthesis skipped — local Ollama not reachable at ${baseUrl}. A skip is not a pass.`);
  process.exit(0);
}

process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "muse-reflect-"));
process.env.MUSE_DEFAULT_MODEL = model;
const modelProvider = createMuseRuntimeAssembly().modelProvider;

// A clear recurring theme (home networking / VPN) across 3 of 5 episodes; the
// other two are unrelated distractors.
const inputs = [
  { id: "ep-101", text: "Fixed the office VPN handshake timeout by setting the MTU to 1380 on wg0 and restarting wireguard." },
  { id: "ep-102", text: "Wireguard kept dropping again on the home router; re-tuned the MTU and it stabilised." },
  { id: "ep-103", text: "Spent the evening debugging why the home network drops packets under load — looks like the same MTU/VPN issue." },
  { id: "ep-104", text: "Booked a dentist cleaning for the first week of June." },
  { id: "ep-105", text: "Drafted the Q3 budget memo and shared it with finance." }
];
const validIds = new Set(inputs.map((i) => i.id));
const networkingIds = new Set(["ep-101", "ep-102", "ep-103"]);

const reflections = await synthesizeReflections(inputs, { model, modelProvider, minSupport: 2 });

let failures = 0;
const fail = (msg) => { console.log(`FAIL — ${msg}`); failures += 1; };
const pass = (msg) => console.log(`PASS — ${msg}`);

// 1) Grounding invariant — holds for EVERY reflection (the honesty guarantee).
const allGrounded = reflections.every((r) =>
  r.sourceIds.length >= 2 && r.sourceIds.every((s) => validIds.has(s)) && r.supportCount === r.sourceIds.length);
allGrounded
  ? pass(`grounding invariant holds for all ${reflections.length.toString()} reflection(s) — every source is real, support ≥ 2`)
  : fail(`a reflection cited an invented/insufficient source: ${JSON.stringify(reflections)}`);

// 2) The recurring networking theme is found and grounded in the right episodes.
const themed = reflections.find((r) =>
  /vpn|mtu|wireguard|network|router|packet/i.test(r.insight)
  && r.sourceIds.filter((s) => networkingIds.has(s)).length >= 2);
themed
  ? pass(`found the recurring networking theme, grounded in real episodes → ${JSON.stringify(themed.sourceIds)}`)
  : fail(`expected a networking-themed reflection grounded in ≥2 of ep-101/102/103; got ${JSON.stringify(reflections)}`);

// 3) Honesty on THIN input: even across UNRELATED one-off episodes (no strong
//    recurring theme), every returned reflection must STILL satisfy the
//    grounding invariant — it may generalise loosely ("regular maintenance"),
//    but it must never invent a source id or inflate support. STABLE 3/3.
const unrelated = [
  { id: "ux-1", text: "Booked a dentist cleaning for the first week of June." },
  { id: "ux-2", text: "Drafted the Q3 budget memo and shared it with finance." },
  { id: "ux-3", text: "Watered the balcony plants and repotted the basil." },
  { id: "ux-4", text: "Renewed the car registration online." }
];
const unrelatedIds = new Set(unrelated.map((i) => i.id));
const thinReflections = await synthesizeReflections(unrelated, { minSupport: 2, model, modelProvider });
const thinGrounded = thinReflections.every((r) =>
  r.sourceIds.length >= 2 && r.sourceIds.every((s) => unrelatedIds.has(s)) && r.supportCount === r.sourceIds.length);
thinGrounded
  ? pass(`thin-input honesty: all ${thinReflections.length.toString()} reflection(s) on unrelated episodes stay grounded (no invented source / inflated support)`)
  : fail(`a thin-input reflection broke the grounding invariant: ${JSON.stringify(thinReflections)}`);

console.log(failures === 0 ? `\nALL PASS on ${model}` : `\n${failures} FAILED on ${model}`);
process.exit(failures === 0 ? 0 : 1);
