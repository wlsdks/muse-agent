/**
 * LIVE battery for ATTRIBUTED SELF-REPAIR (RARR, arXiv:2210.08726) on LOCAL
 * Qwen. When the recall wedge returns UNGROUNDED, --repair rewrites the answer
 * constrained to the retrieved evidence and shows it ONLY if the rewrite then
 * re-verifies GROUNDED through the same gate. Two assertions that together prove
 * "constructive but never fabricated":
 *   1. a WRONG-VALUE answer ("MTU 9000") IS repaired to the evidence's "MTU 1380"
 *      and that rewrite re-verifies grounded (the edge made constructive).
 *   2. an OFF-CORPUS draft ("your blood type is O+") over VPN-only evidence is
 *      NOT repaired into a false claim — the rewrite refuses, so no fix is shown.
 *
 *   node apps/cli/scripts/verify-attributed-repair.mjs        (ollama/qwen3:8b)
 *
 * Exit 0 if every case passes; skip (exit 0) if Ollama is unreachable. LOCAL ONLY.
 */
import {
  buildAttributedRepairPrompt,
  buildGroundingReverifyPrompt,
  enforceAnswerCitations,
  parseGroundingReverifyVerdict,
  repairToEvidence,
  REPAIR_SYSTEM_PROMPT,
  REVERIFY_SYSTEM_PROMPT,
  verifyGroundingWithReverify
} from "@muse/agent-core";
import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import { answerIsRefusal } from "../dist/commands-ask.js";

const model = process.argv[2] ?? "ollama/gemma4:12b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA ONLY"); process.exit(2); }
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
  console.log(`verify-attributed-repair skipped — local Ollama not reachable at ${baseUrl}. A skip is not a pass.`);
  process.exit(0);
}

process.env.MUSE_DEFAULT_MODEL = model;
const modelProvider = createMuseRuntimeAssembly().modelProvider;

const reverify = async ({ answer, evidence, query }) => {
  const r = await modelProvider.generate({
    maxOutputTokens: 8,
    messages: [
      { content: REVERIFY_SYSTEM_PROMPT, role: "system" },
      { content: buildGroundingReverifyPrompt({ answer, evidence, query }), role: "user" }
    ],
    model,
    temperature: 0
  });
  return parseGroundingReverifyVerdict(r.output ?? "");
};

const depsFor = (allowedNotes) => ({
  gate: (candidate) => enforceAnswerCitations(candidate, { notes: allowedNotes }).text,
  isRefusal: answerIsRefusal,
  rewrite: async ({ answer, evidence, query }) => {
    const r = await modelProvider.generate({
      maxOutputTokens: 400,
      messages: [
        { content: REPAIR_SYSTEM_PROMPT, role: "system" },
        { content: buildAttributedRepairPrompt({ answer, evidence, query }), role: "user" }
      ],
      model,
      temperature: 0
    });
    return r.output ?? "";
  },
  verify: (candidate, matches, query) => verifyGroundingWithReverify(candidate, matches, query, reverify)
});

const vpnEvidence = [{ cosine: 0.72, score: 0.72, source: "notes/vpn.md", text: "The office VPN needs MTU 1380 on wg0 to stop handshake drops." }];

const cases = [
  {
    name: "WRONG VALUE → repaired to the evidence value, re-verifies grounded",
    answer: "The office VPN uses MTU 9000 on wg0.",
    matches: vpnEvidence,
    query: "what MTU for the office VPN",
    allowedNotes: ["notes/vpn.md"],
    check: (r) => r.repaired !== undefined && r.repaired.includes("1380") && !r.repaired.includes("9000")
  },
  {
    name: "OFF-CORPUS draft over unrelated evidence → NOT repaired (no fabricated fix)",
    answer: "Your blood type is O positive.",
    matches: vpnEvidence,
    query: "what is my blood type",
    allowedNotes: ["notes/vpn.md"],
    check: (r) => r.repaired === undefined
  }
];

let failures = 0;
for (const c of cases) {
  const result = await repairToEvidence(c.answer, c.matches, c.query, depsFor(c.allowedNotes));
  const ok = c.check(result);
  console.log(`${ok ? "PASS" : "FAIL"} — ${c.name}\n   ${result.repaired ? `repaired="${result.repaired.replace(/\s+/gu, " ").trim()}"` : `no repair (${result.reason})`}`);
  if (!ok) failures += 1;
}

console.log(failures === 0 ? `\nALL PASS (${cases.length}) on ${model}` : `\n${failures}/${cases.length} FAILED on ${model}`);
process.exit(failures === 0 ? 0 : 1);
