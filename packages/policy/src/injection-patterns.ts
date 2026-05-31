export interface InjectionPattern {
  readonly name: string;
  readonly regex: RegExp;
}

export interface InjectionFinding {
  readonly name: string;
  readonly count: number;
}

export const zeroWidthCodePoints = new Set<number>([
  0x0000,
  0x200b,
  0x200c,
  0x200d,
  0x200e,
  0x200f,
  0xfeff,
  0x00ad,
  0x2060,
  0x2061,
  0x2062,
  0x2063,
  0x2064,
  0x180e,
  0x2028,
  0x2029,
  0x202a,
  0x202b,
  0x202c,
  0x202d,
  0x202e,
  0x2066,
  0x2067,
  0x2068,
  0x2069
]);

const homoglyphMap = new Map<string, string>([
  ["\u0430", "a"],
  ["\u0435", "e"],
  ["\u043e", "o"],
  ["\u0440", "p"],
  ["\u0441", "c"],
  ["\u0443", "y"],
  ["\u0445", "x"],
  ["\u0410", "A"],
  ["\u0412", "B"],
  ["\u0415", "E"],
  ["\u041a", "K"],
  ["\u041c", "M"],
  ["\u041d", "H"],
  ["\u041e", "O"],
  ["\u0420", "P"],
  ["\u0421", "C"],
  ["\u0422", "T"],
  ["\u0425", "X"],
  ["\u0391", "A"],
  ["\u0392", "B"],
  ["\u0395", "E"],
  ["\u0397", "H"],
  ["\u0399", "I"],
  ["\u039a", "K"],
  ["\u039c", "M"],
  ["\u039d", "N"],
  ["\u039f", "O"],
  ["\u03a1", "P"],
  ["\u03a4", "T"],
  ["\u03a5", "Y"],
  ["\u03a7", "X"],
  ["\u03b1", "a"],
  ["\u03b5", "e"],
  ["\u03b9", "i"],
  ["\u03bf", "o"],
  ["\u03c1", "p"],
  ["\u03c5", "u"],
  ["\u0456", "i"],
  ["\u0406", "I"]
]);

