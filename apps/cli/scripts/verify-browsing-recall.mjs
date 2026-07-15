import { errorMessage } from "@muse/shared";
/**
 * LIVE battery for the BROWSING recall WEDGE — "that page I read last week"
 * grounded on the LOCAL Chrome browsing archive (`~/.muse/browsing.json`), under
 * the same citation gate as every other surface. Drives the REAL grounding
 * builder (buildSessionFeedReflectionGrounding → selectBrowsingVisitsForQuery),
 * the REAL local model, and the REAL output-side citation gate
 * (enforceAnswerCitations) over a seeded temp store, and asserts the wedge
 * invariant ON REAL MODEL OUTPUT:
 *
 *   1. CITED — a relevant visit is selected + the answer carries a gate-kept
 *      `[browsing: blog.rust-lang.org]` citation + the grounded banner fires.
 *   2. CROSS-LINGUAL — a KOREAN query still reaches the EN-titled visit through
 *      the nomic-embed-v2-moe cosine arm (stage 3b's whole point).
 *   3. FABRICATION-STRIPPED — a `[browsing: <site>]` for a host NOT in the store
 *      is deterministically stripped by the gate (the code decides, not the model).
 *   4. EMPTY-STORE SILENCE — no browsing store ⇒ no browsing citation, no
 *      "page(s) you visited" banner (the surface stays silent, never fabricates).
 *
 *   node apps/cli/scripts/verify-browsing-recall.mjs   (ollama/gemma4:12b)
 *
 * Exit 0 if every case passes; skip (exit 0) if Ollama / the embed model is
 * unreachable. LOCAL OLLAMA ONLY.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import { enforceAnswerCitations, normalizeFromPrefixedCitations, normalizeSlotCitations } from "@muse/agent-core";
import {
  browsingDocEmbedText,
  buildSessionFeedReflectionGrounding,
  embed,
  groundedSourceSummary,
  roundVectorForStore,
  writeBrowsingStore,
  writeFeedsStore
} from "@muse/recall";
import { CITATION_INSTRUCTION_LINES } from "../dist/commands-ask.js";

const model = process.argv[2] ?? "ollama/gemma4:12b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA ONLY"); process.exit(2); }
const baseUrl = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
const baseUrlResolver = () => baseUrl;

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
  console.log(`verify-browsing-recall skipped — local Ollama not reachable at ${baseUrl}. A skip is not a pass.`);
  process.exit(0);
}
const embedModel = ["nomic-embed-text-v2-moe", "nomic-embed-text"]
  .find((m) => available.some((name) => name === m || name.startsWith(`${m}:`)));
if (!embedModel) {
  console.log("verify-browsing-recall skipped — no local embed model (nomic-embed-text[-v2-moe]) pulled. A skip is not a pass.");
  process.exit(0);
}

const home = mkdtempSync(path.join(os.tmpdir(), "muse-browsing-recall-"));
process.env.HOME = home;
process.env.MUSE_DEFAULT_MODEL = model;
const browsingFile = path.join(home, "browsing.json");
const feedsFile = path.join(home, "feeds.json");
process.env.MUSE_BROWSING_FILE = browsingFile;
process.env.MUSE_FEEDS_FILE = feedsFile;

const embedFn = (text, m) => embed(text, m, { baseUrlResolver });
try {
  await embedFn("probe", embedModel);
} catch (cause) {
  console.log(`verify-browsing-recall skipped — embed model '${embedModel}' unavailable (${errorMessage(cause)}). A skip is not a pass.`);
  process.exit(0);
}

const modelProvider = createMuseRuntimeAssembly().modelProvider;

async function embedVisit(v) {
  return { ...v, embedding: roundVectorForStore(await embedFn(browsingDocEmbedText(v), embedModel)) };
}
async function seedVisits(visits) {
  const embedded = [];
  for (const v of visits) embedded.push(await embedVisit(v));
  await writeBrowsingStore(browsingFile, { version: 1, visits: embedded, lastVisitTimeCursor: 0 });
}
async function clearStore() {
  await writeBrowsingStore(browsingFile, { version: 1, visits: [], lastVisitTimeCursor: 0 });
}
// Keep the feeds surface silent so only the browsing arm is exercised.
await writeFeedsStore(feedsFile, { version: 1, feeds: [] });

/** Run the REAL grounding builder + REAL model + REAL citation gate for one query. */
async function ask(queryText) {
  const g = await buildSessionFeedReflectionGrounding({
    queryVec: undefined, queryText, embedModel, topK: 6, autoReindex: false, onStderr: () => {},
    episodesFile: path.join(home, "no-episodes.json"),
    reflectionsFile: path.join(home, "no-reflections.json"),
    browsingFile, embedFn
  });
  const system = [
    "Answer the user's question using ONLY the context provided below. Cite each fact.",
    ...CITATION_INSTRUCTION_LINES,
    "",
    "Pages you visited:",
    g.browsingBlock
  ].join("\n");
  const res = await modelProvider.generate({
    maxOutputTokens: 300,
    messages: [{ content: system, role: "system" }, { content: queryText, role: "user" }],
    model, temperature: 0.2
  });
  return { g, answer: (res.output ?? "").trim() };
}

