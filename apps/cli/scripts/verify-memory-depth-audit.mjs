/**
 * Memory-depth axis END-TO-END audit — does the whole axis COMPOSE for one
 * user, not just each slice in isolation? Drives the real code paths:
 *   - FileUserMemoryStore: state home_city Busan, then Seoul → supersession
 *   - recurringEpisodeThreads over a recurring-topic episode set
 *   - buildMusePersona folds prior value + threads into ONE system prompt
 *   - one qwen turn answers BOTH "where did I live" + "what do I keep working
 *     on" from that single persona (depth composed in one inference)
 *   - synthesizeReflection (/reflect) yields a grounded insight
 *   - formatMemoryView (/memory) shows the dated prior + the threads line
 *
 *   node apps/cli/scripts/verify-memory-depth-audit.mjs   (qwen3:8b)
 *
 * Exit 0 = all compose, 1 = a gap. LOCAL OLLAMA ONLY.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { FileUserMemoryStore } from "@muse/memory";
import { createMuseRuntimeAssembly } from "@muse/autoconfigure";

const model = process.argv[2] ?? "ollama/gemma4:12b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA ONLY"); process.exit(2); }
const home = mkdtempSync(path.join(os.tmpdir(), "muse-mda-"));
process.env.HOME = home;
process.env.MUSE_DEFAULT_MODEL = model;

const { buildMusePersona } = await import("../dist/muse-persona.js");
const { recurringEpisodeThreads, formatMemoryView } = await import("../dist/chat-ink-core.js");
const { synthesizeReflection } = await import("../dist/chat-reflection.js");

const fails = [];
const check = (name, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? `: ${detail}` : ""}`); if (!ok) fails.push(name); };

// 1) supersession through the real file store
const store = new FileUserMemoryStore({ file: path.join(home, "user-memory.json") });
await store.upsertFact("u", "home_city", "Busan");
await store.upsertFact("u", "home_city", "Seoul");
const mem = await store.findByUserId("u");
check("store retains the superseded prior", mem?.factHistory?.some((e) => e.key === "home_city" && e.previousValue === "Busan") ?? false);

// 2) recurring threads from an episode set
const episodes = [
  { endedAt: "2026-05-01", summary: "Reviewed the Q3 budget, no decision.", topics: ["Q3 budget"] },
  { endedAt: "2026-05-08", summary: "Back on the Q3 budget marketing line.", topics: ["Q3 budget"] },
  { endedAt: "2026-05-15", summary: "Q3 budget again, deferred a week.", topics: ["Q3 budget"] }
];
const threads = recurringEpisodeThreads(episodes);
check("recurring threads detected", threads.some((t) => /q3/i.test(t.topic) && t.sessions === 3));

// 3) persona folds BOTH depth signals into one prompt
const persona = buildMusePersona(
  { facts: mem.facts, preferences: { language: "English" }, factHistory: mem.factHistory, recurringThreads: threads, episodes },
  "u"
);
check("persona carries the fact prior", persona?.includes("(previously Busan)") ?? false);
check("persona carries the threads line", persona?.includes("Q3 budget (3 sessions)") ?? false);

// 4) ONE qwen turn answers both from that single persona
const asm = createMuseRuntimeAssembly();
let text = "";
for await (const ev of asm.agentRuntime.stream({
  messages: [
    { role: "system", content: persona },
    { role: "user", content: "Two things in one short reply: which city did I live in before my current one, and what topic do I keep coming back to?" }
  ],
  metadata: { localMode: true, userId: "u" },
  model
})) { if (ev.type === "text-delta" && ev.text) text += ev.text; }
check("model composes prior + thread in one turn", /busan/i.test(text) && /q3|budget/i.test(text), JSON.stringify(text.trim().slice(0, 200)));

// 4b) Negative control (ported from the retired verify-threads-persona): with NO
// recurringThreads in the persona, the model must NOT fabricate a returning
// topic. This is a real abstention test, not a prompt-echo — nothing in the
// prompt names a thread to parrot. Non-leading question so honesty is available.
const noThreadPersona = buildMusePersona({ facts: mem.facts, preferences: { language: "English" } }, "u");
let negText = "";
for await (const ev of asm.agentRuntime.stream({
  messages: [
    { role: "system", content: noThreadPersona },
    { role: "user", content: "Is there a topic I keep coming back to across our sessions? If you don't have that information, say so plainly. One short sentence." }
  ],
  metadata: { localMode: true, userId: "u" },
  model
})) { if (ev.type === "text-delta" && ev.text) negText += ev.text; }
check("no threads → the model does not fabricate one", !/q3|budget/i.test(negText), JSON.stringify(negText.trim().slice(0, 160)));

// 5) /reflect synthesizes a grounded insight
const insight = await synthesizeReflection({ provider: asm.modelProvider, model, episodes });
check("/reflect yields a grounded insight", insight.length > 0 && /q3|budget/i.test(insight), JSON.stringify(insight));

// 6) /memory view shows dated prior + threads
const view = formatMemoryView(
  { facts: mem.facts, preferences: {}, recentTopics: [], factHistory: mem.factHistory.map((e) => ({ key: e.key, previousValue: e.previousValue, replacedAt: e.replacedAt.toISOString() })) },
  undefined,
  threads
);
check("/memory shows dated prior + threads", /was Busan until \d{4}-\d{2}-\d{2}/.test(view) && view.includes("Threads you keep returning to"));

console.log(fails.length === 0 ? `\nAUDIT PASS — memory depth composes end-to-end on ${model}` : `\nAUDIT REOPEN — gaps: ${fails.join("; ")}`);
process.exit(fails.length === 0 ? 0 : 1);
