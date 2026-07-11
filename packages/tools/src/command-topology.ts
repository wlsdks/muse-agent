/**
 * Shell-topology classifier for the `run_command` path.
 *
 * The runner spawns `Command::new(command)` with `args` as LITERAL argv —
 * there is no shell in between. So a construct like `$(...)`, a backtick, a
 * heredoc, or `eval` is only ever expanded when `command` ITSELF is a shell
 * interpreter (`sh`/`bash`/`zsh`/`dash`/`ksh`/`ash`) parsing a script (its
 * `-c` argument). For any other program (`echo`, `node`, `git`, `grep`) the
 * same text is a literal argv string, never interpreted — safe.
 *
 * `classifyDangerousCommand` (DS-2) is a string-level pattern guard; it
 * cannot see the real command hiding behind a shell's `-c` argument (that is
 * exactly the gap this classifier closes). This module only CLASSIFIES —
 * it does not refuse anything. A caller uses `analyzable: false` to decide
 * a command needs explicit approval rather than an auto-approve path.
 */

export interface CommandTopologyVerdict {
  readonly analyzable: boolean;
  readonly reason?: string;
  readonly construct?: "command-substitution" | "process-substitution" | "heredoc" | "eval";
}

const ANALYZABLE: CommandTopologyVerdict = { analyzable: true };

// Mirrors DS-2's cap (`dangerous-command.ts`'s `MAX_COMMAND_LENGTH`) — a
// multi-kilobyte command is far more likely obfuscation than legitimate
// work, and an unbounded scan is a ReDoS surface. Fail-close.
const MAX_COMMAND_LENGTH = 8192;

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash"]);

function stripPathAndCase(token: string): string {
  const slash = token.lastIndexOf("/");
  return (slash === -1 ? token : token.slice(slash + 1)).toLowerCase();
}

