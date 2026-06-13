/**
 * Muse agent-eval harness — the reusable Dataset → Solver → Scorer → Report
 * engine the live eval batteries (eval:tools, future task-completion /
 * adversarial / LLM-judge batteries) run on. Deliberately tiny + dependency-
 * free (no devDep / lockfile change), but shaped after the converged 2026
 * best practice so batteries stay declarative:
 *
 *   - Dataset  : an array of scenarios, each a labelled bag of cases.
 *   - Solver   : `solve(case, scenario) -> observed` — elicits the behavior
 *                (one or multi-step; may call a real model / loop / tool).
 *   - Scorer   : `score(observed, case, scenario) -> { ok, detail }` —
 *                DETERMINISTIC code first (the cheap, reliable tier); an
 *                LLM-as-judge scorer is just an async scorer that returns the
 *                same shape, reserved for subjective qualities code can't grade.
 *   - Report   : per-case PASS/FAIL streamed, per-scenario + overall tally,
 *                gated against a threshold.
 *
 * Stochastic models aren't proved by one pass: `repeat` runs each case N times
 * and counts it passed only if EVERY run passes (surfaces flaky selections).
 *
 * Sources (shape): Inspect AI (UK AISI) dataset/solver/scorer/task primitives;
 * Braintrust + promptfoo "code-based scorers first, LLM-judge only for
 * subjective qualities"; Hamel Husain "Your AI Product Needs Evals" (evals gate
 * development, not vibe-checks).
 *   https://github.com/UKGovernmentBEIS/inspect_ai
 *   https://www.braintrust.dev/articles/how-to-eval
 *   https://www.promptfoo.dev/docs/guides/
 *   https://hamel.dev/blog/posts/evals/
 */

/**
 * Run a scored eval suite. Returns { passed, total, rate, gate } and streams a
 * report. Does NOT exit the process — the caller decides (so the harness is
 * usable both as a CLI gate and inline).
 *
 * @param {object} opts
 * @param {string} opts.name              suite name for the report + gate line
 * @param {readonly {label:string, skip?:string, cases:readonly any[], tools?:readonly any[]}[]} opts.scenarios
 * @param {(testCase:any, scenario:any) => Promise<any>} opts.solve
 * @param {(observed:any, testCase:any, scenario:any) => ({ok:boolean,detail:string}|Promise<{ok:boolean,detail:string}>)} opts.score
 * @param {number} [opts.repeat=1]
 * @param {number} [opts.threshold=0.85]
 * @param {(line:string)=>void} [opts.log=console.log]
 * @param {(line:string)=>void} [opts.err=console.error]
 */
export async function runEvalSuite(opts) {
  const { name, scenarios, solve, score } = opts;
  const repeat = Math.max(1, Math.trunc(opts.repeat ?? 1));
  const threshold = opts.threshold ?? 0.85;
  const log = opts.log ?? console.log;
  const err = opts.err ?? console.error;

  let total = 0;
  let passed = 0;
  for (const scenario of scenarios) {
    if (scenario.skip) {
      log(`\n[${scenario.label}] SKIP — ${scenario.skip}`);
      continue;
    }
    const toolNote = scenario.tools ? ` (tools: ${scenario.tools.map((t) => t.name).join(", ")})` : "";
    log(`\n[${scenario.label}] ${scenario.cases.length} cases${toolNote}`);
    for (const testCase of scenario.cases) {
      total += 1;
      let runsPassed = 0;
      let lastDetail = "";
      for (let run = 0; run < repeat; run += 1) {
        let result;
        try {
          const observed = await solve(testCase, scenario);
          result = await score(observed, testCase, scenario);
        } catch (error) {
          result = { ok: false, detail: `threw: ${error instanceof Error ? error.message : String(error)}` };
        }
        if (result.ok) runsPassed += 1;
        lastDetail = result.detail;
        if (!result.ok) break; // strict: a single failing run fails the case
      }
      const ok = runsPassed === repeat;
      if (ok) passed += 1;
      const stability = repeat > 1 ? ` [${runsPassed}/${repeat} runs]` : "";
      log(`  ${ok ? "PASS" : "FAIL"}${stability}  [${testCase.note ?? testCase.prompt ?? ""}] ${lastDetail}`);
    }
  }

  const rate = total === 0 ? 0 : passed / total;
  log(`\n--- ${passed}/${total} (${(rate * 100).toFixed(0)}%) ; threshold ${(threshold * 100).toFixed(0)}%`);
  const gate = total > 0 && rate >= threshold;
  if (gate) log(`${name} PASSED`);
  else err(`${name} FAILED — ${(rate * 100).toFixed(0)}% below ${(threshold * 100).toFixed(0)}%`);
  return { gate, passed, rate, total };
}

