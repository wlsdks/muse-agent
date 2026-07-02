/**
 * `muse.math` arithmetic evaluator — recursive-descent parser for
 * digits / parens / + - * / %. Avoids `eval` / `Function` for
 * safety. Lifted out of `loopback.ts` together with the
 * `SAFE_MATH_PATTERN` whitelist and `evaluateArithmetic` helper.
 */

const SAFE_MATH_PATTERN = /^[\s\d+\-*/().,%]+$/u;

/**
 * Validate + evaluate an arithmetic expression deterministically (no `eval`),
 * returning either `{ result }` or `{ error }`. The shared core behind both the
 * `muse.math` tool AND `muse ask`'s pure-arithmetic fast-path — the local 8B
 * can't multiply reliably, so any surface that needs an EXACT calculation routes
 * through here instead of trusting the model's digits.
 */
export function evaluateArithmeticExpression(expression: string): { result: number } | { error: string } {
  const expr = expression.trim();
  if (expr.length === 0) {
    return { error: "expression is required" };
  }
  if (expr.length > 256) {
    return { error: "expression exceeds 256 character limit" };
  }
  if (!SAFE_MATH_PATTERN.test(expr)) {
    return { error: "expression may only contain digits, parentheses, '.', ',' and + - * / %" };
  }
  try {
    const result = evaluateArithmetic(expr);
    if (!Number.isFinite(result)) {
      return { error: "expression evaluated to a non-finite number" };
    }
    return { result };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "expression evaluation failed" };
  }
}

function evaluateArithmetic(expression: string): number {
  let cursor = 0;
  const stripped = expression.replace(/,/gu, "");

  function parseExpression(): number {
    let value = parseTerm();
    while (cursor < stripped.length) {
      skip();
      const ch = stripped[cursor];
      if (ch === "+" || ch === "-") {
        cursor += 1;
        const right = parseTerm();
        value = ch === "+" ? value + right : value - right;
      } else {
        break;
      }
    }
    return value;
  }

  function parseTerm(): number {
    let value = parseFactor();
    while (cursor < stripped.length) {
      skip();
      const ch = stripped[cursor];
      if (ch === "*" || ch === "/" || ch === "%") {
        cursor += 1;
        const right = parseFactor();
        if (ch === "*") {
          value *= right;
        } else if (ch === "/") {
          if (right === 0) {
            throw new Error("division by zero");
          }
          value /= right;
        } else {
          if (right === 0) {
            throw new Error("modulo by zero");
          }
          value %= right;
        }
      } else {
        break;
      }
    }
    return value;
  }

  function parseFactor(): number {
    skip();
    const ch = stripped[cursor];
    if (ch === "+" || ch === "-") {
      cursor += 1;
      const inner = parseFactor();
      return ch === "+" ? inner : -inner;
    }
    if (ch === "(") {
      cursor += 1;
      const value = parseExpression();
      skip();
      if (stripped[cursor] !== ")") {
        throw new Error("unbalanced parentheses");
      }
      cursor += 1;
      return value;
    }
    return parseNumber();
  }

  function parseNumber(): number {
    skip();
    const start = cursor;
    while (cursor < stripped.length) {
      const ch = stripped[cursor] ?? "";
      if ((ch >= "0" && ch <= "9") || ch === ".") {
        cursor += 1;
      } else {
        break;
      }
    }
    if (cursor === start) {
      throw new Error("expected number");
    }
    const literal = stripped.slice(start, cursor);
    // Strict Number(), NOT parseFloat: the scanner greedily consumes dots, so a
    // malformed "1.2.3" reaches here — parseFloat would silently return 1.2 (stops at
    // the 2nd dot) and the NaN guard never fires, so "1.2.3 * 100" computes 120. The
    // math tool's whole contract is an EXACT digit, so a malformed literal must throw.
    const value = Number(literal);
    if (Number.isNaN(value)) {
      throw new Error(`invalid number literal: ${literal}`);
    }
    return value;
  }

  function skip(): void {
    // Skip ANY whitespace SAFE_MATH_PATTERN admits (\s), not just a literal space —
    // otherwise a contract-valid "2 *\t3" or a pasted multi-line sum passes the
    // whitelist then stalls the cursor on the tab/newline and throws.
    while (cursor < stripped.length && /\s/u.test(stripped[cursor] ?? "")) {
      cursor += 1;
    }
  }

  const value = parseExpression();
  skip();
  if (cursor !== stripped.length) {
    throw new Error("trailing characters after expression");
  }
  return value;
}
