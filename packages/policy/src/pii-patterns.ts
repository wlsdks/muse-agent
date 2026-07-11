import { normalizeForInjectionDetection } from "./injection-patterns.js";
import { toGlobal } from "./regex-utils.js";

export interface PiiPattern {
  readonly name: string;
  readonly regex: RegExp;
  readonly mask: string;
}

export interface PiiFinding {
  readonly name: string;
  readonly count: number;
}

export interface PiiMaskResult {
  readonly text: string;
  readonly findings: readonly PiiFinding[];
}

export const krPiiPatterns: readonly PiiPattern[] = [
  {
    mask: "******-*******",
    name: "kr-national-id",
    regex: /\d{6}\s?-\s?[1-4]\d{6}/
  },
  {
    mask: "***-****-****",
    name: "kr-phone",
    regex: /01[016789]-?\d{3,4}-?\d{4}/
  },
  {
    mask: "**-**-******-**",
    name: "kr-driver-license",
    regex: /\d{2}-\d{2}-\d{6}-\d{2}/
  },
  {
    mask: "*********",
    name: "kr-passport",
    regex: /\b[A-Z]\d{8}\b/
  }
];

export const internationalPiiPatterns: readonly PiiPattern[] = [
  {
    mask: "[IBAN MASKED]",
    name: "iban",
    regex: /\b[A-Z]{2}\d{2}\s?[\dA-Z]{4}(?:\s?[\dA-Z]{4}){1,7}(?:\s?[\dA-Z]{1,4})?/
  },
  {
    mask: "***-**-****",
    name: "us-ssn",
    regex: /\b\d{3}-\d{2}-\d{4}\b/
  },
  {
    mask: "**** **** ****",
    name: "jp-my-number",
    regex: /\b\d{4}\s\d{4}\s\d{4}\b/
  }
];

export const commonPiiPatterns: readonly PiiPattern[] = [
  {
    mask: "****-****-****-****",
    name: "credit-card",
    regex: /\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}/
  },
  {
    mask: "***@***.***",
    name: "email",
    regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/
  },
  {
    mask: "***.***.***.***",
    name: "ipv4",
    regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/
  },
  // Matches the canonical 8-group form AND the ::-compressed
  // form. The \b boundaries stop it matching inside longer hex
  // blobs; the (?:…) groups keep replace() output stable.
  {
    mask: "[IPV6 MASKED]",
    name: "ipv6",
    regex:
      /\b(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}\b|\b(?:[0-9A-Fa-f]{1,4}:){1,7}:(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4}){0,6})?\b|::(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{1,4}\b/
  },
  {
    mask: "***:****-****-****-****-************",
    name: "external-account-id",
    regex: /\d{6,}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
  }
];

// Common patterns precede the international group on purpose: a
// space-grouped 16-digit `credit-card` strictly contains a valid
// 12-digit `jp-my-number` match, and `maskPii`/`findPii` apply
// patterns in order. Scanning the broader card first claims the
// whole span so the last 4 digits can't leak and the finding is
// classified as `credit-card`, not `jp-my-number`.
export const allPiiPatterns: readonly PiiPattern[] = [
  ...krPiiPatterns,
  ...commonPiiPatterns,
  ...internationalPiiPatterns
];

export function maskPii(text: string, patterns: readonly PiiPattern[] = allPiiPatterns): PiiMaskResult {
  const findings = new Map<string, number>();
  let masked = text;

  for (const pattern of patterns) {
    masked = masked.replace(toGlobal(pattern.regex), () => {
      findings.set(pattern.name, (findings.get(pattern.name) ?? 0) + 1);
      return pattern.mask;
    });
  }

  return {
    findings: [...findings.entries()].map(([name, count]) => ({ count, name })),
    text: masked
  };
}

/**
 * Detection-only PII scan over the *normalised* text (NFKC, strip
 * zero-width, decode entities, fold homoglyphs/diacritics — the
 * same canonicaliser the injection detector uses). `maskPii`
 * deliberately runs on the raw text because it rewrites content
 * and must not corrupt legitimate output; the fail-close PII
 * *input* guard only needs to know whether PII is present, so it
 * uses this so a zero-width / homoglyph / entity-split SSN or card
 * can't slip past the regexes.
 */
export function findPii(text: string, patterns: readonly PiiPattern[] = allPiiPatterns): readonly PiiFinding[] {
  const normalized = normalizeForInjectionDetection(text);
  const findings = new Map<string, number>();

  for (const pattern of patterns) {
    const matches = normalized.match(toGlobal(pattern.regex));

    if (matches && matches.length > 0) {
      findings.set(pattern.name, (findings.get(pattern.name) ?? 0) + matches.length);
    }
  }

  return [...findings.entries()].map(([name, count]) => ({ count, name }));
}