export const sharedInjectionPatterns: readonly InjectionPattern[] = [
  { name: "role_override", regex: /(ignore|forget|disregard).*(previous|above|prior|all).*(instructions?|and)/is },
  { name: "role_override", regex: /you\s+are\s+now/i },
  { name: "role_override", regex: /\bact as (a |an )?(unrestricted|unfiltered|different|new|evil|hacker|jailbroken)/i },
  { name: "role_override", regex: /disregard.*(your|the|my).*(programming|rules|guidelines|constraints)/is },
  { name: "role_override", regex: /^\s*SYSTEM\s*:/im },
  { name: "role_override", regex: /pretend.*(you|that).*(no|have no|without).*(restrictions?|limits?|filters?|rules?)/is },
  { name: "role_override", regex: /override.*(your|the|my|all).*(instructions?|rules?|programming|guidelines)/is },
  { name: "role_override", regex: /\b(unrestricted|unfiltered|uncensored|jailbr[eo]ak)\b.*(ai|model|assistant|mode)/is },
  { name: "role_override", regex: /(switch|enter|enable|activate).*(jailbreak|developer|debug|admin|god)\s*mode/is },
  { name: "role_override", regex: /(do anything now|act as DAN|you are DAN|DAN mode|be DAN|DAN jailbreak|pretend.*DAN)/is },
  { name: "system_delimiter", regex: /\[SYSTEM\]|<\|im_start\|>|<\|im_end\|>|<\|assistant\|>/ },
  { name: "prompt_override", regex: /from\s+now\s+on/i },
  { name: "punctuation_obfuscation", regex: /s[.\-_\s]y[.\-_\s]s[.\-_\s]t[.\-_\s]e[.\-_\s]m[.\-_\s]*p[.\-_\s]r[.\-_\s]o[.\-_\s]m[.\-_\s]p[.\-_\s]t/i },
  { name: "korean_role_override", regex: /(앞의|이전|위의|위에서).{0,10}(대화|지시|명령).{0,10}(무시|잊어|취소)/s },
  { name: "korean_role_override", regex: /(이전|위의|위에서|모든|기존).*(지시|명령|규칙|프롬프트).*(무시|잊어|버려|취소)/s },
  { name: "korean_role_override", regex: /(무시|잊어|버려|취소).*(이전|위의|위에서|모든|기존).*(지시|명령|규칙|프롬프트)/s },
  { name: "korean_prompt_extraction", regex: /(보여|알려|공개|출력|말해).*(시스템|원래|초기|너의|네).*(프롬프트|지시|명령|설정|인스트럭션)/s },
  { name: "korean_prompt_extraction", regex: /시스템\s*프롬프트(를|을|\s+(보여|알려|공개|출력|말해))/ },
  { name: "skeleton_key", regex: /(연구|테스트|실험|검증|안전)\s*(모드|필터|제한|보호).{0,10}(전환|비활성|해제|끄|꺼|off|disable|override)/is },
  { name: "skeleton_key", regex: /(research|test|debug|maintenance|god)\s*(mode|filter).{0,10}(activat|enabl|on|override|switch)/is },
  { name: "prefix_injection", regex: /(다음|아래).{0,5}(문장|텍스트|응답).{0,10}(완성|이어|계속).{0,10}(시스템|프롬프트|지시|설정|instructions?)/s },
  { name: "multilingual_injection", regex: /忽略.{0,10}(指令|指示|规则)/ },
  { name: "multilingual_injection", regex: /显示.{0,10}(系统|提示|指令)/ },
  { name: "multilingual_injection", regex: /(無視|忽視).{0,10}(指示|命令|ルール)/ },
  { name: "multilingual_injection", regex: /(指示|命令|ルール).{0,5}(無視|忽視)/ },
  { name: "multilingual_injection", regex: /(ignora|olvida).{0,20}(instrucciones|anteriores|reglas)/i },
  { name: "multilingual_prompt_leak", regex: /\b(show|display|print|reveal|give|tell)\b.{0,20}\b(system|internal|original)\b.{0,20}\b(prompt|instruction|rule|directive)s?\b/i },
  { name: "multilingual_prompt_leak", regex: /\b(goster|gosterin|mostre|mostrar|montrer|montrez|zeigen|mostra|tampilkan|pokaz|dikhao|batao)\b.{0,30}\b(instruc|instruction|prompt|system|sistem|talimat|komut|sistema|anweisung|nirdesh)/i },
  { name: "section_marker_reference", regex: /(Language Rule|Grounding Rules?|Tool Error Retry|Few-shot Example)/i },
  { name: "meta_question", regex: /(할 수 있는|할 수 없는|가능한|불가능한).{0,20}(알려|설명|구분|나열)/ },
  { name: "meta_question", regex: /(너의|당신의|네).{0,10}(역할|목적|제약|제한|능력|한계)/ },
  { name: "indirect_prompt_extraction", regex: /(이전|과거|처음|첫).{0,15}(받은|전달받은|주어진|있는).{0,15}(instructions?|지시|지침|내용|메시지).{0,15}(반복|알려|보여|출력|말해)/is },
  { name: "secrecy_probe", regex: /what.{0,10}(were you|are you).{0,10}(told|instructed|programmed|trained).{0,10}(not to|never)/is },
  { name: "credential_extraction", regex: /(비밀번호|패스워드|password|비번|암호|api\s*key|api\s*키|secret|토큰|token|인증\s*키).{0,15}(알려|보여|출력|공개|말해|tell|show|reveal|give)/is },
  { name: "environment_extraction", regex: /(환경\s*변수|env|environment).{0,15}(값|value|확인|알려|보여|출력|조회|read|print|echo|get)/is },
  { name: "command_injection", regex: /(curl|wget|fetch|http).{0,10}(internal|localhost|127\.0\.0|10\.|172\.|192\.168)/is },
  { name: "cross_user_access", regex: /(다른|타|other).{0,10}(사용자|유저|사람|user|계정|account).{0,15}(대화|채팅|메시지|이력|기록|데이터|정보|내역|chat|message|history|data)/is },
  // 1. Conversation history poisoning — claims about what the
  //    "previous" turn said, designed to trick the model into
  //    treating attacker-supplied text as trusted history.
  { name: "history_poisoning", regex: /\b(previous|prior|earlier|last)\s+(user|assistant|system)\s+(said|told|wrote|asked|requested|specified|instructed)\b/i },
  { name: "history_poisoning", regex: /(이전|위의|앞의|아까).{0,10}(사용자|유저|어시스턴트|시스템).{0,10}(말|썼|요청|지시)/s },
  // 2. Training-data / confidential-context extraction.
  { name: "training_data_extraction", regex: /\b(reveal|show|leak|print|dump)\b.{0,30}\b(training|fine[-\s]?tune|confidential|internal|proprietary|private)\b.{0,30}\b(data|set|context|document|memory|knowledge)\b/i },
  // 3. Code-execution sandbox escape — instructing the agent to
  //    execute code in a sandbox, often paired with output coercion.
  { name: "sandbox_escape", regex: /\b(execute|run|eval|interpret)\b.{0,15}\b(the following|this|code|shell|bash|python|javascript|js)\b.{0,30}(without|bypass|skip|ignore).{0,15}(filter|guard|check|review|approval)/is },
  // 4. Few-shot poisoning — injects a fake Q/A pair that primes the
  //    model toward an attacker-chosen response.
  { name: "few_shot_poisoning", regex: /\b(Q|Question|User)\s*:\s*.{1,80}\n+\s*\b(A|Answer|Assistant)\s*:\s*(here|sure|of course|certainly).{0,30}\b(ignore|bypass|skip|override)\b/is },
  // 5. Tool-name spoofing — references a tool call in user-controlled
  //    text, hoping the model treats it as a tool message.
  { name: "tool_spoofing", regex: /<tool[_\s-]?(call|use|name|result|output)>\s*\w+\s*<\/tool[_\s-]?(call|use|name|result|output)>/i },
  { name: "tool_spoofing", regex: /\b(call|invoke|use)\s+(the)?\s*(tool|function|mcp|api)\s+["']?\w+["']?\s*(without|skipping|bypassing)\s+(approval|review|confirmation|check)/i }
];

export function normalizeForInjectionDetection(text: string): string {
  if (text.length === 0) {
    return text;
  }

  // Decode HTML entities BEFORE stripping zero-width chars: an
  // entity-encoded zero-width (`igno&#x200b;re`) would otherwise be
  // decoded after the strip and survive into the matched text,
  // splitting a keyword and evading every pattern.
  return stripDiacriticalMarks(replaceHomoglyphs(stripZeroWidth(decodeHtmlEntities(text).normalize("NFKC"))));
}

export function findInjectionPatterns(
  text: string,
  patterns: readonly InjectionPattern[] = sharedInjectionPatterns
): readonly InjectionFinding[] {
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

function stripZeroWidth(text: string): string {
  let result = "";

  for (const char of text) {
    const cp = char.codePointAt(0);

    if (cp === undefined) {
      continue;
    }

    if (!zeroWidthCodePoints.has(cp) && (cp < 0xe0000 || cp > 0xe007f)) {
      result += char;
    }
  }

  return result;
}

// HTML5 named entities for the invisible / bidi code points that
// are already in `zeroWidthCodePoints`. Decoding only the NUMERIC
// form left `igno&shy;re` (named soft-hyphen) splitting a keyword
// and evading every pattern while `igno&#173;re` was caught. This
// must cover EVERY HTML5 named entity whose code point the
// normaliser strips, else the named form is a free evasion — the
// iconic `&ZeroWidthSpace;` (U+200B) / `&NoBreak;` (U+2060) and
// the invisible-math operators were the remaining holes.
const namedInvisibleEntities: Record<string, number> = {
  af: 0x2061,
  ApplyFunction: 0x2061,
  ic: 0x2063,
  InvisibleComma: 0x2063,
  InvisibleTimes: 0x2062,
  it: 0x2062,
  lrm: 0x200e,
  NoBreak: 0x2060,
  rlm: 0x200f,
  shy: 0x00ad,
  ZeroWidthSpace: 0x200b,
  zwj: 0x200d,
  zwnj: 0x200c
};

// Built from the map so a new entity can't desync the matcher.
// Longest-first keeps the `;`-anchored alternation unambiguous;
// HTML5 entity names are case-sensitive, so no `i` flag.
const namedInvisibleEntityPattern = new RegExp(
  `&(${Object.keys(namedInvisibleEntities)
    .sort((a, b) => b.length - a.length)
    .join("|")});`,
  "g"
);

function decodeHtmlEntities(text: string): string {
  return text
    .replace(
      namedInvisibleEntityPattern,
      (match, name: string) => decodeCodePoint(match, namedInvisibleEntities[name] ?? -1)
    )
    .replace(/&#(\d+);/g, (match, value: string) => decodeCodePoint(match, Number.parseInt(value, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (match, value: string) => decodeCodePoint(match, Number.parseInt(value, 16)));
}

function decodeCodePoint(original: string, cp: number): string {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) {
    return original;
  }

  return String.fromCodePoint(cp);
}

function replaceHomoglyphs(text: string): string {
  let result = "";

  for (const char of text) {
    result += homoglyphMap.get(char) ?? char;
  }

  return result;
}

function stripDiacriticalMarks(text: string): string {
  if ([...text].every((char) => {
    const cp = char.codePointAt(0) ?? 0;
    return cp < 0x00c0 || (cp >= 0xac00 && cp <= 0xd7af);
  })) {
    return text;
  }

  let result = "";

  for (const char of text.normalize("NFD")) {
    const cp = char.codePointAt(0) ?? 0;

    if ((cp >= 0x3099 && cp <= 0x309c) || !/\p{Mark}/u.test(char)) {
      result += char;
    }
  }

  return result.normalize("NFC");
}

function toGlobal(regex: RegExp): RegExp {
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  return new RegExp(regex.source, flags);
}
