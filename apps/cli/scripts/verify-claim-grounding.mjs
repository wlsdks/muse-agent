/**
 * LIVE battery for CLAIM-LEVEL value grounding on LOCAL Qwen — the wrong-value
 * hole the lexical rubric cannot see. A confident, high-coverage, fully-cited
 * answer that asserts a WRONG NUMBER ("MTU 9000" where the note says "1380")
 * passes `verifyGrounding` as `grounded` at the DEFAULT threshold (its single
 * wrong token barely dents whole-answer coverage). The claim-level value
 * escalation routes exactly that case to the one-shot judge, which rejects it
 * (Self-RAG ISSUP, arXiv:2310.11511; Chain-of-Note, arXiv:2311.09210).
 *
 * Unlike verify-rubric-reverify (which forces the WEAK band via confidentAt:0.99),
 * this uses the DEFAULT threshold and a confident (cosine 0.72) match, so the
 * base verdict really is `grounded` — proving the NEW grounded-escalation path,
 * not the weak band.
 *
 *   node apps/cli/scripts/verify-claim-grounding.mjs        (ollama/qwen3:8b)
 *
 * Exit 0 if every case passes; skip (exit 0) if Ollama is unreachable. LOCAL ONLY.
 */
import {
  buildGroundingReverifyPrompt,
  parseGroundingReverifyVerdict,
  REVERIFY_SYSTEM_PROMPT,
  verifyGroundingPerClaim,
  verifyGroundingWithReverify
} from "@muse/agent-core";
import { createMuseRuntimeAssembly } from "@muse/autoconfigure";

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
  console.log(`verify-claim-grounding skipped — local Ollama not reachable at ${baseUrl}. A skip is not a pass.`);
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

// cosine 0.72 ⇒ CONFIDENT ⇒ the base rubric verdict is `grounded` at the DEFAULT
// threshold (not the forced-weak band). The wrong number is what must be caught.
const matches = [{ cosine: 0.72, score: 0.72, source: "notes/vpn.md", text: "The office VPN needs MTU 1380 on wg0 to stop handshake drops." }];
const query = "what MTU for the office VPN";

const lease = [{ cosine: 0.72, score: 0.72, source: "notes/lease.md", text: "Apartment lease: landlord is Mr. Park, monthly rent due on the 1st." }];

// Cross-lingual: a Korean QUESTION + ANSWER drawn from an ENGLISH note. The
// lexical rubric scores answerability=0 (KR query, EN evidence) → weak band →
// the judge decides. The judge must compare the underlying VALUE across the
// language gap: the correct value (literal "hunter2-blue") is in the evidence so
// it upholds; a wrong value the evidence never states is rejected in any language.
const wifi = [{ cosine: 0.72, score: 0.72, source: "notes/net.md", text: "The office WiFi password is hunter2-blue." }];
const wifiQuery = "내 와이파이 비밀번호가 뭐야";

const cases = [
  { name: "GROUNDED base + WRONG number (9000 not in evidence) → escalated → judge rejects → UNGROUNDED", answer: "The office VPN uses MTU 9000 on wg0 [from notes/vpn.md].", matches, query, expect: "ungrounded" },
  { name: "GROUNDED base + CORRECT number (1380 in evidence) → no escalation → GROUNDED", answer: "The office VPN uses MTU 1380 on wg0 [from notes/vpn.md].", matches, query, expect: "grounded" },
  { name: "GROUNDED base + WRONG named entity (Lee not in evidence) → escalated → judge rejects → UNGROUNDED", answer: "Your landlord is Mr. Lee [from notes/lease.md].", matches: lease, query: "who is my landlord", expect: "ungrounded" },
  { name: "GROUNDED base + CORRECT named entity (Park in evidence) → no escalation → GROUNDED", answer: "Your landlord is Mr. Park [from notes/lease.md].", matches: lease, query: "who is my landlord", expect: "grounded" },
  { name: "CROSS-LINGUAL correct (KR answer / EN evidence, value 'hunter2-blue' matches) → judge upholds → GROUNDED", answer: "당신의 와이파이 비밀번호는 hunter2-blue입니다 [from notes/net.md].", matches: wifi, query: wifiQuery, expect: "grounded" },
  { name: "CROSS-LINGUAL wrong value (KR answer asserts 'dragon99-red', not in evidence) → rejected → UNGROUNDED", answer: "당신의 와이파이 비밀번호는 dragon99-red입니다 [from notes/net.md].", matches: wifi, query: wifiQuery, expect: "ungrounded" }
];

let failures = 0;
for (const c of cases) {
  const v = await verifyGroundingWithReverify(c.answer, c.matches, c.query, reverify);
  const ok = v.verdict === c.expect;
  console.log(`${ok ? "PASS" : "FAIL"} — ${c.name}\n   verdict=${v.verdict} (${v.reason})`);
  if (!ok) failures += 1;
}

// --- Per-claim ISSUP refinement (muse ask --verify-claims): the judge runs on
// EACH atomic claim and the unsupported one is surgically dropped while the
// supported one is kept (Self-RAG ISSUP). The fully-supported case is the
// over-refusal tripwire — a grounded multi-claim answer must come back untouched.
const pricing = [{ cosine: 0.72, score: 0.72, source: "notes/team.md", text: "Mina owns the pricing strategy. The team is three people." }];
const perClaimCases = [
  {
    name: "MIXED: 'Mina owns pricing AND budget was 2,000,000 KRW' → DROP the budget clause, KEEP pricing",
    answer: "Mina owns pricing and the budget was 2,000,000 KRW",
    matches: pricing, query: "who owns what on the team",
    check: (r) => r.dropped >= 1 && r.answer.includes("Mina owns pricing") && !r.answer.split("I'm not sure about:")[0].includes("2,000,000")
  },
  {
    name: "FULLY-SUPPORTED (over-refusal tripwire): both clauses in evidence → untouched, dropped=0",
    answer: "Mina owns pricing and the team is three people",
    matches: pricing, query: "who owns what on the team",
    check: (r) => r.dropped === 0 && r.answer === "Mina owns pricing and the team is three people"
  }
];
for (const c of perClaimCases) {
  const r = await verifyGroundingPerClaim(c.answer, c.matches, c.query, reverify);
  const ok = c.check(r);
  console.log(`${ok ? "PASS" : "FAIL"} — ${c.name}\n   dropped=${r.dropped} answer=${JSON.stringify(r.answer)}`);
  if (!ok) failures += 1;
}

const total = cases.length + perClaimCases.length;
console.log(failures === 0 ? `\nALL PASS (${total}) on ${model}` : `\n${failures}/${total} FAILED on ${model}`);
process.exit(failures === 0 ? 0 : 1);