const hosts = (g) => g.browsingHits.map((h) => h.host);
/** Apply the SAME normalization + gate the CLI ask path applies (browsing/feeds allowed only). */
function gate(answer, g) {
  const allowed = { browsing: hosts(g), feeds: g.feedHeadlines.map((h) => h.feedName) };
  let a = normalizeFromPrefixedCitations(answer);
  a = normalizeSlotCitations(a, { browsing: hosts(g), feed: g.feedHeadlines.map((h) => h.feedName) });
  return enforceAnswerCitations(a, allowed);
}
const bannerFires = (g) => groundedSourceSummary({ browsingVisits: g.browsingHits.length }).some((p) => p.includes("page(s) you visited"));

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"} — ${name}\n   ${detail}`); if (!ok) failures += 1; };

const RELEVANT = [
  { id: "v1", url: "https://blog.rust-lang.org/2026/01/15/Rust-1.80.0.html", title: "Announcing Rust 1.80.0", visitedAt: "2026-06-20T10:00:00.000Z" },
  { id: "v2", url: "https://cooking.example.com/pasta", title: "The perfect carbonara recipe", visitedAt: "2026-06-21T10:00:00.000Z" },
  { id: "v3", url: "https://news.example.com/weather", title: "City weather forecast for the weekend", visitedAt: "2026-06-22T10:00:00.000Z" }
];

// CASE 1 — CITED: relevant visit selected, gate-kept [browsing: host] citation, banner fires.
await seedVisits(RELEVANT);
{
  const { g, answer } = await ask("What was that Rust 1.80 blog post I read recently?");
  const gated = gate(answer, g);
  const selected = hosts(g).includes("blog.rust-lang.org");
  const cited = gated.text.includes("[browsing: blog.rust-lang.org]");
  check("CITED → visit selected + gate-kept [browsing: blog.rust-lang.org] + banner",
    selected && cited && bannerFires(g),
    `selected=${selected} cited=${cited} banner=${bannerFires(g)} | ${gated.text.slice(0, 120)}`);
}

// CASE 2 — CROSS-LINGUAL: a KOREAN query still reaches the EN-titled visit (cosine arm).
{
  const { g, answer } = await ask("지난주에 본 러스트 블로그 뭐였지?");
  const gated = gate(answer, g);
  const selected = hosts(g).includes("blog.rust-lang.org");
  const cited = gated.text.includes("[browsing: blog.rust-lang.org]");
  check("CROSS-LINGUAL → KO query reaches the EN-titled visit + gate-kept citation",
    selected && cited,
    `selected=${selected} cited=${cited} hits=${JSON.stringify(hosts(g))} | ${gated.text.slice(0, 120)}`);
}

// CASE 3 — FABRICATION-STRIPPED: a [browsing: <host>] for a site NOT in the store is
// stripped BY THE GATE. Store holds ONLY an unrelated visit; a plausible-but-absent
// host injected into the real answer must not survive.
await seedVisits([{ id: "u1", url: "https://cooking.example.com/pasta", title: "The perfect carbonara recipe", visitedAt: "2026-06-21T10:00:00.000Z" }]);
{
  const { g, answer } = await ask("What did I read about Rust programming?");
  const tampered = `${answer} You read the announcement [browsing: blog.rust-lang.org].`;
  const gated = gate(tampered, g);
  const stripped = gated.stripped.includes("blog.rust-lang.org") && !gated.text.includes("blog.rust-lang.org");
  const realOutputClean = [...gated.text.matchAll(/\[browsing:\s*([^\]]+?)\s*\]/giu)].every((m) => hosts(g).includes(m[1].trim()));
  check("FABRICATION-STRIPPED → a [browsing: absent-host] citation is stripped by the gate",
    stripped && realOutputClean,
    `stripped=${JSON.stringify(gated.stripped)} survivingBrowsingAllReal=${realOutputClean}`);
}

// CASE 4 — EMPTY-STORE SILENCE: no visits ⇒ no browsing citation survives, no banner.
await clearStore();
{
  const { g, answer } = await ask("What Rust articles have I been reading lately?");
  const gated = gate(answer, g);
  const noCitation = !/\[browsing:/iu.test(gated.text);
  const noBanner = !bannerFires(g);
  check("EMPTY-STORE → no browsing citation survives + no 'page(s) you visited' banner",
    noCitation && noBanner && g.browsingHits.length === 0,
    `hits=${g.browsingHits.length} noCitation=${noCitation} noBanner=${noBanner} | ${gated.text.slice(0, 100)}`);
}

console.log(failures === 0 ? `\nverify-browsing-recall: ALL PASS (4) on ${model}` : `\nverify-browsing-recall: ${failures}/4 FAILED on ${model}`);
process.exit(failures === 0 ? 0 : 1);

