/**
 * Personalized sidebar tagline generator — the fun, ever-changing subtitle
 * that replaces the static "AI 지휘자" / "AI Conductor" under "Muse".
 *
 * It follows the `companion-line` pattern (a grounded line the local model MAY
 * re-phrase, gated by a fabrication post-check; a content-free playful pool as
 * the floor) but is tuned for a tiny subtitle: 2–6 words that fit under the
 * brand name and subtly show Muse knows the user.
 *
 * The hard invariant is unchanged: fabrication = 0. It holds per PATH:
 *
 *   - GROUNDED — one or more real fact atoms exist (a stored fact/preference
 *     value or recent topic). The candidate is composed DETERMINISTICALLY from
 *     those real strings (`taglineTemplates`), so it is true by construction.
 *     The local model MAY re-phrase it, but the new line survives ONLY if
 *     `taglineIsGrounded` proves it introduced no invented word / number. Any
 *     violation ⇒ the deterministic candidate stands.
 *   - CONTENT-FREE — no fact atoms at all (empty profile). The line comes from
 *     the `contentFreePool`, which asserts NOTHING about the user, so it is
 *     fabrication-safe by construction. With no atoms, no fact-bearing line can
 *     be produced here at all — that is the fabrication floor.
 *
 * Variety: a rotation counter + recent-line window (a small state file) so each
 * app open differs and never immediately repeats.
 */

import { composeSurfacePrompt, TAGLINE_PERSONA_TEXT } from "@muse/prompts";
import { sleep } from "@muse/shared";

export type TaglineLang = "ko" | "en";

/** The subset of UserMemory this generator reads — kept local so the module has no store dep. */
export interface IdentityMemory {
  readonly facts?: Readonly<Record<string, string>>;
  readonly preferences?: Readonly<Record<string, string>>;
  readonly recentTopics?: readonly string[];
}

export interface TaglineResult {
  readonly tagline: string;
  readonly grounded: boolean;
}

/** A fact atom is short enough to fit a subtitle — longer values are skipped. */
const MAX_ATOM_LENGTH = 16;
/** Hard ceiling on the whole subtitle so it never overflows under "Muse". */
const MAX_TAGLINE_LENGTH = 30;
/** How many candidate atoms to keep (avoid unbounded scans). */
const MAX_ATOMS = 8;

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, " ").trim();
}

// A subtitle ABOUT a person's name reads oddly even when framed ("Dr. Kim 담당" =
// "in charge of Dr. Kim"), so such atoms are dropped before they can seed a line.
// Conservative on purpose — only two unambiguous shapes, so an ordinary interest
// atom (커피, 러닝, coffee, running, a role) is never filtered:
//   - an English honorific PREFIX + a following name token ("Dr. Kim", "Mr Lee")
//   - a Korean name followed by the 선생님 title ("김 선생님", "박선생님")
// The bare ~씨 / ~님 suffix is deliberately NOT used: it false-positives on real
// topic atoms (날씨 = weather, 솜씨 = skill), so it fails the "few robust lines" bar.
function looksLikePersonName(value: string): boolean {
  const t = value.trim();
  if (/^(dr|mr|mrs|ms|mx|prof)\.?\s+\S/iu.test(t)) return true;
  return /\S\s*선생님$/u.test(t);
}

/**
 * Collect the SHORT, user-facing fact values Muse has stored — the raw material
 * for a grounded subtitle AND the evidence set the fabrication check validates
 * against. Only compact values (a role, a drink, an interest, a recent topic)
 * survive; long sentences are skipped so the subtitle stays tiny.
 */
export function gatherIdentityFacts(memory: IdentityMemory | undefined): readonly string[] {
  if (!memory) return [];
  const raw: string[] = [
    ...Object.values(memory.facts ?? {}),
    ...Object.values(memory.preferences ?? {}),
    ...(memory.recentTopics ?? [])
  ];
  const seen = new Set<string>();
  const atoms: string[] = [];
  for (const value of raw) {
    const clean = String(value ?? "").replace(/\s+/gu, " ").trim();
    if (clean.length === 0 || clean.length > MAX_ATOM_LENGTH) continue;
    if (looksLikePersonName(clean)) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    atoms.push(clean);
    if (atoms.length >= MAX_ATOMS) break;
  }
  return atoms;
}

/**
 * The small bluebird persona applied to every model-generated subtitle —
 * identity-core (L0) + the lang-specific voice flavor (L1 personality layer,
 * `TAGLINE_PERSONA_TEXT` from `@muse/prompts`) + the tagline surface role
 * (L2, `SURFACE_ROLES.tagline`).
 */
export function taglinePersona(lang: TaglineLang): string {
  return composeSurfacePrompt("tagline", {}, {
    layers: [{ content: TAGLINE_PERSONA_TEXT[lang], id: "personality", section: "stable" }]
  });
}

