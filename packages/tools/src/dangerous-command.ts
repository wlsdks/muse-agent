/**
 * Deterministic catastrophic-command guard for the `run_command` tool.
 *
 * `run_command` is already `risk: "execute"` (approval-gated), but an
 * approval gate can be bypassed by an auto-approve / autonomous mode — and
 * some commands are IRREVERSIBLE enough that they should never run on a
 * single-user machine on a model's say-so, gate or not. This classifies
 * that narrow, unambiguous set so the tool can FAIL-CLOSE (refuse in code,
 * per "guards are deterministic code, never prompt instruction").
 *
 * Scope stays TIGHT — only irreversible-with-no-legit-agent-use patterns.
 * Reversible or routine-but-risky work (a relative `rm -rf ./build`, a plain
 * `curl … | sh` install) is NOT refused here; it stays under the normal
 * execute-approval gate. False positives are worse than a near miss, so each
 * pattern targets a catastrophic TARGET (root, home, a raw device), not the
 * verb alone.
 *
 * A raw-regex gate is trivially bypassed by shell obfuscation, so detection
 * runs over NORMALIZED VARIANTS produced by `normalizeCommandForGuard`
 * (pure string transforms, no shell execution): comments stripped, `$IFS`
 * word-splitting collapsed, and a QUOTE-AWARE command-position marker
 * (`\x00` sentinel) so the destructive rules anchor to real command
 * positions — closing quoted-string false positives (`git commit -m
 * "rm -rf /"`) AND obfuscation bypasses (`$(echo rm) -rf /`, `rm${IFS}-rf`,
 * `echo <blob> | base64 -d | sh`, `eval "$(curl …)"`) in one place.
 */

export interface DangerousCommandVerdict {
  readonly dangerous: boolean;
  readonly reason?: string;
}

const SAFE: DangerousCommandVerdict = { dangerous: false };

// Over-cap input is refused unread: a multi-kilobyte command line to a
// single-user assistant is far more likely obfuscation than legitimate work,
// and an unbounded scan is a ReDoS surface. Fail-close.
const MAX_COMMAND_LENGTH = 8192;

// A shell word boundary that terminates a filesystem-path target: whitespace,
// a command separator, or the inserted command-start sentinel.
const TERM = "(?:[\\s;&|)`\\x00]|$)";

// Anchor for a command-POSITION rule: the `\x00` sentinel `markCommandStarts`
// inserts before each real (quote-aware) command word, optionally followed by
// a `sudo`/`env` wrapper (with their flags + one flag-argument each). Because
// the sentinel is only ever inserted OUTSIDE quotes, a dangerous-looking token
// inside a quoted argument is never anchored, so it never matches.
const CMD_START =
  "\\x00(?:sudo\\s+(?:-[^\\s]+\\s+(?:[^\\s-]\\S*\\s+)?){0,6})?" +
  "(?:env\\s+(?:[A-Za-z_][A-Za-z0-9_]*=[^\\s]*\\s+){0,6})?";

// Decode/transform pipeline whose output is piped INTO a shell at command
// position (the `\x00` before the shell name proves it is a real command, not
// quoted text). Bounded `[^\n]` fillers keep it ReDoS-safe.
const SHELL_PIPE = "\\|\\s*\\x00\\s*(?:\\S*\\/)?(?:bash|zsh|ksh|dash|sh)(?![a-z0-9])";

function atCmd(body: string, reason: string): readonly [RegExp, string] {
  return [new RegExp(CMD_START + body, "iu"), reason];
}

