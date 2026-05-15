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
  // Goal 120 — IPv6 alongside IPv4. Recognises the canonical
  // 8-group `xxxx:xxxx:…` (any of the 8 groups can be 1-4 hex
  // digits) AND the `::`-compressed form (any number of leading /
  // middle / trailing groups elided to a single `::`). The
  // `(?:…)` non-capturing groups keep replace() output stable.
  // Word boundaries (`\b`) guard against matching the inside of
  // longer hex blobs.
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

export const allPiiPatterns: readonly PiiPattern[] = [
  ...krPiiPatterns,
  ...internationalPiiPatterns,
  ...commonPiiPatterns
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

function toGlobal(regex: RegExp): RegExp {
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  return new RegExp(regex.source, flags);
}
