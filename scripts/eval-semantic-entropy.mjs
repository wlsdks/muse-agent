/**
 * eval:semantic-entropy — discrete semantic entropy as a confabulation
 * detector, OFFLINE report (Farquhar et al., Nature 630:625, 2024).
 *
 * For each grounding-corpus question: sample k answers at T=0.8 with the same
 * evidence the ask path would inject, cluster the answers by embedding cosine
 * (greedy, v2-moe — the cheap stand-in for bidirectional entailment), and
 * compute entropy over cluster sizes. Hypothesis: ANSWERABLE questions yield
 * low entropy (samples agree), MUST-REFUSE questions yield high entropy
 * (the model scatters when evidence is absent). Reports AUROC of entropy as
 * the answerable-vs-refuse discriminator next to the retrieval-confidence
 * baseline. Report-only; adoption as an escalation signal needs a measured Δ.
 *
 *   node scripts/eval-semantic-entropy.mjs        (gemma4:12b, k=4)
 *
 * LOCAL OLLAMA ONLY; skips (exit 0) when unreachable.
 */
import { OllamaProvider } from "../packages/model/dist/index.js";
import { classifyRetrievalConfidence, cosineSimilarity, rankKnowledgeChunks } from "../packages/agent-core/dist/index.js";
import { createOllamaEmbedder } from "../packages/autoconfigure/dist/index.js";
import { GROUNDING_EVAL_CORPUS } from "../apps/cli/dist/grounding-eval-corpus.js";

const MODEL = process.env.MUSE_EVAL_MODEL ?? "gemma4:12b";
const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
const K = Math.max(2, Number(process.env.MUSE_SE_SAMPLES ?? "4"));
const PER_KIND = Math.max(2, Number(process.env.MUSE_SE_CASES_PER_KIND ?? "8"));
const CLUSTER_COSINE = 0.82;

function entropyOfClusters(sizes) {
  const total = sizes.reduce((a, b) => a + b, 0);
  let h = 0;
  for (const size of sizes) {
    const p = size / total;
    h -= p * Math.log(p);
  }
  return h;
}

function auroc(positives, negatives) {
  // P(score(positive) > score(negative)) — positives should score HIGHER.
  let wins = 0;
  let ties = 0;
  for (const p of positives) {
    for (const n of negatives) {
      if (p > n) wins += 1;
      else if (p === n) ties += 1;
    }
  }
  const total = positives.length * negatives.length;
  return total === 0 ? 0.5 : (wins + ties / 2) / total;
}

async function main() {
  try {
    const resp = await fetch(`${OLLAMA_BASE}/api/tags`);
    if (!resp.ok) throw new Error(String(resp.status));
  } catch {
    console.log(`semantic-entropy skipped — Ollama unreachable at ${OLLAMA_BASE}.`);
    return;
  }
  const provider = new OllamaProvider({ defaultModel: MODEL });
  const embed = createOllamaEmbedder(process.env.MUSE_EMBED_MODEL?.trim() || "nomic-embed-text-v2-moe");

  const answerable = GROUNDING_EVAL_CORPUS.cases.filter((c) => c.kind === "answerable").slice(0, PER_KIND);
  const refuse = GROUNDING_EVAL_CORPUS.cases.filter((c) => c.kind === "refuse").slice(0, PER_KIND);

  const scoreCase = async (testCase) => {
    const matches = await rankKnowledgeChunks(testCase.query, GROUNDING_EVAL_CORPUS.notes, { diversify: true, embed, hybrid: true, topK: 4 });
    const evidence = matches.map((m) => `- ${m.text}`).join("\n");
    const samples = [];
    for (let i = 0; i < K; i += 1) {
      const res = await provider.generate({
        maxOutputTokens: 80,
        messages: [
          { content: "Answer ONLY from the provided notes. One short sentence. If the notes don't contain it, say exactly: NOT IN NOTES.", role: "system" },
          { content: `Notes:\n${evidence}\n\nQuestion: ${testCase.query}`, role: "user" }
        ],
        model: MODEL,
        temperature: 0.8
      });
      const text = (res.output ?? "").trim();
      if (text.length > 0) samples.push(text);
    }
    if (samples.length < 2) return undefined;
    const vectors = [];
    for (const sample of samples) vectors.push(await embed(sample));
    const clusters = [];
    for (let i = 0; i < samples.length; i += 1) {
      const home = clusters.find((cluster) => cosineSimilarity(vectors[cluster.rep], vectors[i]) >= CLUSTER_COSINE);
      if (home) home.size += 1;
      else clusters.push({ rep: i, size: 1 });
    }
    const retrieval = classifyRetrievalConfidence(matches);
    return { entropy: entropyOfClusters(clusters.map((c) => c.size)), retrieval };
  };

  const results = { answerable: [], refuse: [] };
  for (const [kind, cases] of [["answerable", answerable], ["refuse", refuse]]) {
    for (const testCase of cases) {
      const scored = await scoreCase(testCase);
      if (scored) results[kind].push({ ...scored, query: testCase.query });
    }
  }

  console.log(`# Discrete semantic entropy — offline report (${MODEL}, k=${K}, ${results.answerable.length}+${results.refuse.length} cases)\n`);
  console.log("| kind | query | entropy | retrieval |");
  console.log("|---|---|---|---|");
  for (const kind of ["answerable", "refuse"]) {
    for (const row of results[kind]) {
      console.log(`| ${kind} | ${row.query.slice(0, 40)} | ${row.entropy.toFixed(3)} | ${row.retrieval} |`);
    }
  }
  // refuse should have HIGHER entropy → positives = refuse.
  const seAuroc = auroc(results.refuse.map((r) => r.entropy), results.answerable.map((r) => r.entropy));
  const baselineAuroc = auroc(
    results.refuse.map((r) => (r.retrieval === "none" ? 2 : r.retrieval === "ambiguous" ? 1 : 0)),
    results.answerable.map((r) => (r.retrieval === "none" ? 2 : r.retrieval === "ambiguous" ? 1 : 0))
  );
  console.log("");
  console.log(`- semantic-entropy AUROC (refuse vs answerable): ${seAuroc.toFixed(3)}`);
  console.log(`- retrieval-confidence baseline AUROC: ${baselineAuroc.toFixed(3)}`);
  console.log(`- verdict: ${seAuroc > baselineAuroc ? "SE adds signal over the baseline" : "SE does NOT beat the existing retrieval baseline — do not adopt"}`);
}

await main();