const RULES: readonly (readonly [RegExp, string])[] = [
  // --- Recursive force-delete of root / home (command-position anchored). ---
  atCmd(
    "rm\\s+(?:-[a-z]*\\s+)*-?[a-z]*\\b[rf][a-z]*\\s+(?:-[a-z]+\\s+)*(?:\\/|~|\\$\\{?HOME\\}?)(?:\\/\\*?)?" + TERM,
    "recursive delete of root or home directory"
  ),
  atCmd("rm\\s+(?:-[a-z]+\\s+)*\\/\\*", "recursive delete of a root glob"),
  // GNU long-flag abbreviation: `--recursive`/`--force` (and any unambiguous
  // prefix — `--recur`, `--forc`, `--r`, `--f`; these are the ONLY rm long
  // options starting with r / f) resolve via getopt-long. Target must follow
  // whitespace so `rm --recursive ./build` (relative) stays safe.
  atCmd(
    "rm\\s+[^\\n;|&]{0,200}?--[rf][a-z]*\\b[^\\n;|&]{0,200}?\\s(?:\\/|~|\\$\\{?HOME\\}?)(?:\\/\\*?)?" + TERM,
    "recursive delete of root or home directory (long flag)"
  ),
  // --- Raw block-device writes / filesystem destruction. ---
  atCmd("dd\\b[^\\n]{0,400}?\\bof=\\/dev\\/(?:sd|hd|nvme|disk|rdisk|vd)", "raw write to a block device"),
  atCmd("mkfs(?:\\.[a-z0-9]+)?\\s+[^\\n]{0,400}?\\/dev\\/", "filesystem format of a device"),
  atCmd("wipefs\\b[^\\n]{0,400}?\\/dev\\/", "wipe filesystem signatures from a device"),
  // --- Recursive permission / ownership change of root or home. ---
  atCmd(
    "chmod\\s+(?:-[a-z]+\\s+)*-?[a-zA-Z]*\\bR[a-zA-Z]*\\s+(?:[0-7]{3,4}|[ugoa]*[+=][rwxXst]+)\\s+(?:\\/\\*?|~\\/?|\\$\\{?HOME\\}?)" + TERM,
    "recursive permission change of root or home"
  ),
  // chmod's only long option beginning `rec` is `--recursive` (`--reference`
  // begins `ref`), so `--rec…` is the unambiguous recursive prefix.
  atCmd(
    "chmod\\s+[^\\n;|&]{0,200}?--rec[a-z]*\\b[^\\n;|&]{0,200}?(?:[0-7]{3,4}|[ugoa]*[+=][rwxXst]+)[^\\n;|&]{0,200}?\\s(?:\\/\\*?|~\\/?|\\$\\{?HOME\\}?)" + TERM,
    "recursive permission change of root or home (long flag)"
  ),
  atCmd(
    "chown\\s+(?:-[a-z]+\\s+)*-?[a-zA-Z]*\\bR[a-zA-Z]*\\s+\\S+\\s+(?:\\/\\*?|~\\/?|\\$\\{?HOME\\}?)" + TERM,
    "recursive ownership change of root or home"
  ),
  atCmd(
    "chown\\s+[^\\n;|&]{0,200}?--rec[a-z]*\\b[^\\n;|&]{0,200}?\\s(?:\\/\\*?|~\\/?|\\$\\{?HOME\\}?)" + TERM,
    "recursive ownership change of root or home (long flag)"
  ),
  // --- Decode-piped-to-shell obfuscation: never decode a blob into a shell.
  // The shell must sit at a real command position (the `\x00` in SHELL_PIPE),
  // so `echo aGk= | base64 -d > out.txt` (decode to a FILE) stays safe. ---
  [new RegExp("\\x00(?:base64|base32|base16)\\b[^\\n]{0,200}?(?:-d|--dec[a-z]*)\\b[^\\n]{0,200}?" + SHELL_PIPE, "iu"),
    "pipe decoded content to a shell (command obfuscation)"],
  [new RegExp("\\x00xxd\\b[^\\n]{0,200}?-r\\b[^\\n]{0,200}?" + SHELL_PIPE, "iu"),
    "pipe hex-decoded content to a shell (command obfuscation)"],
  [new RegExp("\\x00openssl\\b[^\\n]{0,200}?\\b(?:base64|enc)\\b[^\\n]{0,200}?-d\\b[^\\n]{0,200}?" + SHELL_PIPE, "iu"),
    "pipe openssl-decoded content to a shell (command obfuscation)"],
  [new RegExp("\\x00tr\\b[^\\n]{0,200}?" + SHELL_PIPE, "iu"),
    "pipe tr-transformed content to a shell (command obfuscation)"],
  // --- Remote-fetch-into-exec: run code fetched from the network. Keyed on
  // the fetch tool inside the exec construct, so `eval "$(ssh-agent -s)"` and
  // `bash <(echo hi)` (no network fetch) stay safe. ---
  [/\b(?:eval|source)\b[^\n]{0,60}?(?:\$\(|`)\s*(?:sudo\s+)?(?:curl|wget|fetch)\b/iu,
    "execute remotely fetched content (eval/source of curl/wget)"],
  [/\b(?:bash|sh|zsh|ksh|dash|source|eval)\b[^\n]{0,40}?<\s*\(\s*(?:sudo\s+)?(?:curl|wget|fetch)\b/iu,
    "execute remotely fetched content (process substitution of curl/wget)"],
  // --- Structural: fork bomb, redirect over a raw device. ---
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/u, "fork bomb"],
  [/>\s*\/dev\/(?:sd|hd|nvme|disk|rdisk|vd)[a-z0-9]*/iu, "redirect over a block device"]
];

// ---------------------------------------------------------------------------
// Normalization — pure string transforms that undo shell obfuscation without
// executing anything.
// ---------------------------------------------------------------------------

// Strip `# …` comments that sit OUTSIDE quotes (at the start of a token, i.e.
// preceded by whitespace or line start) up to end-of-line. A `#` glued to a
// previous char (`file#frag`) or inside quotes (`echo "#!/bin/sh"`) is part of
// the data and is left alone. Closes the comment-boundary false-positive class
// (`npm run build # rm -rf /`) while still flagging `rm -rf / # cleanup`.
function stripCommentsOutsideQuotes(command: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/u.test(command[i - 1]!))) {
      while (i < command.length && command[i] !== "\n") i++;
      if (i < command.length) out += "\n";
      continue;
    }
    out += ch;
  }
  return out;
}

// `$IFS` / `${IFS}` default to <space><tab><newline>, so `rm${IFS}-rf${IFS}/`
// executes as `rm -rf /`. Collapse to a literal space so the anchored patterns
// see the real word boundaries.
function collapseIfs(command: string): string {
  return command.replace(/\$\{IFS\b[^}]*\}|\$IFS\b/gu, " ");
}

