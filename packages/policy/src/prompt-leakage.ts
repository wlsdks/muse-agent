import { escapeRegex } from "@muse/shared";
import { normalizeForInjectionDetection } from "./injection-patterns.js";

export interface PromptLeakageOptions {
  readonly canaryTokens?: readonly string[];
  readonly extraPatterns?: readonly PromptLeakagePattern[];
}

export interface PromptLeakageFinding {
  readonly name: string;
  readonly match: string;
}

export interface PromptLeakagePattern {
  readonly name: string;
  readonly pattern: RegExp;
}

export function detectSystemPromptLeakage(
  content: string,
  options: PromptLeakageOptions = {}
): readonly PromptLeakageFinding[] {
  const findings: PromptLeakageFinding[] = [];
  // Canonicalise first — the system prompt for a personal JARVIS
  // carries the user's persona/context/memory, so a leak echoed
  // with a zero-width / homoglyph / entity split must not slip
  // past. Every sibling policy guard normalises; this one didn't.
  const normalized = normalizeForInjectionDetection(content);

  for (const token of options.canaryTokens ?? []) {
    if (token.length > 0 && normalized.includes(token)) {
      findings.push({ match: token, name: "canary_token" });
    }
  }

  for (const { name, pattern } of [...defaultPromptLeakagePatterns, ...(options.extraPatterns ?? [])]) {
    const match = pattern.exec(normalized);

    if (match?.[0]) {
      findings.push({ match: match[0], name });
    }
  }

  return findings;
}

export const defaultPromptLeakagePatterns: readonly PromptLeakagePattern[] = [
  {
    name: "my_system_prompt",
    pattern: /my (full |complete |actual |real )?system prompt (is|says|reads|contains|was)/i
  },
  {
    name: "here_are_instructions",
    pattern: /here (is|are) my (full |complete |original |initial )?(system )?(prompt|instructions)/i
  },
  {
    name: "original_instructions",
    pattern: /my (original|initial) (system )?(prompt|instructions) (are|say|tell|read)/i
  },
  {
    name: "reveal_prompt_statement",
    pattern: /I('m| am) (not )?supposed to (reveal|share|show|tell|disclose).*(prompt|instructions)/i
  },
  {
    name: "the_system_prompt",
    pattern: /the (original |initial |full |complete )?system prompt (says|reads|contains|is|was)/i
  },
  {
    name: "korean_prompt_statement",
    pattern: /시스템\s*프롬프트는.*같습니다/u
  },
  {
    name: "korean_followed_instructions",
    pattern: /제가\s*따르는.*(프롬프트|지시|명령)/u
  },
  {
    name: "korean_original_instructions",
    pattern: /(제|저의|나의)\s*(원래|초기|원본).*(지시|명령|프롬프트|설정)/u
  },
  {
    name: "prompt_section_marker",
    pattern: createSectionMarkerPattern([
      "Language Rule",
      "Grounding Rules",
      "Few-shot Examples",
      "Tool Error Retry",
      "Conversation History",
      "Response Format",
      "Safety Rules",
      "Retrieved Context",
      "Tool Results"
    ])
  },
  {
    name: "multiple_section_markers",
    pattern: /\[[A-Z][a-z]+ [A-Z][a-z]+].*\[[A-Z][a-z]+ [A-Z][a-z]+]/s
  },
  {
    name: "multilingual_system_prompt",
    pattern: /(system|sistem|syst[eè]me|sistema)\s*(prompt|talimat|instruction)\S*\s*(is|are|:)/i
  },
  {
    name: "private_workspace_tool_rule",
    pattern: /private workspace questions.*must call tools/i
  },
  {
    name: "tool_forcing_rule",
    pattern: /you must call `[a-z_]+` before answering/i
  },
  {
    name: "korean_structural_rule",
    pattern: /(다음 규칙.*따라야|도구를 반드시.*호출|당신의 역할은.*에이전트)/u
  },
  {
    name: "cache_boundary_marker",
    pattern: /<!--\s*[A-Z_]*CACHE_BOUNDARY\s*-->/i
  }
];

function createSectionMarkerPattern(markers: readonly string[]): RegExp {
  return new RegExp(`\\[(${markers.map(escapeRegex).join("|")})\\]`, "i");
}