// Quote-aware whitespace tokenizer for a WHOLE packed command line (used
// only when the caller gave no separate `args`). Single/double quote
// delimiters are consumed (not part of the resulting token); their content
// is kept literally, which is exactly what a real shell's tokenizer does
// when it hands `sh` a `-c` argument — the outer quotes are the ARGUMENT
// boundary, not part of the script `sh` itself goes on to parse.
function tokenizeShellLine(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let hasToken = false;
  let quote: "'" | '"' | null = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (/\s/u.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

// When `args` is given, each element is already a discrete argv token — it
// is used verbatim (no further quote-stripping). Only the packed-whole-line
// form (`args` absent) needs `tokenizeShellLine` to recover the program and
// its `-c` script argument from one string.
function resolveTokens(command: string, args?: readonly string[]): string[] {
  const trimmed = command.trim();
  if (args && args.length > 0) {
    return [trimmed, ...args];
  }
  return tokenizeShellLine(trimmed);
}

// The `-c` argument is the only place a shell's interpreter takes an inline
// script from argv (as opposed to a script FILE, whose content we can't
// see anyway — `bash deploy.sh` has nothing further to scan here).
function extractShellScript(tokens: readonly string[]): string | undefined {
  const idx = tokens.indexOf("-c", 1);
  if (idx === -1 || idx + 1 >= tokens.length) return undefined;
  return tokens[idx + 1];
}

function isEvalWordAt(script: string, i: number): boolean {
  if (script[i] !== "e" || script[i + 1] !== "v" || script[i + 2] !== "a" || script[i + 3] !== "l") return false;
  const next = script[i + 4];
  return next === undefined || /[\s;|&()]/u.test(next);
}

interface ConstructHits {
  commandSubstitution: boolean;
  processSubstitution: boolean;
  heredoc: boolean;
  evalWord: boolean;
}

// Single left-to-right scan (no backtracking regex) tracking quote state so
// the ReDoS surface stays linear. A single-quoted region suppresses ALL
// expansion in POSIX shells, so a hit inside one is ignored; a double-quoted
// region still allows `$(...)`/backtick substitution, so those still count.
// `atCommandStart` tracks whether the NEXT non-whitespace character sits at
// a real command position (script start, or right after `; | & ( \n` —
// `&&`/`||` are covered because each `&`/`|` char individually re-arms it).
function scanForConstructs(script: string): ConstructHits {
  const hits: ConstructHits = { commandSubstitution: false, processSubstitution: false, heredoc: false, evalWord: false };
  let quote: "'" | '"' | null = null;
  let atCommandStart = true;
  const n = script.length;
  let i = 0;
  while (i < n) {
    const ch = script[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      i++;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\" && i + 1 < n) {
        i += 2;
        continue;
      }
      if (ch === '"') {
        quote = null;
        i++;
        continue;
      }
      if (ch === "$" && script[i + 1] === "(" && script[i + 2] !== "(") hits.commandSubstitution = true;
      else if (ch === "`") hits.commandSubstitution = true;
      i++;
      continue;
    }
    // quote === null
    if (ch === "'" || ch === '"') {
      quote = ch;
      atCommandStart = false;
      i++;
      continue;
    }
    if (/\s/u.test(ch)) {
      // A newline is a command separator like `;` — it re-arms `eval`
      // detection at the next line's start. Other whitespace just holds
      // whatever `atCommandStart` state it already had.
      if (ch === "\n") atCommandStart = true;
      i++;
      continue;
    }
    // `$((` is ARITHMETIC expansion, not command substitution — it runs no
    // command. Only the bare `$(` opener counts; the scan still continues
    // into the arithmetic body, so a command substitution NESTED inside it
    // (`$(( $(id) ))`) is still caught when the scan reaches that inner `$(`.
    if (ch === "$" && script[i + 1] === "(" && script[i + 2] !== "(") hits.commandSubstitution = true;
    else if (ch === "`") hits.commandSubstitution = true;
    else if ((ch === "<" || ch === ">") && script[i + 1] === "(") hits.processSubstitution = true;
    else if (ch === "<" && script[i + 1] === "<") hits.heredoc = true;
    else if (atCommandStart && isEvalWordAt(script, i)) hits.evalWord = true;
    atCommandStart = ch === ";" || ch === "|" || ch === "&" || ch === "(";
    i++;
  }
  return hits;
}

/**
 * Classify whether a shell would expand a construct DS-2 (`classifyDangerousCommand`)
 * cannot inspect — command substitution, process substitution, heredoc, or
 * `eval` — before the resulting real command ever reaches the string-level
 * guard. Pure, synchronous, no I/O.
 */
export function classifyCommandTopology(command: string, args?: readonly string[]): CommandTopologyVerdict {
  if (typeof command !== "string" || command.trim().length === 0) {
    return ANALYZABLE;
  }

  const joinedLength = command.length + (args ?? []).reduce((sum, arg) => sum + arg.length + 1, 0);
  if (joinedLength > MAX_COMMAND_LENGTH) {
    return { analyzable: false, reason: "command exceeds the safe length cap (possible obfuscation)" };
  }

  const tokens = resolveTokens(command, args);
  if (tokens.length === 0) return ANALYZABLE;

  const program = stripPathAndCase(tokens[0]!);
  if (!SHELLS.has(program)) {
    return ANALYZABLE;
  }

  const script = extractShellScript(tokens);
  if (script === undefined) {
    return ANALYZABLE;
  }

  const hits = scanForConstructs(script);
  if (hits.commandSubstitution) {
    return {
      analyzable: false,
      construct: "command-substitution",
      reason: "a shell substitutes another command's output here — the real command is invisible to static inspection"
    };
  }
  if (hits.processSubstitution) {
    return {
      analyzable: false,
      construct: "process-substitution",
      reason: "a shell wires a subprocess in as a file here — the real command is invisible to static inspection"
    };
  }
  if (hits.heredoc) {
    return {
      analyzable: false,
      construct: "heredoc",
      reason: "a shell reads an inline heredoc script here — the real command is invisible to static inspection"
    };
  }
  if (hits.evalWord) {
    return {
      analyzable: false,
      construct: "eval",
      reason: "a shell re-parses and executes a computed string here — the real command is invisible to static inspection"
    };
  }
  return ANALYZABLE;
}
