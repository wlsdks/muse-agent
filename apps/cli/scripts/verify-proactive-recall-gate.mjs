/**
 * LIVE battery for Muse's NORTH STAR — confidence-gated PROACTIVE recall — on
 * LOCAL Ollama embeddings (nomic-embed-text). Proactivity reuses the SAME CRAG
 * gate as the wedge: when a deterministic trigger fires (a due task / imminent
 * meeting), Muse looks in your own corpus and appends a cited "here's the
 * related doc" finding ONLY when the recall is CONFIDENT — and STAYS SILENT
 * otherwise. This is the property that earns proactivity: it must prove it can
 * keep quiet.
 *
 * Drives the real `createConfidenceGatedInvestigator` (the proactive loop's
 * `investigate` seam) against a tiny personal corpus with REAL local embeddings
 * — NOT the smoke:live API server (which stalls on this PC):
 *   - trigger topic IN corpus     → a cited finding ("📎 Related … [source]").
 *   - trigger topic OFF-topic     → undefined (SILENCE), never a stray guess.
 *
 *   node apps/cli/scripts/verify-proactive-recall-gate.mjs   (nomic-embed-text)
 *
 * Exit 0 if every case passes; skip (exit 0) if Ollama / the embed model is
 * unreachable. LOCAL OLLAMA ONLY.
 */
import { createOllamaEmbedder } from "@muse/autoconfigure";
import { createConfidenceGatedInvestigator } from "@muse/agent-core";

const embedModel = process.argv[2] ?? "nomic-embed-text";
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
  console.log(`verify-proactive-recall-gate skipped — local Ollama not reachable at ${baseUrl}. A skip is not a pass.`);
  process.exit(0);
}

const embed = createOllamaEmbedder(embedModel);
try {
  await embed("probe");
} catch (cause) {
  console.log(`verify-proactive-recall-gate skipped — embed model '${embedModel}' unavailable (${cause instanceof Error ? cause.message : String(cause)}). Try: ollama pull ${embedModel}`);
  process.exit(0);
}

// A tiny PERSONAL corpus — the kind a proactive heads-up should be able to draw on.
const corpus = [
  { source: "meeting-q3.md", text: "Q3 budget review prep: bring the revised forecast and the headcount plan; finance wants the variance table before the meeting." },
  { source: "dentist.md", text: "Dentist appointment — they said to floss the lower-left molar area and bring the new insurance card." },
  { source: "trip-jeju.md", text: "Jeju trip packing: rain jacket, the hiking boots, and the camera battery charger. Hotel check-in is 3pm." }
];

const investigate = createConfidenceGatedInvestigator({ chunks: corpus, embed, topK: 3 });

const cases = [
  { name: "trigger IN corpus → cited finding surfaces", kind: "surface", item: { title: "Q3 budget review", kind: "calendar", factSheet: "" }, needles: ["📎 Related", "meeting-q3.md"], notSources: ["dentist.md", "trip-jeju.md"] },
  { name: "trigger IN corpus (2) → cited finding surfaces", kind: "surface", item: { title: "Dentist appointment", kind: "calendar", factSheet: "" }, needles: ["📎 Related", "dentist.md"], notSources: ["meeting-q3.md", "trip-jeju.md"] },
  { name: "trigger OFF-topic → SILENCE (no stray guess)", kind: "silent", item: { title: "Quarterly tax filing deadline", kind: "task", factSheet: "" } },
  // A second plausible-but-absent personal trigger: proactivity is UNSOLICITED,
  // so a genuinely-unrelated task must stay silent, never surface an adjacent
  // note as if it were relevant. STABLE 3/3 silent.
  { name: "plausible personal trigger absent from corpus → SILENCE", kind: "silent", item: { title: "Gym membership renewal", kind: "task", factSheet: "" } }
];

let failures = 0;
for (const c of cases) {
  const finding = await investigate(c.item);
  let ok;
  if (c.kind === "surface") {
    // An UNSOLICITED proactive nudge must cite the RIGHT source AND no other:
    // surfacing an adjacent note the user didn't ask about is the cost that
    // makes proactivity unwelcome. notSources guards the single-source contract.
    ok = typeof finding === "string" && c.needles.every((n) => finding.includes(n))
      && (c.notSources ?? []).every((s) => !finding.includes(s));
  } else {
    ok = finding === undefined;
  }
  console.log(`${ok ? "PASS" : "FAIL"} — ${c.name}\n   finding=${finding === undefined ? "(silent)" : JSON.stringify(finding.slice(0, 90))}`);
  if (!ok) failures += 1;
}

console.log(failures === 0 ? `\nALL PASS (${cases.length}) on ${embedModel}` : `\n${failures}/${cases.length} FAILED on ${embedModel}`);
process.exit(failures === 0 ? 0 : 1);