/**
 * Deterministic scorer combinators for tool-using batteries. Each returns the
 * `{ ok, detail }` shape; `combineScorers` ANDs them (first failure wins) so a
 * case asserts selection + arguments together. An LLM-judge scorer is simply a
 * separate async function returning the same shape — not needed here.
 */
export const toolScorers = {
  /** Expect zero tool calls (no eager invocation). */
  noTool: () => (toolCalls) =>
    toolCalls.length === 0
      ? { ok: true, detail: "no tool (correct)" }
      : { ok: false, detail: `eager call: ${toolCalls.map((c) => c.name).join(",")}` },
  /**
   * Expect NO state-changing tool to fire — READ tools are allowed. The IrrelAcc
   * case `noTool` can't express ("report what I did yesterday" may legitimately call
   * a recall read, but must NEVER fire calendar_add/web_action). Pass the WRITE/EXECUTE
   * tool names; over-firing an ACTUATOR is the highest-blast-radius wrong selection.
   */
  noWrite: (writeToolNames) => (toolCalls) => {
    const writes = new Set(writeToolNames);
    const fired = toolCalls.filter((c) => writes.has(c.name)).map((c) => c.name);
    return fired.length === 0
      ? { ok: true, detail: `no write tool (reads ok: ${toolCalls.map((c) => c.name).join(",") || "none"})` }
      : { ok: false, detail: `fired write tool(s): ${fired.join(",")}` };
  },
  /** Expect the first tool call to be `name`. */
  selected: (name) => (toolCalls) => {
    const call = toolCalls[0];
    if (!call) return { ok: false, detail: "no tool selected (expected one)" };
    return call.name === name ? { ok: true, detail: `${call.name}(${JSON.stringify(call.arguments ?? {})})` } : { ok: false, detail: `picked ${call.name}, wanted ${name}` };
  },
  /** The first call's stringified args must match `regex`. */
  argMatches: (regex) => (toolCalls) => {
    const args = toolCalls[0]?.arguments ?? {};
    return regex.test(JSON.stringify(args)) ? { ok: true, detail: "args match" } : { ok: false, detail: `args ${JSON.stringify(args)} miss ${regex}` };
  },
  /**
   * The first call's SPECIFIC `field` arg (a string) must match `regex` — unlike
   * argMatches, which tests the whole args blob and so passes when the token
   * merely appears in a sibling field. Field-targeted, so a time phrase asserted
   * on `dueAt` is NOT satisfied by the same word sitting in `text`. This is what
   * re-arms the time-field regression class (a `*Iso` field name makes an 8B
   * precompute a WRONG timestamp into the field instead of copying the user's
   * phrase — an ISO carries no "tomorrow"/"내일", so the assertion catches it).
   */
  argFieldMatches: (field, regex) => (toolCalls) => {
    const args = toolCalls[0]?.arguments ?? {};
    const value = args[field];
    if (typeof value !== "string") return { ok: false, detail: `arg '${field}' absent/non-string in ${JSON.stringify(args)}` };
    return regex.test(value) ? { ok: true, detail: `${field} matches ${regex}` } : { ok: false, detail: `${field}=${JSON.stringify(value)} misses ${regex}` };
  },
  /** Every required arg key must be present + non-empty on the first call (ArgumentCorrectness). */
  argsPresent: (keys) => (toolCalls) => {
    const args = toolCalls[0]?.arguments ?? {};
    const missing = keys.filter((k) => args[k] === undefined || args[k] === null || (typeof args[k] === "string" && args[k].trim().length === 0));
    return missing.length === 0 ? { ok: true, detail: "required args present" } : { ok: false, detail: `missing/empty required arg(s) [${missing.join(", ")}] in ${JSON.stringify(args)}` };
  },
};

/**
 * LLM-as-judge (GEval) scorer factory — the SUBJECTIVE-quality tier, reserved
 * for what deterministic code can't grade (tone, refusal, on-topic, language).
 * Strict single-word PASS/FAIL verdict, temperature 0; the suite's `repeat`
 * provides stochastic stability. The case carries `{ rubric, expectVerdict }`
 * ("PASS"|"FAIL"); the scorer asks the judge model whether `output` satisfies
 * the rubric and passes when the verdict matches the expectation.
 *
 * @param {{ generate: (req:any)=>Promise<{output?:string}> }} provider
 * @param {string} model
 */
