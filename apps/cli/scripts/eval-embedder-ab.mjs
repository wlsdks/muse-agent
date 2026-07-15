import { errorMessage } from "@muse/shared";
/**
 * eval:embedder-ab — retrieval A/B across embedding models (report-only).
 *
 *   node apps/cli/scripts/eval-embedder-ab.mjs [modelA modelB ...]
 *
 * Runs the KO-paraphrase + EN-control recall corpus through the PRODUCTION
 * ranking config (hybrid + diversify, topK 4) once per embedder and prints
 * hit@1 / hit@K per language arm. Embeddings are deterministic, so one run is
 * the measurement — no pass^k needed for ranks. The default-embedder decision
 * is made on this table: a candidate must WIN the KO arm and NOT regress EN.
 * LOCAL OLLAMA ONLY; skips (exit 0) when Ollama or a model is unreachable.
 */
import { rankKnowledgeChunks } from "../../../packages/agent-core/dist/index.js";
import { createOllamaEmbedder } from "../../../packages/autoconfigure/dist/index.js";
import { EMBEDDER_AB_CORPUS, scoreRetrievalRecall } from "../dist/embedder-ab.js";

const models = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : ["nomic-embed-text", "nomic-embed-text-v2-moe", "embeddinggemma"];

const isKo = (text) => /[가-힣]/u.test(text);
const koCases = EMBEDDER_AB_CORPUS.cases.filter((c) => isKo(c.query));
const enCases = EMBEDDER_AB_CORPUS.cases.filter((c) => !isKo(c.query));

const pct = (n, d) => `${((n / d) * 100).toFixed(0)}%`;

let reachable = true;
try {
  await createOllamaEmbedder("nomic-embed-text")("probe");
} catch (cause) {
  console.log(`embedder-ab — skipped: local Ollama unreachable (${errorMessage(cause)})`);
  reachable = false;
}

if (reachable) {
  console.log(`embedder A/B — ${koCases.length} KO paraphrase cases + ${enCases.length} EN controls, production ranking (hybrid+diversify, topK 4)\n`);
  console.log("| model | KO hit@1 | KO hit@4 | EN hit@1 | EN hit@4 | misses |");
  console.log("|---|---|---|---|---|---|");
  for (const model of models) {
    const embed = createOllamaEmbedder(model);
    try {
      await embed("probe");
    } catch {
      console.log(`| ${model} | — | — | — | — | model unavailable (ollama pull ${model}) |`);
      continue;
    }
    const rank = (query) => rankKnowledgeChunks(query, EMBEDDER_AB_CORPUS.notes, { diversify: true, embed, hybrid: true, topK: 4 });
    const ko = await scoreRetrievalRecall(koCases, rank);
    const en = await scoreRetrievalRecall(enCases, rank);
    const misses = [...ko.misses, ...en.misses];
    console.log(`| ${model} | ${pct(ko.hit1, ko.total)} (${ko.hit1}/${ko.total}) | ${pct(ko.hitK, ko.total)} | ${pct(en.hit1, en.total)} (${en.hit1}/${en.total}) | ${pct(en.hitK, en.total)} | ${misses.length === 0 ? "—" : misses.join(" · ")} |`);
  }
}

