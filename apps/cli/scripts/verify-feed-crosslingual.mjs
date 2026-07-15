import { errorMessage } from "@muse/shared";
/**
 * LIVE battery for the FEED cross-lingual RESCUE arm — a KOREAN query reaching an
 * EN headline that has rolled OUT of the recency window, which recency alone can
 * never surface (stage 4's whole point). Drives the REAL grounding builder
 * (buildSessionFeedReflectionGrounding → selectFeedHeadlinesForQuery), the REAL
 * local model, and the REAL citation gate over a seeded temp feeds store, and
 * asserts:
 *
 *   1. RESCUE — a store of 8 newer filler entries (fills the recency-8 base) + 1
 *      OLDER embedded EN entry ("Rust 1.80.0 released", feed "Rust Weekly"): a KO
 *      query surfaces Rust Weekly (out-of-window) and the answer cites
 *      `[feed: Rust Weekly]`.
 *   2. NEGATIVE CONTROL — the SAME store with the old entry's embedding stripped:
 *      the rescue does NOT happen (no Rust Weekly, no citation). This A/B proves
 *      the cosine arm is load-bearing, as a permanent gate.
 *   3. FABRICATION-STRIPPED — a `[feed: <name>]` for a feed NOT in the store is
 *      stripped by the gate (the code decides, not the model).
 *
 *   node apps/cli/scripts/verify-feed-crosslingual.mjs   (ollama/gemma4:12b)
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
  buildSessionFeedReflectionGrounding,
  embed,
  feedDocEmbedText,
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
  console.log(`verify-feed-crosslingual skipped — local Ollama not reachable at ${baseUrl}. A skip is not a pass.`);
  process.exit(0);
}
const embedModel = ["nomic-embed-text-v2-moe", "nomic-embed-text"]
  .find((m) => available.some((name) => name === m || name.startsWith(`${m}:`)));
if (!embedModel) {
  console.log("verify-feed-crosslingual skipped — no local embed model (nomic-embed-text[-v2-moe]) pulled. A skip is not a pass.");
  process.exit(0);
}

const home = mkdtempSync(path.join(os.tmpdir(), "muse-feed-crosslingual-"));
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
  console.log(`verify-feed-crosslingual skipped — embed model '${embedModel}' unavailable (${errorMessage(cause)}). A skip is not a pass.`);
  process.exit(0);
}

const modelProvider = createMuseRuntimeAssembly().modelProvider;
// Keep the browsing surface silent so only the feeds arm is exercised.
await writeBrowsingStore(browsingFile, { version: 1, visits: [], lastVisitTimeCursor: 0 });

// 8 newer filler entries fill the recency-8 base; the Rust entry is OLDER, so
// only the query-relevant rescue arm can reach it.
const FILLERS = ["Gardening tips for spring", "Best hiking trails nearby", "How to bake sourdough bread",
  "A guide to home espresso", "Weekend movie recommendations", "Local farmers market opens",
  "Tips for better sleep", "New museum exhibit downtown"].map((title, i) => ({
  id: `filler-${i}`, title, link: `https://daily.example.com/${i}`,
  publishedAt: `2026-06-2${i}T12:00:00.000Z`, summary: "Filler item."
}));
const OLD_RUST = {
  id: "rust-weekly-180", title: "Rust 1.80.0 released", link: "https://rustweekly.example.com/180",
  publishedAt: "2026-05-01T12:00:00.000Z", summary: "The Rust team announced version 1.80.0 with new features."
};

async function seedFeeds(rustEntry) {
  await writeFeedsStore(feedsFile, { version: 1, feeds: [
    { id: "daily", url: "https://daily.example.com/rss", name: "Daily Digest", entries: FILLERS },
    { id: "rustweekly", url: "https://rustweekly.example.com/rss", name: "Rust Weekly", entries: [rustEntry] }
  ]});
}
async function embedOldRust() {
  return { ...OLD_RUST, embedding: roundVectorForStore(await embedFn(feedDocEmbedText(OLD_RUST), embedModel)) };
}

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
    "Recent feed headlines:",
    g.feedBlock
  ].join("\n");
  const res = await modelProvider.generate({
    maxOutputTokens: 300,
    messages: [{ content: system, role: "system" }, { content: queryText, role: "user" }],
    model, temperature: 0.2
  });
  return { g, answer: (res.output ?? "").trim() };
}

const feedNames = (g) => g.feedHeadlines.map((h) => h.feedName);
function gate(answer, g) {
  const allowed = { browsing: g.browsingHits.map((h) => h.host), feeds: feedNames(g) };
  let a = normalizeFromPrefixedCitations(answer);
  a = normalizeSlotCitations(a, { browsing: g.browsingHits.map((h) => h.host), feed: feedNames(g) });
  return enforceAnswerCitations(a, allowed);
}

const KO = "지난주에 러스트 새 버전 나왔다는 피드 봤는데 뭐였지?";
let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"} — ${name}\n   ${detail}`); if (!ok) failures += 1; };

// CASE 1 — RESCUE: the older EMBEDDED entry is surfaced by the cosine arm + cited.
await seedFeeds(await embedOldRust());
{
  const { g, answer } = await ask(KO);
  const gated = gate(answer, g);
  const rescued = feedNames(g).includes("Rust Weekly");
  const cited = gated.text.includes("[feed: Rust Weekly]");
  check("RESCUE → out-of-window EN entry reached by KO query + gate-kept [feed: Rust Weekly]",
    rescued && cited,
    `rescued=${rescued} cited=${cited} banner=${JSON.stringify(groundedSourceSummary({ feedHeadlines: g.feedHeadlines.length }))} | ${gated.text.slice(0, 120)}`);
}

// CASE 2 — NEGATIVE CONTROL: SAME store, embedding stripped ⇒ no rescue (cosine arm is load-bearing).
await seedFeeds(OLD_RUST);
{
  const { g, answer } = await ask(KO);
  const gated = gate(answer, g);
  const noRescue = !feedNames(g).includes("Rust Weekly");
  const noCitation = !gated.text.includes("[feed: Rust Weekly]");
  check("NEGATIVE CONTROL → no embedding ⇒ Rust Weekly NOT rescued and NOT cited (A/B proves the cosine arm)",
    noRescue && noCitation,
    `noRescue=${noRescue} noCitation=${noCitation} names=${JSON.stringify([...new Set(feedNames(g))])}`);
}

// CASE 3 — FABRICATION-STRIPPED: a [feed: <name>] for a feed NOT in the store is stripped by the gate.
await seedFeeds(await embedOldRust());
{
  const { g, answer } = await ask(KO);
  const tampered = `${answer} Also relevant [feed: Nonexistent Ghost Feed].`;
  const gated = gate(tampered, g);
  const stripped = gated.stripped.includes("Nonexistent Ghost Feed") && !gated.text.includes("Nonexistent Ghost Feed");
  const survivingAllReal = [...gated.text.matchAll(/\[feed:\s*([^\]]+?)\s*\]/giu)].every((m) => feedNames(g).includes(m[1].trim()));
  check("FABRICATION-STRIPPED → a [feed: absent-feed] citation is stripped by the gate",
    stripped && survivingAllReal,
    `stripped=${JSON.stringify(gated.stripped)} survivingFeedsAllReal=${survivingAllReal}`);
}

console.log(failures === 0 ? `\nverify-feed-crosslingual: ALL PASS (3) on ${model}` : `\nverify-feed-crosslingual: ${failures}/3 FAILED on ${model}`);
process.exit(failures === 0 ? 0 : 1);

