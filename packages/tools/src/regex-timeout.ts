/**
 * Run a regex against text under a HARD wall-clock deadline.
 *
 * A JavaScript regex cannot be interrupted on the main thread — a catastrophic
 * pattern like `(a+)+$` or `(a|aa)+$` against 40 characters backtracks for tens
 * of SECONDS (measured: 54s), hanging the shared process. Static classification
 * of "is this pattern safe" is undecidable in general, so the only complete
 * defence is to run the match somewhere it can be KILLED. This executes it in a
 * worker thread and terminates the worker if it blows the deadline.
 *
 * The worker source is an inline string (`eval: true`) so there is no separate
 * file for a bundler or the monorepo's dist layout to locate at runtime — the
 * matching is pure (pattern, flags, text in; matches out) and needs nothing
 * from this package.
 */

import { Worker } from "node:worker_threads";

// ESM source: the parent package is ESM, so an `eval: true` worker is evaluated
// as a module — `require` is not defined, and top-level await + dynamic import
// are the portable way to reach `worker_threads`.
const WORKER_SOURCE = `
const { parentPort, workerData } = await import("node:worker_threads");
try {
  const regex = new RegExp(workerData.pattern, workerData.flags);
  const matches = [];
  for (const match of workerData.text.matchAll(regex)) {
    const value = match[1] ?? match[0];
    if (typeof value === "string") matches.push(value);
    if (matches.length >= workerData.maxMatches) break;
  }
  parentPort.postMessage({ matches, ok: true });
} catch (error) {
  parentPort.postMessage({ message: String(error && error.message ? error.message : error), ok: false });
}
`;

export interface RegexRunResult {
  readonly matches?: readonly string[];
  readonly error?: string;
  readonly timedOut?: boolean;
}

/**
 * Compile and run `pattern` against `text`, returning up to `maxMatches`. On a
 * compile error returns `{ error }`; on exceeding `timeoutMs` returns
 * `{ timedOut: true }` after killing the worker. Never runs the regex on the
 * calling thread, so it can never hang the caller.
 */
export async function runRegexMatchesWithTimeout(
  pattern: string,
  flags: string,
  text: string,
  maxMatches: number,
  timeoutMs: number
): Promise<RegexRunResult> {
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { flags, maxMatches, pattern, text }
  });

  return await new Promise<RegexRunResult>((resolve) => {
    let settled = false;
    const finish = (result: RegexRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ timedOut: true });
    }, timeoutMs);
    // The deadline timer must not itself keep the process alive.
    if (typeof timer.unref === "function") timer.unref();

    worker.on("message", (msg: { ok: boolean; matches?: readonly string[]; message?: string }) => {
      finish(msg.ok ? { matches: msg.matches ?? [] } : { error: msg.message ?? "regex failed" });
    });
    worker.on("error", (cause: Error) => {
      finish({ error: cause.message });
    });
    worker.on("exit", () => {
      // A clean exit before a message means the worker was terminated (timeout)
      // or died — the timer or the message handler has already resolved; this is
      // only a backstop so the promise can never dangle.
      finish({ error: "regex worker exited without a result" });
    });
  });
}
