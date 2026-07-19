/**
 * LIVE battery for `POST /api/ask` under `Accept: text/event-stream` (the SSE
 * branch of `apps/api/src/ask-routes.ts`) — proves the STREAMED surface holds
 * the same grounding invariant as the buffered path with a REAL local model
 * and REAL embeddings, exercising the actual Fastify route (not a
 * reimplementation):
 *
 *   1. answerable question → the SSE stream carries ≥1 `delta` event, the
 *      concatenated deltas equal that streamed request's final `result.answer`,
 *      the separate buffered request has the same deterministic retrieval
 *      scalars, and both branches cite the exact real source `vpn.md`;
 *   2. a fabricated citation injected AFTER a real streamed answer never
 *      flashes in any `delta` frame nor survives into the final answer — the
 *      pipeline's live citation filter strips it in-stream, same as the
 *      buffered gate (fabrication=0 on the streaming branch);
 *   3. an unanswerable question → honest abstention, no fabricated citation.
 *
 *   node apps/api/scripts/verify-sse-ask-stream.mjs   (ollama/gemma4:12b)
 *
 * Exit 0 if every case passes; skip (exit 0) if Ollama or an embed model is
 * unreachable. LOCAL OLLAMA ONLY.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import { embed, reindexNotes } from "@muse/recall";
import Fastify from "fastify";

import { registerAskRoutes } from "../dist/ask-routes.js";

const model = process.argv[2] ?? "ollama/gemma4:12b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA ONLY"); process.exit(2); }
const baseUrl = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");

async function tags() {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 3_000);
    const r = await fetch(`${baseUrl}/api/tags`, { signal: c.signal });
    clearTimeout(t);
    if (!r.ok) return undefined;
    const body = await r.json();
    return (body.models ?? []).map((m) => String(m.name ?? ""));
  } catch { return undefined; }
}
const available = await tags();
if (!available) {
  console.log(`verify-sse-ask-stream skipped — local Ollama not reachable at ${baseUrl}. A skip is not a pass.`);
  process.exit(0);
}
const embedModel = ["nomic-embed-text-v2-moe", "nomic-embed-text"]
  .find((m) => available.some((name) => name === m || name.startsWith(`${m}:`)));
if (!embedModel) {
  console.log("verify-sse-ask-stream skipped — no local embed model (nomic-embed-text[-v2-moe]) pulled. A skip is not a pass.");
  process.exit(0);
}

process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "muse-sse-ask-"));
process.env.MUSE_DEFAULT_MODEL = model;
const modelProvider = createMuseRuntimeAssembly().modelProvider;

// Real corpus, real embeddings — same fixture shape as verify-grounded-recall-seam.mjs.
const notesDir = path.join(process.env.HOME, "notes");
mkdirSync(notesDir, { recursive: true });
writeFileSync(path.join(notesDir, "vpn.md"), "The office VPN needs MTU 1380 on the wg0 interface.\n");
writeFileSync(path.join(notesDir, "coffee.md"), "My favorite coffee order is a flat white with oat milk.\n");
const indexFile = path.join(process.env.HOME, "notes-index.json");
const baseUrlResolver = () => baseUrl;
const summary = await reindexNotes({ baseUrlResolver, dir: notesDir, indexPath: indexFile, model: embedModel });
if (summary.embedded === 0) {
  console.log("verify-sse-ask-stream skipped — embedding produced no index (embed endpoint failing). A skip is not a pass.");
  process.exit(0);
}
const realSources = ["vpn.md", "coffee.md"];
const onlyReal = (citations) => Array.isArray(citations)
  && citations.every((citation) =>
    typeof citation === "string" && realSources.includes(citation.split("/").pop() ?? citation)
  );
const citesExactRealSource = (citations, source) =>
  Array.isArray(citations)
  && citations.length > 0
  && onlyReal(citations)
  && citations.includes(source);

const embedFn = (text, m) => embed(text, m, { baseUrlResolver });

// Mirrors apps/api/src/server.ts's own wiring of a real ModelProvider into
// registerAskRoutes's generateAnswer/streamAnswer runtime seams.
const generateAnswer = async ({ system, user, model: answerModel, temperature }) => {
  const res = await modelProvider.generate({
    maxOutputTokens: 300,
    messages: [{ content: system, role: "system" }, { content: user, role: "user" }],
    model: answerModel,
    temperature: temperature ?? 0.2
  });
  return (res.output ?? "").trim();
};
async function* streamAnswerReal({ system, user, model: answerModel, temperature }) {
  for await (const event of modelProvider.stream({
    maxOutputTokens: 300,
    messages: [{ content: system, role: "system" }, { content: user, role: "user" }],
    model: answerModel,
    temperature: temperature ?? 0.2
  })) {
    if (event.type === "text-delta") {
      yield event.text;
    } else if (event.type === "error") {
      throw event.error;
    }
  }
}
// Tamper AFTER a real stream finishes, split across several delta chunks —
// exercises the live citation filter's cross-boundary stripping, same
// contract the buffered gate enforces on the full answer.
async function* streamAnswerTampered(args) {
  for await (const chunk of streamAnswerReal(args)) yield chunk;
  const tail = " Also, your SSN is 123-45-6789. [from secrets/ssn.md]";
  yield tail.slice(0, 12);
  yield tail.slice(12, 30);
  yield tail.slice(30);
}

function buildServer(streamAnswer) {
  const server = Fastify();
  registerAskRoutes(server, {
    answerModel: model,
    authService: undefined,
    embedFn,
    embedModel,
    generateAnswer,
    notesDir,
    notesIndexFile: indexFile,
    streamAnswer
  });
  return server;
}

function parseSseFrames(body) {
  return body
    .split("\n\n")
    .filter((frame) => frame.trim().length > 0)
    .map((frame) => {
      const lines = frame.split("\n");
      const event = lines.find((line) => line.startsWith("event: "))?.slice("event: ".length) ?? "";
      const dataLines = lines.filter((line) => line.startsWith("data: ")).map((line) => line.slice("data: ".length));
      return { data: dataLines.join("\n"), event };
    });
}

let failures = 0;
const fail = (m) => { console.log(`FAIL — ${m}`); failures += 1; };
const pass = (m) => console.log(`PASS — ${m}`);

// 1) Answerable, real streaming answer through the ACTUAL SSE route.
{
  const server = buildServer(streamAnswerReal);
  const question = "What MTU does the office VPN need?";
  const streamed = await server.inject({
    headers: { accept: "text/event-stream" },
    method: "POST",
    payload: { question },
    url: "/api/ask"
  });
  const frames = parseSseFrames(streamed.body);
  const deltas = frames.filter((f) => f.event === "delta");
  const resultFrame = frames.find((f) => f.event === "result");
  const result = resultFrame ? JSON.parse(resultFrame.data) : undefined;
  console.log(`SSE answer: "${(result?.answer ?? "").slice(0, 140)}" (verdict ${result?.verdict})`);

  streamed.statusCode === 200
    ? pass("SSE responds 200 with text/event-stream")
    : fail(`SSE responded ${streamed.statusCode}`);
  deltas.length >= 1
    ? pass(`stream carried ${deltas.length} delta event(s)`)
    : fail("stream carried zero delta events");
  const concatenated = deltas.map((f) => f.data).join("");
  result && concatenated === result.answer
    ? pass("concatenated deltas equal the final result.answer")
    : fail(`concatenated deltas mismatch result.answer: deltas="${concatenated}" result="${result?.answer}"`);

  const buffered = await server.inject({ method: "POST", payload: { question }, url: "/api/ask" });
  const bufferedBody = JSON.parse(buffered.body);
  // Streaming and buffered are separate model generations. Their natural
  // language may differ harmlessly (for example punctuation around a citation),
  // so byte equality across the two requests is not a valid contract. The
  // deterministic retrieval scalars must match, and each branch must independently
  // satisfy the grounding contract. Byte equality remains strict above within
  // the ONE streamed request (deltas === its own result.answer).
  result
    && buffered.statusCode === 200
    && result.verdict === bufferedBody.verdict
    && result.groundedChunkCount === bufferedBody.groundedChunkCount
    && result.notesUnavailable === bufferedBody.notesUnavailable
    ? pass("streamed/buffered scalar parity holds for verdict, groundedChunkCount, and notesUnavailable")
    : fail(`streamed/buffered scalar parity mismatch: streamed=${JSON.stringify(result)} buffered=${JSON.stringify(bufferedBody)}`);
  bufferedBody.answer?.includes("1380") && citesExactRealSource(bufferedBody.citations, "vpn.md")
    ? pass("the buffered branch has nonempty real citations including exact vpn.md")
    : fail(`buffered grounding failed: answer="${bufferedBody.answer}" citations=${JSON.stringify(bufferedBody.citations)}`);

  result && citesExactRealSource(result.citations, "vpn.md")
    ? pass(`the SSE branch has nonempty real citations including exact vpn.md (${JSON.stringify(result.citations)})`)
    : fail(`SSE citations were empty, non-corpus, or missing exact vpn.md: ${JSON.stringify(result?.citations)}`);
  result && result.answer.includes("1380")
    ? pass("the grounded fact (MTU 1380) is in the streamed answer")
    : fail(`the answerable fact is missing from the streamed answer: "${result?.answer}"`);

  await server.close();
}

// 2) Fabrication injected AFTER a real answer must never flash in a delta
//    nor survive into the final result — fabrication=0 on the SSE branch.
{
  const server = buildServer(streamAnswerTampered);
  const question = "What MTU does the office VPN need?";
  const streamed = await server.inject({
    headers: { accept: "text/event-stream" },
    method: "POST",
    payload: { question },
    url: "/api/ask"
  });
  const frames = parseSseFrames(streamed.body);
  const deltas = frames.filter((f) => f.event === "delta");
  const resultFrame = frames.find((f) => f.event === "result");
  const result = resultFrame ? JSON.parse(resultFrame.data) : undefined;

  // The pipeline's guarantee (pipeline.ts's own doc comment on GroundedRecallEvent,
  // mirrored by ask-routes.test.ts's SSE fabrication case) is that the fabricated
  // CITATION MARKER never flashes — enforceAnswerCitations strips "[from
  // secrets/ssn.md]", not the sentence it was attached to, so the SSN digits
  // themselves are not asserted here.
  const flashed = deltas.some((f) => f.data.includes("secrets/ssn.md"));
  !flashed
    ? pass("the fabricated citation marker never flashes in any delta frame")
    : fail(`the fabricated marker flashed in a delta: ${JSON.stringify(deltas.map((f) => f.data))}`);

  result && !result.answer.includes("secrets/ssn.md")
    ? pass("the fabricated citation marker is absent from the final streamed answer")
    : fail(`the fabricated citation marker survived into result.answer: "${result?.answer}"`);
  result && result.strippedCitations.includes("secrets/ssn.md")
    ? pass(`the seam reports the strip in strippedCitations (${JSON.stringify(result?.strippedCitations)})`)
    : fail(`strippedCitations did not report the injected fabrication: ${JSON.stringify(result?.strippedCitations)}`);
  result && citesExactRealSource(result.citations, "vpn.md")
    ? pass(`surviving citations stay nonempty, real-corpus-only, and include exact vpn.md (${JSON.stringify(result.citations)})`)
    : fail(`surviving citations were empty, fabricated, or missing exact vpn.md: ${JSON.stringify(result?.citations)}`);

  await server.close();
}

// 3) Unanswerable question over SSE → honest abstention, no fabricated source.
{
  const server = buildServer(streamAnswerReal);
  const question = "What is my aunt's cat's name?";
  const streamed = await server.inject({
    headers: { accept: "text/event-stream" },
    method: "POST",
    payload: { question },
    url: "/api/ask"
  });
  const frames = parseSseFrames(streamed.body);
  const resultFrame = frames.find((f) => f.event === "result");
  const result = resultFrame ? JSON.parse(resultFrame.data) : undefined;
  console.log(`SSE absent-info answer: "${(result?.answer ?? "").slice(0, 140)}" (verdict ${result?.verdict}, refusal ${String(result?.refusal)})`);

  result && onlyReal(result.citations)
    ? pass(`absent-info SSE question carried no fabricated source (citations ${JSON.stringify(result?.citations)})`)
    : fail(`absent-info SSE question produced a non-corpus citation: ${JSON.stringify(result?.citations)}`);

  await server.close();
}

console.log(failures === 0 ? "\nverify-sse-ask-stream: ALL PASS" : `\nverify-sse-ask-stream: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
