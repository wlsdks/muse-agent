#!/usr/bin/env node
// Work-status dashboard generator — reads the markdown records (backlog.md,
// git log, the self-eval scoreboard) and emits ONE self-contained HTML
// (docs/status.html) so a human can see "what got done / what's next / is it
// healthy" at a glance, without reading code, git, or a 3k-line backlog.
//
//   pnpm status            # build docs/status.html and print its path
//   pnpm status --open     # also open it in the default browser
//
// Self-contained (inline CSS, data baked in) so it works from file:// offline.
// Re-run to refresh. The pure parsers are exported + unit-tested
// (build-status-dashboard.test.mjs); this file is the fs/git IO + render shell.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// 2026-07-17 ledger grammar: `- [status] date key=value :: text` — the old
// symbol markers no longer exist in the ledgers (check-ledger-format.mjs).
const STATUS_TO_BUCKET = { done: "done", open: "ready", decision: "blocked", blocked: "blocked" };

/** Parse the backlog markdown into counts + the actionable item lists. Pure. */
export function parseBacklog(md) {
  const counts = { done: 0, ready: 0, next: 0, blocked: 0 };
  const items = { ready: [], next: [], blocked: [] };
  for (const rawLine of md.split("\n")) {
    const m = /^- \[(open|done|blocked|decision|rejected|superseded)\]\s+(.*\S)/u.exec(rawLine);
    if (!m) continue;
    let bucket = STATUS_TO_BUCKET[m[1]];
    if (!bucket) continue; // rejected/superseded are decision history, not workload
    const head = m[2].split(" :: ")[0];
    // prio=4+ open items are the highlighted "next" bucket (disjoint from ready)
    if (bucket === "ready" && /\bprio=[45]\b/u.test(head)) bucket = "next";
    counts[bucket] += 1;
    const text = m[2].includes(" :: ") ? m[2].split(" :: ").slice(1).join(" :: ") : m[2].replace(/^::\s*/u, "");
    if (bucket !== "done") items[bucket].push(cleanText(text));
  }
  return { counts, items };
}

/** Strip the heaviest markdown so a backlog line reads as plain text. Pure. */
export function cleanText(s, max = 160) {
  const plain = s
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

/** Parse `git log --pretty=%h\t%ar\t%s` output into typed commit rows. Pure. */
export function parseCommits(raw) {
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((line) => {
      const [hash, when, ...rest] = line.split("\t");
      const subject = rest.join("\t");
      const typeMatch = /^(feat|fix|docs|perf|refactor|test|chore|build|ci)(\([^)]*\))?(!)?:/u.exec(subject);
      return { hash, when, subject, type: typeMatch ? typeMatch[1] : "other" };
    });
}

