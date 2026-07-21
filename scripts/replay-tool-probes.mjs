#!/usr/bin/env node
/**
 * Re-run reported tool probes and capture what actually happens NOW.
 *
 * Verification here is deterministic — the same command against the same tool
 * gives the same answer — so it does not need a model. This replaces a
 * per-finding LLM verifier with one script, and produces evidence a judge can
 * read in bulk instead of re-deriving.
 *
 * Input:  a JSON array of findings, each with a `command` containing a
 *         `probe-tool-runtime.mjs <tool> '<json>'` invocation.
 * Output: the same findings, each with `replay` — the live result, or the
 *         reason it could not be replayed.
 *
 * Usage: node scripts/replay-tool-probes.mjs <findings.json> <out.json>
 */

import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { promisify } from "node:util";

const run = promisify(execFile);
const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error("usage: replay-tool-probes.mjs <findings.json> <out.json>");
  process.exit(2);
}

/**
 * Pull the FIRST probe invocation out of a reported command. Agents often
 * append prose ("(also: …)") after the command, so the args are matched as a
 * balanced single-quoted span rather than to end-of-line.
 */
function parseProbe(command) {
  const match = /probe-tool-runtime\.mjs\s+([\w.]+)\s+'([^']*)'/u.exec(command ?? "");
  if (!match) return undefined;
  return { args: match[2], tool: match[1] };
}

const findings = JSON.parse(readFileSync(inputPath, "utf8"));
const replayed = [];
let ok = 0;
let unparseable = 0;
let failed = 0;

for (const finding of findings) {
  const probe = parseProbe(finding.command);
  if (!probe) {
    unparseable += 1;
    replayed.push({ ...finding, replay: { note: "no runnable probe command in the report", replayed: false } });
    continue;
  }
  try {
    const { stdout } = await run("node", ["scripts/probe-tool-runtime.mjs", probe.tool, probe.args], {
      cwd: process.cwd(),
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000
    });
    ok += 1;
    replayed.push({
      ...finding,
      replay: { args: probe.args, output: stdout.trim().slice(0, 3000), replayed: true, tool: probe.tool }
    });
  } catch (cause) {
    failed += 1;
    replayed.push({
      ...finding,
      replay: {
        args: probe.args,
        note: `probe could not run: ${cause instanceof Error ? cause.message.slice(0, 200) : String(cause)}`,
        replayed: false,
        tool: probe.tool
      }
    });
  }
}

writeFileSync(outputPath, JSON.stringify(replayed, null, 1));
console.log(`replayed ${ok.toString()} / ${findings.length.toString()} (${unparseable.toString()} had no command, ${failed.toString()} failed to run)`);
