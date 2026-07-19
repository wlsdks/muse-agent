import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  return value;
}

export function canonicalJson(value) { return JSON.stringify(canonicalValue(value)); }
export function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
export function jsonBytes(value) { return `${canonicalJson(value)}\n`; }
export function safeName(value) { return value.replaceAll(/[^a-z0-9.-]/giu, "_"); }

export function nearestRank(values, percentile) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)].toFixed(3));
}

export function summarizeRerankDecisions(outcomes) {
  const summary = { absent: 0, eligible: 0, empty: 0, error: 0, httpAttempts: 0, ineligibleWindow: 0, invalid: 0, logicalInvocations: 0, success: 0, timeout: 0 };
  for (const item of outcomes) {
    const decision = item.rerankDecision;
    summary.httpAttempts += decision.httpAttempts;
    summary.logicalInvocations += decision.logicalInvocations;
    if (decision.eligible) summary.eligible += 1;
    const key = decision.outcome === "ineligible-window" ? "ineligibleWindow" : decision.outcome;
    summary[key] += 1;
  }
  return summary;
}

export async function writeAtomic(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, value, { mode });
  await rename(temporary, path);
}

export async function manifestTree(root) {
  const entries = [];
  async function visit(path) {
    let info;
    try { info = await lstat(path); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    const rel = relative(root, path) || ".";
    const base = { mode: info.mode & 0o7777, path: rel, size: info.size, type: info.isDirectory() ? "directory" : info.isFile() ? "file" : info.isSymbolicLink() ? "symlink" : "other" };
    if (info.isFile()) entries.push({ ...base, sha256: sha256(await readFile(path)) });
    else {
      entries.push({ ...base, sha256: null });
      if (info.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    }
  }
  await visit(root);
  return { entries, manifestSha256: sha256(jsonBytes(entries)) };
}

export function canonicalLoopbackBaseUrl(raw = "http://127.0.0.1:11434") {
  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  if (!["127.0.0.1", "localhost", "::1"].includes(host) || !["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Ollama must be loopback");
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/u, "")}`;
}

export async function modelInfo(baseUrl, modelTag) {
  const [versionResponse, tagsResponse] = await Promise.all([
    fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(10_000) }),
    fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(10_000) })
  ]);
  if (!versionResponse.ok || !tagsResponse.ok) throw new Error("OLLAMA_UNREACHABLE");
  const version = await versionResponse.json();
  const tags = await tagsResponse.json();
  const accepted = modelTag.includes(":") ? [modelTag] : [modelTag, `${modelTag}:latest`];
  const found = tags.models?.find((item) => accepted.includes(item.name) || accepted.includes(item.model));
  if (!found || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(found.digest)) throw new Error(`MODEL_MISSING_OR_DIGEST:${modelTag}`);
  return { digest: found.digest, ollamaVersion: String(version.version ?? ""), resolvedTag: String(found.model ?? found.name) };
}

export async function runtimeSourceProvenance(repoRoot, paths) {
  return Promise.all(paths.map(async (path) => ({ path, sha256: sha256(await readFile(join(repoRoot, path))) })));
}
