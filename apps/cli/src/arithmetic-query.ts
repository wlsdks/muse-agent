/**
 * `muse ask`'s pure-arithmetic fast-path detector. The local 8B can't multiply
 * reliably (it confidently returns the wrong digits), so when a query is nothing
 * BUT a calculation, Muse should compute it deterministically rather than letting
 * the model guess. These helpers decide whether a query qualifies and format the
 * exact answer; the evaluation itself routes through `@muse/mcp`'s
 * `evaluateArithmeticExpression`.
 */

const QUESTION_FRAMING =
  /^(?:what(?:\s+is|'s|\s+are)?|whats|calculate|compute|evaluate|how\s+much\s+is|equals?)\s+/u;

/**
 * Return the bare arithmetic expression if `query` is PURELY a calculation
 * ("what is 1847 * 2963?", "2+2", "calculate (1200 + 850) / 2") — else null.
 * Precision-first: the remainder after stripping the "what is …?" framing must
 * contain only digits / parentheses / `.` / `,` / `+ - * / %` AND a real binary
 * operator, so a notes question ("what is my Q3 budget?", "what is 42?") never
 * short-circuits the retrieval path.
 */
export function detectArithmeticQuery(query: string): string | null {
  let q = query.trim().toLowerCase();
  q = q.replace(/[?\s]+$/u, "");
  q = q.replace(QUESTION_FRAMING, "");
  q = q.replace(/\s*=\s*$/u, "").trim();
  if (q.length === 0 || q.length > 256) {
    return null;
  }
  if (!/^[\d\s+\-*/().,%]+$/u.test(q)) {
    return null;
  }
  // A bare number ("42") or a lone negative ("-5") is not a calculation — require
  // a binary operator that actually follows an operand.
  if (!/[\d)]\s*[-+*/%]/u.test(q)) {
    return null;
  }
  return q;
}

/** "1847 * 2963 = 5,472,661" — the exact computed answer, the result grouped for readability. */
export function formatArithmeticResult(expression: string, result: number): string {
  const shown = Number.isInteger(result)
    ? result.toLocaleString("en-US")
    : result.toLocaleString("en-US", { maximumFractionDigits: 10 });
  return `${expression} = ${shown}`;
}