export function llmJudge(provider, model) {
  const system =
    "You are a strict evaluator. Given a RUBRIC and an OUTPUT, decide if the OUTPUT satisfies the RUBRIC. "
    + "Respond with EXACTLY one word on the first line: PASS or FAIL. Then one short reason line. Do not output anything else.";
  return async (output, testCase) => {
    const expect = (testCase.expectVerdict ?? "PASS").toUpperCase();
    const response = await provider.generate({
      maxOutputTokens: 120,
      messages: [
        { content: system, role: "system" },
        { content: `RUBRIC: ${testCase.rubric}\n\nOUTPUT:\n${typeof output === "string" ? output : JSON.stringify(output)}`, role: "user" },
      ],
      model,
      temperature: 0,
    });
    const text = (response.output ?? "").trim();
    const verdict = /^\s*pass\b/iu.test(text) ? "PASS" : /^\s*fail\b/iu.test(text) ? "FAIL" : "?";
    return verdict === expect
      ? { ok: true, detail: `judge ${verdict} (expected ${expect})` }
      : { ok: false, detail: `judge ${verdict}, expected ${expect} — ${text.split("\n").slice(0, 2).join(" / ")}` };
  };
}

/**
 * OpenClaw-style promotion SHADOW TRIAL (report-only). Before a candidate
 * memory / distilled strategy is promoted to the live store, compare a BASELINE
 * answer (no memory) with a CANDIDATE answer (allowed to use the memory) for a
 * probe question and emit a structured verdict — PROMOTE only if the candidate
 * is more helpful AND the memory introduces no false/unsafe claim, else HOLD.
 *
 * REPORT-ONLY BY CONSTRUCTION: takes no store handle and returns a report
 * object; it never writes anywhere — the caller decides whether to act on it,
 * exactly like OpenClaw keeps the dream report separate from live MEMORY.md.
 *
 * @returns {Promise<{verdict:"PROMOTE"|"HOLD"|"?", reason:string, risk:string}>}
 */
export async function runShadowTrial(provider, model, input) {
  const system =
    "You review a CANDIDATE memory before it is promoted to long-term store. Compare the BASELINE answer (no memory) "
    + "with the CANDIDATE answer (allowed to use the memory) for the PROBE question. Reply with EXACTLY three lines:\n"
    + "VERDICT: PROMOTE or HOLD\nREASON: <one short line>\nRISK: <one short line, or 'none'>\n"
    + "PROMOTE only if the candidate answer is more helpful AND the memory introduces no false or unsafe claim. Otherwise HOLD.";
  const user = `PROBE: ${input.probe}\n\nBASELINE: ${input.baseline}\n\nCANDIDATE MEMORY: ${input.memory}\nCANDIDATE ANSWER: ${input.candidate}`;
  const response = await provider.generate({ maxOutputTokens: 160, messages: [{ content: system, role: "system" }, { content: user, role: "user" }], model, temperature: 0 });
  const text = (response.output ?? "").trim();
  const verdict = /verdict:\s*promote/iu.test(text) ? "PROMOTE" : /verdict:\s*hold/iu.test(text) ? "HOLD" : "?";
  const reason = /reason:\s*(.+)/iu.exec(text)?.[1]?.trim() ?? "";
  const risk = /risk:\s*(.+)/iu.exec(text)?.[1]?.trim() ?? "";
  return { reason, risk, verdict };
}

/** Scorer wrapping a shadow trial: passes when the verdict matches the case's expectVerdict. */
export function shadowTrialScorer(provider, model) {
  return async (_observed, testCase) => {
    const report = await runShadowTrial(provider, model, testCase);
    return report.verdict === testCase.expectVerdict
      ? { ok: true, detail: `${report.verdict} — ${report.reason}` }
      : { ok: false, detail: `got ${report.verdict}, expected ${testCase.expectVerdict} — ${report.reason}` };
  };
}

/** AND a list of `{ok,detail}` scorers; first failure's detail wins, else the last detail. */
export function combineScorers(...fns) {
  return async (observed, testCase, scenario) => {
    let detail = "";
    for (const fn of fns) {
      const r = await fn(observed, testCase, scenario);
      if (!r.ok) return r;
      detail = r.detail;
    }
    return { ok: true, detail };
  };
}
