export type RedactionKind = "email" | "url" | "token" | "path" | "connection" | "private-term";

export interface RedactionFinding {
  readonly kind: RedactionKind;
  readonly count: number;
}

export interface MigrationRedactionOptions {
  readonly privateTerms?: readonly string[];
}

export interface MigrationRedactionResult {
  readonly text: string;
  readonly findings: readonly RedactionFinding[];
}

interface RedactionPattern {
  readonly kind: RedactionKind;
  readonly pattern: RegExp;
  readonly replacement: string;
}

const defaultPatterns: readonly RedactionPattern[] = [
  {
    // `<scheme>://user:pass@host` — the canonical migration-log
    // secret (postgres/mysql/redis/mongodb/amqp connection URIs
    // with an inline password). The http-only `url` rule below
    // would leave any non-http scheme fully in cleartext. Runs
    // FIRST so credentials are stripped before the generic rule.
    kind: "connection",
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@:]*:[^\s/?#@]+@[^\s)"'<>]+/gi,
    replacement: "[redacted-connection]"
  },
  {
    kind: "email",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    replacement: "[redacted-email]"
  },
  {
    kind: "url",
    pattern: /\bhttps?:\/\/[^\s)"'<>]+/gi,
    replacement: "[redacted-url]"
  },
  {
    kind: "token",
    pattern: /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g,
    replacement: "[redacted-token]"
  },
  {
    kind: "path",
    pattern: /\/(?:Users|home|root)\/[^\s)"'<>]+/g,
    replacement: "[redacted-path]"
  }
];

export function redactMigrationText(
  text: string,
  options: MigrationRedactionOptions = {}
): MigrationRedactionResult {
  const findings = new Map<RedactionKind, number>();
  let redacted = text;

  for (const rule of defaultPatterns) {
    redacted = applyPattern(redacted, rule.pattern, rule.replacement, (count) => {
      addFinding(findings, rule.kind, count);
    });
  }

  for (const term of options.privateTerms ?? []) {
    const normalized = term.trim();

    if (normalized.length === 0) {
      continue;
    }

    redacted = applyPattern(redacted, createTermPattern(normalized), "[redacted-identifier]", (count) => {
      addFinding(findings, "private-term", count);
    });
  }

  return {
    findings: [...findings.entries()].map(([kind, count]) => ({ count, kind })),
    text: redacted
  };
}

function applyPattern(
  text: string,
  pattern: RegExp,
  replacement: string,
  onMatch: (count: number) => void
): string {
  let count = 0;
  const next = text.replace(pattern, () => {
    count += 1;
    return replacement;
  });

  if (count > 0) {
    onMatch(count);
  }

  return next;
}

function addFinding(findings: Map<RedactionKind, number>, kind: RedactionKind, count: number): void {
  findings.set(kind, (findings.get(kind) ?? 0) + count);
}

function createTermPattern(term: string): RegExp {
  return new RegExp(escapeRegExp(term), "gi");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