/**
 * Build the deterministic candidate subtitles from real atoms. Every template
 * interpolates ONLY the passed atom strings and frames them as WHAT MUSE HELPS
 * WITH (담당/파트너/곁 — never a claim about the user's feelings), so a
 * rendered line is true by construction whenever the atoms came from the store.
 */
export function taglineTemplates(atoms: readonly string[], lang: TaglineLang): readonly string[] {
  if (atoms.length === 0) return [];
  const a = atoms[0]!;
  const b = atoms[1];
  const ko = lang === "ko";
  const out: string[] = ko
    ? [`${a} 담당`, `당신의 ${a} 파트너`, `${a}, 제가 챙길게요`, `오늘도 ${a}와 함께`, `${a} 곁의 파랑새`]
    : [`On ${a} duty`, `Your ${a} buddy`, `Here for ${a}`, `${a}, handled`, `Your ${a} bird`];
  if (b) {
    out.push(...(ko ? [`${a}·${b} 담당`, `${a}와 ${b}, 제가 챙겨요`] : [`${a} & ${b}, covered`, `Your ${a} & ${b} buddy`]));
  }
  return out.filter((line) => line.length <= MAX_TAGLINE_LENGTH);
}

/**
 * The content-free playful pool — asserts NOTHING about the user, so it is
 * fabrication-safe by construction. This is the ONLY thing that can be shown
 * when there are no facts, and the fallback whenever a grounded/model line
 * fails its checks.
 */
export function contentFreePool(lang: TaglineLang): readonly string[] {
  return lang === "ko"
    ? ["당신만의 파랑새", "여기, 당신 전용 AI", "옆자리 파랑새", "오늘도 당신 곁에", "당신의 작은 AI", "곁에 있는 파랑새"]
    : ["Your very own bluebird", "Here, your AI", "Bluebird by your side", "Always right beside you", "Your little AI", "A bird in your corner"];
}

/** Persona / filler words the MODEL may use that make no claim about the user. */
const PERSONA_ALLOW: readonly string[] = [
  // Korean framing
  "파랑새", "당신", "여기", "옆자리", "전용", "담당", "함께", "곁", "오늘", "파트너",
  "뮤즈", "챙겨", "챙길게요", "챙기", "작은", "제가", "곁에", "너의", "친구", "도우",
  // English framing
  "your", "you", "here", "muse", "bird", "bluebird", "buddy", "side", "little",
  "always", "near", "beside", "right", "own", "very", "for", "and", "the", "duty",
  "partner", "covered", "with", "corner", "friend", "pal", "handled"
];

function significantTokens(line: string): readonly string[] {
  const cjk = line.match(/\p{Script=Hangul}{2,}/gu) ?? [];
  const latin = line.toLowerCase().match(/[a-z]{3,}/gu) ?? [];
  return [...cjk, ...latin];
}

// token is a substring of the facts, OR a fact atom (+ a Korean particle /
// English suffix) is a substring of the token — this grounds "커피와" against
// the atom "커피" while still rejecting an invented "고양이".
function isAtomToken(token: string, factsNorm: string, factAtomsNorm: readonly string[]): boolean {
  if (factsNorm.includes(token)) return true;
  return factAtomsNorm.some((atom) => atom.length >= 2 && token.includes(atom));
}

function isPersonaToken(token: string): boolean {
  for (const allow of PERSONA_ALLOW) {
    if (token === allow || token.includes(allow) || allow.includes(token)) return true;
  }
  return false;
}

function isAllowedToken(token: string, factsNorm: string, factAtomsNorm: readonly string[]): boolean {
  return isAtomToken(token, factsNorm, factAtomsNorm) || isPersonaToken(token);
}

// Any standalone digit run is a candidate fabricated count. Unlike a prose
// grounding check we do NOT excuse a digit sitting next to a letter ("3잔"): in
// a two-word subtitle that is a made-up count, so every digit run must appear
// verbatim among the real atoms or the line is rejected.
function digitRuns(text: string): readonly string[] {
  return text.replace(/,/gu, "").match(/\d+(?:\.\d+)?/gu) ?? [];
}

/**
 * The HARD fabrication gate on a MODEL-generated subtitle: true ONLY if the line
 * introduces no datum absent from the atoms. Rejects:
 *  - empty / over-length / refusal leakage,
 *  - a NEW number (a digit-run not present verbatim in the atoms),
 *  - a NEW content word — any Hangul run (≥2) or Latin word (≥3) that is neither
 *    found in the atoms nor a persona/filler word. This is what stops an invented
 *    trait ("고양이 담당" when the store never said cat) from ever being shown.
 */
export function taglineIsGrounded(line: string, atoms: readonly string[]): boolean {
  const clean = line.trim();
  if (clean.length === 0 || clean.length > MAX_TAGLINE_LENGTH) return false;
  const lower = clean.toLowerCase();
  if (lower.includes("i'm not sure") || lower.includes("sorry") || clean.includes("잘 모르") || clean.includes("죄송")) {
    return false;
  }

  const factsJoined = atoms.join(" ");
  const factNumbers = new Set(digitRuns(factsJoined));
  for (const run of digitRuns(clean)) {
    if (!factNumbers.has(run)) return false;
  }

  const factsNorm = normalizeForMatch(factsJoined);
  const factAtomsNorm = atoms.map(normalizeForMatch);
  for (const token of significantTokens(clean)) {
    if (!isAllowedToken(token, factsNorm, factAtomsNorm)) return false;
  }
  return true;
}