/** The latest self-eval scoreboard entry flattened to gate rows. Pure. */
export function latestScoreboard(scoreboard) {
  const entry = Array.isArray(scoreboard) ? scoreboard[scoreboard.length - 1] : scoreboard;
  if (!entry || typeof entry !== "object" || !entry.gates) return { at: undefined, gates: [] };
  const gates = Object.entries(entry.gates).map(([name, g]) => ({
    name,
    status: g?.status ?? "unknown",
    value: typeof g?.value === "number" ? g.value : undefined
  }));
  return { at: entry.at, gates };
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/gu, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/**
 * Parse `--watch [seconds]` into a regenerate interval in ms, or undefined for a
 * one-shot. Bare `--watch` ⇒ 5s; an explicit positive integer overrides; a
 * garbage value falls back to 5s (never 0/NaN, which would busy-loop). Pure.
 */
export function parseWatchIntervalMs(args) {
  const i = args.indexOf("--watch");
  if (i === -1) return undefined;
  const raw = args[i + 1];
  const secs = raw !== undefined && /^\d+$/u.test(raw) ? Number.parseInt(raw, 10) : 0;
  return (secs > 0 ? secs : 5) * 1000;
}

/** Render the whole dashboard as one self-contained HTML string. Pure. */
export function renderDashboardHtml({ project, branch, generatedAt, inSync, gates, scoreboardAt, commits, backlog, refreshSeconds }) {
  const e = escapeHtml;
  // In --watch mode the page reloads itself so an OPEN tab tracks the regenerated
  // file live (works over file:// too); omitted for a one-shot so a parked tab
  // doesn't reload against a frozen file.
  const refreshMeta = typeof refreshSeconds === "number" && refreshSeconds > 0
    ? `<meta http-equiv="refresh" content="${Math.round(refreshSeconds)}">`
    : "";
  const gateChip = (g) => {
    const cls = g.status === "pass" ? "ok" : g.status === "fail" ? "bad" : "warn";
    const val = g.value !== undefined ? `<b>${g.value}</b>` : (g.status === "pass" ? "✓" : g.status);
    return `<div class="chip ${cls}"><span>${e(g.name)}</span>${val}</div>`;
  };
  const commitRow = (c) => `<li class="commit type-${e(c.type)}"><code>${e(c.hash)}</code><span class="subj">${e(c.subject)}</span><time>${e(c.when)}</time></li>`;
  const itemRow = (t) => `<li>${e(t)}</li>`;
  const section = (title, kind, list, cap) => {
    if (list.length === 0) return "";
    const shown = list.slice(0, cap).map(itemRow).join("");
    const more = list.length > cap ? `<li class="more">+ ${list.length - cap}개 더…</li>` : "";
    return `<div class="card ${kind}"><h3>${title} <em>${list.length}</em></h3><ul class="items">${shown}${more}</ul></div>`;
  };
  const c = backlog.counts;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refreshMeta}
<title>${e(project)} — 작업 상황판</title><style>
:root{--bg:#0d1117;--card:#161b22;--bd:#30363d;--fg:#e6edf3;--mut:#8b949e;--ok:#3fb950;--bad:#f85149;--warn:#d29922;--blue:#58a6ff}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg)}
header{padding:20px 24px;border-bottom:1px solid var(--bd);display:flex;flex-wrap:wrap;align-items:baseline;gap:12px}
header h1{margin:0;font-size:20px}header .meta{color:var(--mut);font-size:12px}
header .sync{margin-left:auto;font-weight:600}.sync.yes{color:var(--ok)}.sync.no{color:var(--warn)}
main{padding:20px 24px;max-width:1100px;margin:0 auto}
.row{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px}
.stat{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:14px}
.stat b{display:block;font-size:26px}.stat span{color:var(--mut);font-size:12px}
.stat.next b{color:var(--blue)}.stat.ready b{color:var(--ok)}.stat.blocked b{color:var(--warn)}.stat.done b{color:var(--mut)}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:var(--mut);margin:24px 0 10px}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{background:var(--card);border:1px solid var(--bd);border-radius:20px;padding:5px 12px;font-size:12px;display:flex;gap:8px;align-items:center}
.chip span{color:var(--mut)}.chip.ok{border-color:#1f6f33}.chip.ok b{color:var(--ok)}.chip.bad{border-color:#7d2b28}.chip.bad b{color:var(--bad)}.chip.warn b{color:var(--warn)}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:14px 16px;margin-bottom:16px}
.card h3{margin:0 0 10px;font-size:14px}.card h3 em{color:var(--mut);font-style:normal;font-weight:400}
.card.next{border-left:3px solid var(--blue)}.card.ready{border-left:3px solid var(--ok)}.card.blocked{border-left:3px solid var(--warn)}
ul{margin:0;padding:0;list-style:none}.items li{padding:6px 0;border-top:1px solid var(--bd);font-size:13px}.items li:first-child{border-top:0}
.items li.more{color:var(--mut);font-style:italic}
ul.commits li{display:flex;gap:10px;align-items:baseline;padding:6px 0;border-top:1px solid var(--bd);font-size:13px}ul.commits li:first-child{border-top:0}
.commit code{color:var(--mut);flex:none}.commit .subj{flex:1;min-width:0}.commit time{color:var(--mut);font-size:11px;flex:none}
.commit.type-feat .subj{color:var(--ok)}.commit.type-fix .subj{color:var(--bad)}.commit.type-perf .subj{color:var(--blue)}.commit.type-docs .subj,.commit.type-chore .subj,.commit.type-test .subj,.commit.type-refactor .subj{color:var(--mut)}
footer{padding:16px 24px;color:var(--mut);font-size:12px;border-top:1px solid var(--bd);max-width:1100px;margin:0 auto}
footer code{background:var(--card);padding:2px 6px;border-radius:5px}
@media(max-width:760px){.row{grid-template-columns:repeat(2,1fr)}.cols{grid-template-columns:1fr}}
</style></head><body>
<header><h1>🧭 ${e(project)} 작업 상황판</h1><span class="meta">브랜치 <b>${e(branch)}</b> · 생성 ${e(generatedAt)}</span>
<span class="sync ${inSync ? "yes" : "no"}">${inSync ? "● origin 동기화됨" : "● 미푸시 커밋 있음"}</span></header>
<main>
<div class="row">
<div class="stat next"><b>${c.next}</b><span>★ 다음 우선</span></div>
<div class="stat ready"><b>${c.ready}</b><span>◦ 할 수 있음</span></div>
<div class="stat blocked"><b>${c.blocked}</b><span>⏳ 막힘(결정 필요)</span></div>
<div class="stat done"><b>${c.done}</b><span>✓ 완료(누적)</span></div>
</div>
<h2>🟢 프로젝트 건강 (self-eval ${scoreboardAt ? `· ${e(scoreboardAt)}` : ""})</h2>
<div class="chips">${gates.map(gateChip).join("") || '<span class="meta">스코어보드 없음 — pnpm self-eval 실행</span>'}</div>
<h2>🔨 최근 한 일</h2>
<ul class="commits">${commits.map(commitRow).join("")}</ul>
<h2>📋 지금 백로그</h2>
<div class="cols"><div>${section("★ 다음 우선", "next", backlog.items.next, 8)}${section("◦ 할 수 있음", "ready", backlog.items.ready, 12)}</div>
<div>${section("⏳ 막힘 — 네 결정 필요", "blocked", backlog.items.blocked, 10)}</div></div>
</main>
<footer>📄 MD 기록(backlog.md · git log · self-eval 스코어보드)에서 생성됨. 새로고침: <code>pnpm status</code> 다시 실행 후 이 페이지 reload. 열기: <code>pnpm status --open</code></footer>
</body></html>`;
}

function safeRead(path) {
  try { return readFileSync(join(ROOT, path), "utf8"); } catch { return ""; }
}

function buildOnce(refreshSeconds) {
  const backlogMd = safeRead("docs/goals/backlog.md");
  let scoreboard = [];
  try { scoreboard = JSON.parse(safeRead("docs/self-eval-scoreboard.json") || "[]"); } catch { /* keep empty */ }

  const git = (cmd, fallback = "") => {
    try { return execSync(cmd, { cwd: ROOT, encoding: "utf8" }).trim(); } catch { return fallback; }
  };
  const branch = git("git rev-parse --abbrev-ref HEAD", "?");
  const commitsRaw = git("git log -25 --pretty=format:%h%x09%ar%x09%s");
  const ahead = git("git rev-list --count @{upstream}..HEAD 2>/dev/null", "0");
  const inSync = ahead === "0";

  const { at: scoreboardAt, gates } = latestScoreboard(scoreboard);
  const html = renderDashboardHtml({
    project: "Muse",
    branch,
    generatedAt: new Date().toLocaleString("ko-KR"),
    inSync,
    gates,
    scoreboardAt: scoreboardAt ? new Date(scoreboardAt).toLocaleString("ko-KR") : undefined,
    commits: parseCommits(commitsRaw),
    backlog: parseBacklog(backlogMd),
    ...(refreshSeconds ? { refreshSeconds } : {})
  });

  const out = join(ROOT, "docs/status.html");
  writeFileSync(out, html, "utf8");
  return out;
}

function main() {
  const intervalMs = parseWatchIntervalMs(process.argv);
  const refreshSeconds = intervalMs ? Math.round(intervalMs / 1000) : undefined;
  const out = buildOnce(refreshSeconds);
  if (intervalMs) {
    process.stdout.write(`작업 상황판 watch 모드 (${refreshSeconds}s마다 갱신) → ${out}\n열어두면 자동 새로고침됩니다. 종료: Ctrl+C\n`);
  } else {
    process.stdout.write(`작업 상황판 생성됨 → ${out}\n브라우저에서 열기: open ${out}\n`);
  }
  if (process.argv.includes("--open")) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    try { execSync(`${opener} "${out}"`); } catch { /* opening is best-effort */ }
  }
  if (intervalMs) {
    // Regenerate on an interval; the page's meta-refresh reloads the open tab.
    setInterval(() => { try { buildOnce(refreshSeconds); } catch { /* transient git/fs error — keep watching */ } }, intervalMs);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
