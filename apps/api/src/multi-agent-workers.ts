/**
 * The orchestration WORKER-agent factories — summarizer (condenses a sub-agent's
 * output for the parent), answer-verifier (judges whether the synthesized answer
 * satisfies the request), and synthesizer (fuses worker outputs into one answer).
 * Each returns a bound async function (or undefined when no model provider), with
 * its own system prompt + token/timeout budget. Split out of multi-agent-routes.ts
 * so the route wiring and the agent-construction logic have separate homes.
 */

import type { ModelProvider } from "@muse/model";
import { setTimeout as sleepWithTimer } from "node:timers/promises";

const SUMMARIZER_SYSTEM_PROMPT =
  "You are summarizing the output of a sub-agent for a parent orchestrator. Return a single concise summary (3 sentences max) capturing the key facts, decisions, and any error / blocker. Drop reasoning steps and verbose framing. Output the summary text only — no preamble, no markdown.";
const SUMMARIZER_MAX_OUTPUT_TOKENS = 256;
const SUMMARIZER_REQUEST_TIMEOUT_MS = 15_000;

async function callWithTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return operation;
  }
  const timeoutController = new AbortController();
  const timeout = (async () => {
    await sleepWithTimer(timeoutMs, undefined, { signal: timeoutController.signal, ref: false });
    throw new Error(message);
  })();
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    timeoutController.abort();
  }
}

export function createWorkerSummarizer(
  modelProvider: ModelProvider | undefined,
  model: string
): ((workerId: string, output: string) => Promise<string>) | undefined {
  if (!modelProvider) {
    return undefined;
  }
  return async (workerId, output) => {
    const userContent = `Sub-agent id: ${workerId}\n\nSub-agent output:\n${output}`;
    const response = await callWithTimeout(
      modelProvider.generate({
        maxOutputTokens: SUMMARIZER_MAX_OUTPUT_TOKENS,
        messages: [
          { content: SUMMARIZER_SYSTEM_PROMPT, role: "system" },
          { content: userContent, role: "user" }
        ],
        model,
        temperature: 0.2
      }),
      SUMMARIZER_REQUEST_TIMEOUT_MS,
      "summarizer timeout"
    );
    const text = response.output?.trim() ?? "";
    return text.length > 0 ? text : output;
  };
}

const SYNTHESIZER_SYSTEM_PROMPT =
  "You are the final synthesizer for a multi-agent orchestrator. You are given each sub-agent's output (e.g. a direct answer plus a risks/gaps review). Fuse them into ONE coherent answer for the user: lead with the answer, then fold in the most important risks/caveats. Resolve overlaps, drop the per-agent headers, and do not invent facts beyond what the sub-agents provided. Output the final answer text only — no preamble, no '## agent' markers.";
const SYNTHESIZER_MAX_OUTPUT_TOKENS = 512;

// Verification against the original objective (MAST +15.6%). A SEPARATE judge
// (maker ≠ judge) — never the synthesizer self-grading (LLMs can't reliably
// self-correct, arXiv 2310.01798). Strict one-line verdict so it parses
// deterministically on the local model.
const VERIFIER_SYSTEM_PROMPT =
  "You are a strict completeness checker for an answer produced by a multi-agent system. Given the USER REQUEST and the ANSWER, decide if the answer FULLY satisfies every part the user asked for. Reply with EXACTLY one line and nothing else: `SATISFIED` if it does, or `MISSING: <the specific part the answer fails to cover>` if a requested part is absent. Judge only completeness against the request — not style, length, or tone. When unsure, prefer SATISFIED.";
const VERIFIER_MAX_OUTPUT_TOKENS = 80;

/**
 * Build the final-answer verifier wired to the real model provider — the live
 * half of the orchestrator's `verifyFinalAnswer` seam. Parses the strict
 * one-line verdict deterministically; an unparseable verdict is treated as
 * SATISFIED so a healthy answer is never falsely flagged.
 */
export function createAnswerVerifier(
  modelProvider: ModelProvider | undefined,
  model: string
): ((objective: string, output: string) => Promise<{ readonly satisfied: boolean; readonly missing?: string }>) | undefined {
  if (!modelProvider) {
    return undefined;
  }
  return async (objective, output) => {
    const response = await callWithTimeout(
      modelProvider.generate({
        maxOutputTokens: VERIFIER_MAX_OUTPUT_TOKENS,
        messages: [
          { content: VERIFIER_SYSTEM_PROMPT, role: "system" },
          { content: `USER REQUEST:\n${objective}\n\nANSWER:\n${output}`, role: "user" }
        ],
        model,
        temperature: 0
      }),
      SYNTHESIZER_REQUEST_TIMEOUT_MS,
      "verifier timeout"
    );
    const text = (response.output ?? "").trim();
    const missing = /^\s*missing\s*:\s*(.+)$/im.exec(text);
    if (missing && missing[1]) {
      return { missing: missing[1].trim(), satisfied: false };
    }
    // SATISFIED, or anything unparseable → do not falsely flag a healthy answer.
    return { satisfied: true };
  };
}
const SYNTHESIZER_REQUEST_TIMEOUT_MS = 20_000;

export function createWorkerSynthesizer(
  modelProvider: ModelProvider | undefined,
  model: string
): ((parts: ReadonlyArray<{ readonly workerId: string; readonly output: string }>, guidance?: string) => Promise<string>) | undefined {
  if (!modelProvider) {
    return undefined;
  }
  return async (parts, guidance) => {
    // `guidance` is the verifier's gap (evaluator-optimizer retry) — steer the
    // re-synthesis to cover it, still grounded in the sub-agents' outputs.
    const guidanceLine = guidance && guidance.trim().length > 0 ? `\n\n[Guidance: ${guidance.trim()}]` : "";
    const userContent = `${parts.map((p) => `### ${p.workerId}\n${p.output}`).join("\n\n")}${guidanceLine}`;
    const response = await callWithTimeout(
      modelProvider.generate({
        maxOutputTokens: SYNTHESIZER_MAX_OUTPUT_TOKENS,
        messages: [
          { content: SYNTHESIZER_SYSTEM_PROMPT, role: "system" },
          { content: userContent, role: "user" }
        ],
        model,
        temperature: 0.3
      }),
      SYNTHESIZER_REQUEST_TIMEOUT_MS,
      "synthesizer timeout"
    );
    return response.output?.trim() ?? "";
  };
}
