/**
 * LIVE battery for RGV test-time RE-VERIFICATION (slice 3) on LOCAL Qwen —
 * Memory-aware Test-Time Scaling (ReasoningBank MaTTS, arXiv:2509.25140). The
 * deterministic rubric decides grounded/ungrounded outright; only the ambiguous
 * `weak` band spends a second inference, where a one-shot Qwen judge re-checks
 * the answer against the evidence. This proves the value the lexical rubric
 * CANNOT deliver: a wrong-VALUE answer ("MTU 9000") that passes token coverage
 * is still caught and DEMOTED, while a correct answer is upheld.
 *
 *   node apps/cli/scripts/verify-rubric-reverify.mjs        (ollama/qwen3:8b)
 *
 * `weak` is forced via confidentAt: 0.99 (so any real match is ambiguous and
 * the judge always fires). Exit 0 if every case passes; skip (exit 0) if Ollama
 * is unreachable. LOCAL OLLAMA ONLY.
 */
import {
  buildGroundingReverifyPrompt,
  parseGroundingReverifyVerdict,
  REVERIFY_SYSTEM_PROMPT,
  verifyGroundingWithReverify
} from "@muse/agent-core";
import { createMuseRuntimeAssembly } from "@muse/autoconfigure";

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
  console.log(`verify-rubric-reverify skipped — local Ollama not reachable at ${baseUrl}. A skip is not a pass.`);
  process.exit(0);
}

process.env.MUSE_DEFAULT_MODEL = model;
const modelProvider = createMuseRuntimeAssembly().modelProvider;

const reverify = async ({ answer, evidence, query }) => {
  const response = await modelProvider.generate({
    maxOutputTokens: 8,
    messages: [
      { content: REVERIFY_SYSTEM_PROMPT, role: "system" },
      { content: buildGroundingReverifyPrompt({ answer, evidence, query }), role: "user" }
    ],
    model,
    temperature: 0
  });
  return parseGroundingReverifyVerdict(response.output ?? "");
};

const matches = [{ cosine: 0.5, score: 0.5, source: "notes/vpn.md", text: "The office VPN needs MTU 1380 on wg0 to stop handshake drops." }];
const query = "what MTU for the office VPN";

const cases = [
  { name: "WEAK + correct value → judge upholds → GROUNDED", answer: "The office VPN uses MTU 1380 on wg0 [from notes/vpn.md].", expect: "grounded" },
  { name: "WEAK + WRONG value (coverage passes, evidence contradicts) → judge rejects → UNGROUNDED", answer: "The office VPN uses MTU 9000 on wg0 [from notes/vpn.md].", expect: "ungrounded" }
];

let failures = 0;
for (const c of cases) {
  const v = await verifyGroundingWithReverify(c.answer, matches, query, reverify, { confidentAt: 0.99 });
  const ok = v.verdict === c.expect;
  console.log(`${ok ? "PASS" : "FAIL"} — ${c.name}\n   verdict=${v.verdict} (${v.reason})`);
  if (!ok) failures += 1;
}

console.log(failures === 0 ? `\nALL PASS (${cases.length}) on ${model}` : `\n${failures}/${cases.length} FAILED on ${model}`);
process.exit(failures === 0 ? 0 : 1);