// The shell removes a backslash-newline pair and joins the tokens, so
// `rm -rf \<newline>/` runs as `rm -rf /`.
function stripLineContinuations(command: string): string {
  return command.replace(/\\\r?\n/gu, "");
}

// ECMA-48/ANSI escape sequences (CSI: `ESC [` … parameter/intermediate bytes …
// final byte `@`-`~`, plus the 8-bit CSI introducer `\x9b`, plus the two-char
// Fe forms like `ESC c`) can be inserted mid-token by a terminal-rendering
// trick — `r\x1b[0mm -rf /` renders as "rm -rf /" but splits the literal verb
// so the anchored `rm` rule never matches. Stripping them first closes that
// gap. Character classes only (no nested quantifiers), so this stays
// ReDoS-safe on adversarial input.
const ANSI_ESCAPE_PATTERN = /[\x1b\x9b]\[[0-9:;<=>?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/gu;

export function stripAnsiEscapes(command: string): string {
  return command.replace(ANSI_ESCAPE_PATTERN, "");
}

// NFKC folds Unicode compatibility variants to their canonical ASCII form —
// a fullwidth homograph like `ｒｍ` (U+FF52 U+FF4D) becomes `rm`, closing a
// homograph bypass of the ASCII-anchored rules. This is DETECTION-only: the
// guard classifies the ORIGINAL command string the caller will run, so
// folding a copy for pattern-matching purposes cannot change what executes.
// It is a no-op on already-ASCII input, so existing behavior is unchanged.
export function normalizeCommandNfkc(command: string): string {
  return command.normalize("NFKC");
}

// Resolve a command built by substitution — `$(echo rm) -rf /`,
// `` `echo rm` -rf / `` — to its bare-word payload so the command-position
// scanner sees the real verb. Only a literal `echo`/`printf <simple word>` is
// resolved (no shell execution); anything richer is left untouched.
function resolveEchoSubstitutions(command: string): string {
  const word = "([A-Za-z0-9_./:@%+=,-]+)";
  return command
    .replace(new RegExp("\\$\\(\\s*(?:echo|printf)\\s+([\"']?)" + word + "\\1\\s*\\)", "gu"), "$2")
    .replace(new RegExp("`\\s*(?:echo|printf)\\s+([\"']?)" + word + "\\1\\s*`", "gu"), "$2");
}

// Offsets (whitespace-skipped) where the shell begins parsing a NEW command:
// string start, after an unquoted `; & && | || newline`, and after a subshell
// opener `( $( backtick`. Quote-aware — separators inside '…' / "…" are data,
// never command starts. This is what lets the anchored patterns tell real
// command position from quoted prose without a full shell parser.
function commandStartOffsets(command: string): number[] {
  const starts: number[] = [0];
  let quote: string | null = null;
  let i = 0;
  const n = command.length;
  while (i < n) {
    const ch = command[i]!;
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
      // A `$(…)` command substitution is active even inside double quotes.
      if (command.startsWith("$(", i)) {
        starts.push(i + 2);
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < n) {
      i += 2;
      continue;
    }
    if (command.startsWith("$(", i)) {
      starts.push(i + 2);
      i += 2;
      continue;
    }
    if (ch === "(" || ch === "`") {
      starts.push(i + 1);
      i++;
      continue;
    }
    // A brace group `{ cmd; }` opens a command context, but `${VAR}` does not:
    // the group form requires whitespace after `{`, the expansion never has it.
    if (ch === "{" && i + 1 < n && /\s/u.test(command[i + 1]!)) {
      starts.push(i + 1);
      i++;
      continue;
    }
    if (ch === ";") {
      starts.push(i + 1);
      i++;
      continue;
    }
    if (ch === "&" || ch === "|") {
      starts.push(command[i + 1] === ch ? i + 2 : i + 1);
      i += command[i + 1] === ch ? 2 : 1;
      continue;
    }
    if (ch === "\n") {
      starts.push(i + 1);
      i++;
      continue;
    }
    i++;
  }
  const seen = new Set<number>();
  for (let start of starts) {
    while (start < n && /\s/u.test(command[start]!)) start++;
    if (start < n) seen.add(start);
  }
  return [...seen].sort((a, b) => a - b);
}

// Insert a `\x00` sentinel before each real command start so the CMD_START
// anchor can bind there. Built by array-join (not repeated slice) so an input
// full of separators stays linear-time.
function markCommandStarts(command: string): string {
  const offsets = commandStartOffsets(command);
  if (offsets.length === 0) return command;
  const parts: string[] = [];
  let prev = 0;
  for (const offset of offsets) {
    parts.push(command.slice(prev, offset), "\x00");
    prev = offset;
  }
  parts.push(command.slice(prev));
  return parts.join("");
}

/**
 * Produce the normalized command variants the guard scans. Pure and
 * deterministic. For each of the cleaned command and its
 * substitution-resolved form, both the plain string (for structural rules
 * like the fork bomb) and a command-position-MARKED string (for the anchored
 * destructive rules) are returned. The caller runs every rule over every
 * variant; any hit is dangerous.
 */
export function normalizeCommandForGuard(command: string): readonly string[] {
  const deobfuscated = stripAnsiEscapes(normalizeCommandNfkc(command)).replace(/\x00/gu, "");
  const cleaned = collapseIfs(stripCommentsOutsideQuotes(stripLineContinuations(deobfuscated)));
  const variants = new Set<string>([cleaned, markCommandStarts(cleaned)]);
  const resolved = resolveEchoSubstitutions(cleaned);
  if (resolved !== cleaned) {
    variants.add(resolved);
    variants.add(markCommandStarts(resolved));
  }
  return [...variants];
}

/**
 * Classify a shell command. Returns `{ dangerous: true, reason }` only for
 * an irreversible catastrophic pattern; `{ dangerous: false }` otherwise.
 * Pure + deterministic. Over-cap input fails closed.
 */
export function classifyDangerousCommand(command: string): DangerousCommandVerdict {
  if (typeof command !== "string" || command.length === 0) {
    return SAFE;
  }
  if (command.length > MAX_COMMAND_LENGTH) {
    return { dangerous: true, reason: "command exceeds the safe length cap (possible obfuscation)" };
  }
  for (const variant of normalizeCommandForGuard(command)) {
    for (const [pattern, reason] of RULES) {
      if (pattern.test(variant)) {
        return { dangerous: true, reason };
      }
    }
  }
  return SAFE;
}