/**
 * The SHAPE gate on a MODEL-generated subtitle, stacked ON TOP of the fabrication
 * gate. Grounded ≠ well-formed: a bare echo of an atom ("Dr. Kim") is grounded —
 * every token comes from the store — yet it is a useless, faintly creepy subtitle
 * (it's just a stored name), not a warm line about what Muse helps with. So the
 * model line must ALSO frame the atom.
 *
 * A well-formed line therefore contains at least one significant persona/framing
 * token that is NOT drawn from the atoms — exactly what every `taglineTemplates`
 * line adds (담당 / 파트너 / 곁 / duty / buddy / handled …). A line whose only
 * significant tokens are the atom itself adds no framing and is rejected; the
 * caller then keeps the grounded-by-construction template line instead.
 */
export function taglineIsWellFormed(line: string, atoms: readonly string[]): boolean {
  if (!taglineIsGrounded(line, atoms)) return false;
  const factsNorm = normalizeForMatch(atoms.join(" "));
  const factAtomsNorm = atoms.map(normalizeForMatch);
  return significantTokens(line.trim()).some(
    (token) => isPersonaToken(token) && !isAtomToken(token, factsNorm, factAtomsNorm)
  );
}

function pickRotating(items: readonly string[], recent: readonly string[], rotation: number): string {
  const usable = items.filter((line) => !recent.includes(line));
  const pool = usable.length > 0 ? usable : items;
  if (pool.length === 0) return "";
  const i = ((rotation % pool.length) + pool.length) % pool.length;
  return pool[i]!;
}

/**
 * Choose the deterministic subtitle (before any optional model layer). With
 * atoms present the line is grounded-by-construction from a template; with none
 * it is a content-free pool line. Pure — deterministic in `rotation` + `recent`.
 */
export function selectTagline(params: {
  readonly atoms: readonly string[];
  readonly lang: TaglineLang;
  readonly recent: readonly string[];
  readonly rotation: number;
}): TaglineResult {
  const { atoms, lang, recent, rotation } = params;
  const templates = taglineTemplates(atoms, lang);
  if (templates.length > 0) {
    return { grounded: true, tagline: pickRotating(templates, recent, rotation) };
  }
  return { grounded: false, tagline: pickRotating(contentFreePool(lang), recent, rotation) };
}

/** Prompt that asks the model to re-phrase the real atoms into ONE tiny subtitle. */
export function buildTaglinePrompt(atoms: readonly string[], lang: TaglineLang): { system: string; prompt: string } {
  const facts = atoms.join(", ");
  const prompt = lang === "ko"
    ? `아래 사실만으로 아주 짧은 사이드바 부제를 한 줄 만들어줘(2~6단어). 사실에 없는 이름·숫자·단어는 절대 지어내지 마. 사실: ${facts}`
    : `Write one very short sidebar subtitle (2–6 words) using ONLY these facts. Never invent a name, number, or word not in them. Facts: ${facts}`;
  return { prompt, system: taglinePersona(lang) };
}

/** Injectable model layer — a fake in tests, the real local provider in the route. */
export interface TaglineModelFn {
  (args: { readonly system: string; readonly prompt: string }): Promise<string>;
}

function stripWrapping(raw: string): string {
  return raw
    .trim()
    .replace(/^["'“”「『]+/u, "")
    .replace(/["'“”」』.]+$/u, "")
    .split(/\r?\n/u)[0]!
    .trim();
}

/**
 * Apply the optional local-model layer to a grounded plan: re-phrase and swap
 * ONLY when `taglineIsWellFormed` proves the new line invented nothing AND
 * framed the atom (not a bare echo of it). A content-free plan (no atoms) is
 * never sent to the model — the pool line stands. Any miss / failure keeps the
 * deterministic line.
 */
export async function applyTaglineModel(
  plan: TaglineResult,
  atoms: readonly string[],
  lang: TaglineLang,
  model: TaglineModelFn | undefined,
  timeoutMs = 8000
): Promise<TaglineResult> {
  if (!model || !plan.grounded || atoms.length === 0) return plan;
  const { system, prompt } = buildTaglinePrompt(atoms, lang);
  let out: string | undefined;
  try {
    out = await Promise.race([
      model({ prompt, system }).catch(() => undefined),
      sleep(timeoutMs).then(() => undefined)
    ]);
  } catch {
    out = undefined;
  }
  if (!out) return plan;
  const candidate = stripWrapping(out);
  return taglineIsWellFormed(candidate, atoms) ? { grounded: true, tagline: candidate } : plan;
}
