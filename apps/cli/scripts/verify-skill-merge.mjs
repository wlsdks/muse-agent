/**
 * FAST live battery for curator skill-merge on LOCAL qwen — does a cluster of
 * genuinely-related narrow skills merge into ONE coherent umbrella, and
 * crucially return NONE for UNRELATED skills (no force-merge)? The negative
 * case is the whole risk of automatic consolidation.
 *
 * Also asserts the SkillOpt held-out coverage gate does NOT false-reject a real
 * LLM-produced umbrella (a coherent merge must still pass `validateUmbrellaCoverage`)
 * — the one risk the deterministic unit tests can't cover.
 *
 *   node apps/cli/scripts/verify-skill-merge.mjs        (qwen3:8b)
 *
 * Exit 0 if every case passes, 1 otherwise. LOCAL OLLAMA ONLY.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMuseRuntimeAssembly, createOllamaEmbedder } from "@muse/autoconfigure";
import { mergeSkillsIntoUmbrella, validateUmbrellaCoverage } from "@muse/agent-core";

const model = process.argv[2] ?? "ollama/gemma4:12b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA ONLY"); process.exit(2); }
process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "muse-merge-"));
process.env.MUSE_DEFAULT_MODEL = model;

const asm = createMuseRuntimeAssembly();
const modelProvider = asm.modelProvider;
const embed = createOllamaEmbedder("nomic-embed-text");

const cases = [
  {
    name: "related summarise-* skills → coherent umbrella",
    kind: "umbrella",
    needles: ["summar", "요약"],
    cluster: [
      { name: "summarise-email", description: "Use when summarising an email thread", body: "1. read the thread\n2. emit 3 bullets" },
      { name: "summarise-doc", description: "Use when summarising a document", body: "1. skim headings\n2. emit bullets" },
      { name: "summarise-notes", description: "Use when summarising meeting notes", body: "1. scan notes\n2. action items as bullets" }
    ]
  },
  {
    name: "NEGATIVE: unrelated skills → NONE (no force-merge)",
    kind: "none",
    cluster: [
      { name: "summarise-email", description: "Use when summarising an email", body: "read; bullets" },
      { name: "book-flight", description: "Use when booking a flight", body: "search; pick; confirm payment" }
    ]
  },
  {
    // The harder negative: skills that SHARE A KEYWORD ("lock") but operate in
    // entirely different domains must NOT force-merge on surface overlap. STABLE 3/3 NONE.
    name: "NEGATIVE: shared-keyword, different-domain skills → NONE (no surface force-merge)",
    kind: "none",
    cluster: [
      { name: "lock-front-door", description: "Use when locking the smart-home front door", body: "call lock.front_door" },
      { name: "lock-spreadsheet-cell", description: "Use when locking a spreadsheet cell", body: "protect the cell range" }
    ]
  }
];

let failures = 0;
for (const c of cases) {
  const out = await mergeSkillsIntoUmbrella(c.cluster, { model, modelProvider });
  let ok;
  let gateNote = "";
  if (c.kind === "umbrella") {
    const blob = `${out?.name ?? ""} ${out?.description ?? ""} ${out?.body ?? ""}`.toLowerCase();
    const coherent = Boolean(out?.name) && Boolean(out?.description) && Boolean(out?.body) && c.needles.some((n) => blob.includes(n.toLowerCase()));
    // Held-out gate must ACCEPT a coherent real umbrella — a rejection here is a
    // false-reject regression, not the gate doing its job.
    const verdict = out ? await validateUmbrellaCoverage(c.cluster, out, { embed }) : { accept: false, reason: "no umbrella produced" };
    ok = coherent && verdict.accept;
    gateNote = `\n   gate: ${verdict.accept ? "ACCEPT" : "REJECT"} — ${verdict.reason}`;
  } else {
    ok = out === undefined;
  }
  console.log(`${ok ? "PASS" : "FAIL"} — ${c.name}\n   out: ${JSON.stringify(out)?.slice(0, 200)}${gateNote}`);
  if (!ok) failures += 1;
}

// Cross-script is UNVERIFIABLE → fail-closed: an English umbrella over a Korean
// cluster must be REJECTED (deferred), not auto-accepted. This is the security
// property — the gate must do real work for a non-Latin user, not rubber-stamp.
{
  const koCluster = [
    { name: "이메일-요약", description: "이메일 스레드를 요약할 때 사용", body: "1. 스레드를 읽는다 2. 불릿 3개" },
    { name: "문서-요약", description: "문서를 요약할 때 사용", body: "1. 제목을 훑는다 2. 불릿" }
  ];
  const enUmbrella = { name: "delete-everything", description: "Use when you want to wipe the disk", body: "rm -rf" };
  const verdict = await validateUmbrellaCoverage(koCluster, enUmbrella, { embed });
  const ok = verdict.accept === false && verdict.unverified.length === 2;
  console.log(`${ok ? "PASS" : "FAIL"} — CROSS-SCRIPT FAIL-CLOSED: unrelated EN umbrella over KO cluster rejected\n   gate: ${verdict.accept ? "ACCEPT(!)" : "REJECT"} — ${verdict.reason}`);
  if (!ok) failures += 1;
}

// Same-language KO merge: a Korean umbrella that genuinely covers a Korean
// cluster must be ACCEPTED — proves verification works within Hangul (real nomic).
{
  const koCluster = [
    { name: "이메일-요약", description: "이메일 스레드를 요약할 때 사용", body: "1. 스레드를 읽는다 2. 불릿 3개" },
    { name: "문서-요약", description: "문서를 요약할 때 사용", body: "1. 제목을 훑는다 2. 불릿" }
  ];
  const koUmbrella = { name: "콘텐츠-요약", description: "이메일이나 문서를 요약할 때 사용", body: "1. 읽는다 2. 불릿" };
  const verdict = await validateUmbrellaCoverage(koCluster, koUmbrella, { embed });
  const ok = verdict.accept === true;
  console.log(`${ok ? "PASS" : "FAIL"} — SAME-LANG KO: Korean umbrella covering a Korean cluster accepted\n   gate: ${verdict.accept ? "ACCEPT" : "REJECT"} — ${verdict.reason}`);
  if (!ok) failures += 1;
}

// REJECT path against REAL nomic: a coverage-losing umbrella (covers only one of
// two different-domain originals) MUST be rejected. Proves the gate's reject
// direction + the floor calibration against the real embedding distribution, not
// just synthetic fakes — so an embedder-version drift that lifts off-topic pairs
// above the floor trips this check instead of silently disarming the gate.
{
  const rejCluster = [
    { name: "summarise-email", description: "Use when summarising an email thread", body: "read; bullets" },
    { name: "book-flight", description: "Use when booking a flight ticket", body: "search; confirm" }
  ];
  const losing = { name: "summarise-email-only", description: "Use when summarising an email thread", body: "read; bullets" };
  const verdict = await validateUmbrellaCoverage(rejCluster, losing, { embed });
  const ok = verdict.accept === false && verdict.lost.includes("book-flight");
  console.log(`${ok ? "PASS" : "FAIL"} — REJECT-PATH: coverage-losing umbrella rejected by real nomic\n   gate: ${verdict.accept ? "ACCEPT(!)" : "REJECT"} — ${verdict.reason}`);
  if (!ok) failures += 1;
}

// Body-gutting: an umbrella whose trigger covers the cluster but whose BODY is
// hollow ("TODO") must be REJECTED — the trigger surface alone can't see this, so
// the body-coverage check is the defense. Proves the new property against real nomic.
{
  const cluster = [
    { name: "summarise-email", description: "Use when summarising an email thread", body: "1. read the whole thread\n2. extract decisions and owners\n3. emit 3 bullets" },
    { name: "summarise-doc", description: "Use when summarising a document", body: "1. skim the headings\n2. pull key claims\n3. emit concise bullets" }
  ];
  const gutted = { name: "summarise-content", description: "Use when summarising an email thread or a document", body: "TODO" };
  const verdict = await validateUmbrellaCoverage(cluster, gutted, { embed });
  const ok = verdict.accept === false;
  console.log(`${ok ? "PASS" : "FAIL"} — BODY-GUTTING: covering-trigger but TODO-body umbrella rejected\n   gate: ${verdict.accept ? "ACCEPT(!)" : "REJECT"} — ${verdict.reason}`);
  if (!ok) failures += 1;
}

const total = cases.length + 4; // + cross-script + same-lang-KO + reject-path + body-gutting checks
console.log(failures === 0 ? `\nALL PASS (${total}) on ${model}` : `\n${failures}/${total} FAILED on ${model}`);
process.exit(failures === 0 ? 0 : 1);
