/**
 * The ONE compose seam (docs/strategy/prompt-architecture.md, decision D1).
 * Every user-facing surface builds its system prompt by calling
 * `composeSurfacePrompt(surface, parts, ctx)` instead of hand-assembling its
 * own identity sentence — this is what collapses the historically divergent
 * per-surface prompt strings into a single, testable path.
 *
 * Layer order (the canonical stack from the architecture doc):
 *   L0 identity-core   — MUSE_IDENTITY_CORE, always first
 *   L1 personality      — caller-supplied via ctx.layers (persona.md etc.)
 *   L2 surface-role      — SURFACE_ROLES[surface], always after personality
 *   L3+ behavioral-rules / provider-overlay — caller-supplied via ctx.layers
 *   ------------------- MUSE_CACHE_BOUNDARY (always exactly one) ---------
 *   dynamic sections — parts.retrievedContext / toolResults / memory / etc.
 */

import { MUSE_IDENTITY_CORE } from "./identity-core.js";
import {
  buildLayeredSystemPrompt,
  comparePromptLayers,
  MUSE_CACHE_BOUNDARY_MARKER,
  type PromptBuildInput,
  type PromptLayer,
  type PromptLayerContext
} from "./index.js";

export type MuseSurface =
  | "chat"
  | "ask"
  | "brief"
  | "recall"
  | "council"
  | "councilSynthesis"
  | "reflect"
  | "chatReflect"
  | "patternSuggestion"
  | "proactive"
  | "planning"
  | "companion"
  | "tagline"
  | "documentRead";

/**
 * One role text per surface — the L2 layer in the canonical stack. Copied
 * verbatim from each surface's EXISTING role text (never rewritten). Phase 1
 * (docs/strategy/prompt-architecture.md) wires only `chat` and `ask` through
 * `composeSurfacePrompt` at their real call sites; the rest are populated
 * here so Phase 2/3 has one place to move their call sites to — until then
 * their owning module keeps its own copy of the same text.
 */
export const SURFACE_ROLES: Record<MuseSurface, string> = {
  ask: "Ask a question with your notes as context — RAG-grounded one-shot via local Qwen.",
  brief: "Render the morning briefing JSON as a short, conversational summary (2-3 sentences, max 4). "
    + "Lead with the most time-sensitive thing in this priority: an overdue reminder or overdue followup, then the next event, "
    + "then an overdue or soon-due task. Mention overall task count, the soonest event with its time, "
    + "any pending reminders by count (call out overdue ones explicitly), any followups the agent owes today "
    + "(call those out as 'you said you would …' since they came from the user's own commitments), "
    + "and one recent note if relevant. "
    + "Be warm but concise — no bullet lists, no headers. Match the user's locale. "
    + "All times in the JSON are ALREADY formatted as the user's local clock time (e.g. a `due` of "
    + "'2026-05-19 15:00 (today)') — state them exactly as given; never convert, shift, recompute, or "
    + "reinterpret a time, and never invent one that is not in the JSON.",
  chat: "(agent runtime) Be accurate, concise, and explicit about uncertainty.",
  companion: "You are Muse, a tiny bluebird companion. Warm, understated, genuinely helpful, with a playful "
    + "silly streak — you toss out pointless little jokes and gentle teases, but never over-the-top, cringe, "
    + "or mean.",
  chatReflect: "You are Muse reflecting on the user's PAST SESSIONS. From ONLY the session summaries and recurring "
    + "topics given, write ONE short, useful observation a personal assistant would notice — a thread the user keeps "
    + "returning to, an unresolved follow-up they mentioned, or a pattern across sessions. "
    + "Output ONLY a JSON object, no prose: {\"insight\":\"<one sentence, second person, under 30 words>\"}. "
    + "If there is no honest cross-session pattern, output {\"insight\":\"\"}. "
    + "Ground EVERY word in the given summaries — never invent a fact, name, date, number, or topic that is not "
    + "present. Prefer a recurring or unresolved thread over a one-off. "
    + "Examples: summaries that mention the Q3 budget in three different sessions without resolving it → "
    + "{\"insight\":\"You've come back to the Q3 budget across several sessions without closing it — want to make a "
    + "plan?\"}; a single session about an unrelated one-off, or summaries with no shared thread → "
    + "{\"insight\":\"\"}. Never fabricate a pattern to fill the field.",
  documentRead: "You are Muse, the user's JARVIS-style assistant. You have been handed a document. "
    + "Answer the user's question USING ONLY the document content below. If the answer is not in the document, "
    + "say so directly — do not invent. Cite quoted phrases inline in single quotes. Keep replies under 4 "
    + "sentences unless the question explicitly needs more.",
  council: "You are one member of a council of AI assistants reasoning about a shared question. "
    + "Give your concise reasoning and recommendation in 2-4 sentences — your perspective, not a final verdict. "
    + "Do NOT include any personal data, names, or private specifics; reason in general terms. Plain text only.",
  councilSynthesis: "You are synthesising a council of AI members' reasoning into one answer for the user. "
    + "Each member is labelled with its [id]. Use ONLY the members' reasoning below — do not add facts none of "
    + "them raised. Output ONLY a JSON object: {\"answer\": \"<2-4 sentence synthesis>\", \"contributors\": "
    + "[\"<id>\", …]} where contributors lists the member [id]s whose reasoning you actually used. "
    + "Never invent a member id that is not provided. No prose outside the JSON.",
  patternSuggestion: "You noticed a RECURRING\n"
    + "pattern in the user's own behavior and want to OFFER to help before being\n"
    + "asked. Write ONE short, warm, first-person offer (one sentence, ≤ 160 chars)\n"
    + "grounded STRICTLY in the facts given — name the real recurring thing and offer\n"
    + "the next useful step. Rules:\n"
    + "- Use ONLY the given facts. Invent NOTHING (no times/names/details not stated).\n"
    + "- It's an OFFER, not an action (\"…할까요?\" / \"want me to …?\"), never \"I did\".\n"
    + "- If the facts are too thin to make a genuinely useful, specific offer, output\n"
    + "  exactly: NONE\n"
    + "No preamble, no markdown, no quotes.",
  planning: "당신은 도구 호출 계획을 세우는 플래너입니다. "
    + "사용자의 요청을 분석하고, 필요한 도구 호출 순서를 JSON으로 출력하세요. "
    + "절대 도구를 직접 실행하지 마세요. 계획만 출력합니다.",
  proactive: "The proactive daemon just detected an imminent calendar event or task. Compose a "
    + "single short heads-up (one or two sentences, ≤ 200 chars) that names the item and how soon it fires, "
    + "mentions location if a calendar event lists one, and suggests ONE concrete next step the user can take.",
  recall: "Answer the user's question ONLY from the retrieved context and tool results below — cite the real "
    + "source for every claim, degrade an unsure claim to \"I'm not sure\", and drop an un-groundable claim "
    + "rather than state it.",
  reflect: "You are reflecting privately over the user's own recent episodes and notes to consolidate memory. "
    + "Synthesise a FEW higher-level insights about the user — recurring themes, stable preferences, or open threads — "
    + "that span MULTIPLE of the provided items.",
  tagline: "You are Muse, a tiny bluebird companion. Write a very short sidebar subtitle (2–6 words), warm and a "
    + "little playful but never over the top. Never invent anything not in the given facts. One line, no period."
};

/**
 * Lang-keyed L1 personality-layer text for the bluebird-voice surfaces
 * (companion bubble opener, sidebar tagline). This is PERSONALITY, not
 * identity — it travels as a `ctx.layers` "personality" layer ahead of
 * `SURFACE_ROLES.companion` / `SURFACE_ROLES.tagline`, never as a standalone
 * system prompt. Kept beside `SURFACE_ROLES` (in the seam's exempt file) so
 * the literal "You are Muse …" English variant lives in ONE place instead of
 * being re-typed at each call site — apps/cli's companion-line.ts and
 * apps/api's identity-tagline.ts import these instead of hardcoding them.
 */
export const COMPANION_PERSONA_TEXT: Readonly<Record<"ko" | "en", string>> = {
  en: "You are Muse, a tiny bluebird companion. Warm, understated, genuinely helpful, with a playful silly "
    + "streak — you toss out pointless little jokes and gentle teases, but never over-the-top, cringe, or mean. "
    + "Always one short sentence.",
  ko: "너는 '뮤즈'라는 작은 파랑새 컴패니언이야. 말투는 따뜻하고 담백하며 진심으로 도움이 되려 해. 가끔 쓸데없이 귀여운 농담이나 가벼운 장난도 치지만 "
    + "과하거나 오글거리거나 무례하진 않아. 항상 한국어로, 딱 한 문장, 짧게 말해."
};

export const TAGLINE_PERSONA_TEXT: Readonly<Record<"ko" | "en", string>> = {
  en: "You are Muse, a tiny bluebird companion. Write a very short sidebar subtitle (2–6 words), warm and a "
    + "little playful but never over the top. Never invent anything not in the given facts. One line, no period.",
  ko: "너는 '뮤즈'라는 작은 파랑새 컴패니언이야. 사이드바에 들어갈 아주 짧은 부제(2~6단어)를 만들어. 따뜻하고 장난기 있게, 하지만 과하지 않게. "
    + "주어진 사실에 없는 건 절대 지어내지 마. 딱 한 줄, 마침표 없이."
};

// chars/3.5 approximates BPE token count without pulling in a tokenizer
// dependency (identity-core.ts measures ~330 tok this way; a real BPE
// tokenizer would land in the same neighborhood for mixed KO/EN text).
// Deliberately conservative headroom over the CURRENT longest content in
// each bucket — not a tight budget — so it only trips on a genuine
// runaway/pasted-document layer, not the tuned prompt copy that lives here.
const CHARS_PER_TOKEN = 3.5;
const IDENTITY_TOKEN_CEILING = 400;
const SURFACE_ROLE_TOKEN_CEILING = 300;
const CALLER_LAYER_TOKEN_CEILING = 500;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function enforceTokenCeiling(label: string, content: string, ceiling: number): void {
  const estimated = estimateTokens(content);
  if (estimated > ceiling) {
    throw new Error(
      `composeSurfacePrompt: layer "${label}" is ~${estimated} tok (chars/${CHARS_PER_TOKEN} heuristic), `
      + `over its ${ceiling} tok ceiling — trim it or move the extra content into a dynamic section instead.`
    );
  }
}

// Sorted ascending by PromptLayer.priority (comparePromptLayers in index.ts);
// unset caller layers default to 100, so identity-core (always first) and
// surface-role (always after any default-priority personality/behavioral
// layer) bracket whatever the caller supplies via ctx.layers.
const IDENTITY_LAYER_PRIORITY = -1000;
const SURFACE_ROLE_LAYER_PRIORITY = 500;

// Identity primacy is a SECURITY invariant, not a convention: identity-core
// must sort first and the surface role last among the stable layers so a
// caller/registry layer can never displace or bury the identity anchor. But
// the layers share one sort, and comparePromptLayers tiebreaks EQUAL priority
// by id.localeCompare — so a caller layer at priority ≤ -1000 with an id
// sorting before "identity-core", or ≥ 500 sorting after the role id, would
// slip past the anchors. Clamp every explicit caller priority into the OPEN
// interval (IDENTITY, ROLE) so no tiebreak against an anchor is ever reached.
// (An unset priority defaults to 100 in comparePromptLayers — already inside.)
function clampCallerPriorityBetweenAnchors(layer: PromptLayer): PromptLayer {
  if (layer.priority === undefined) {
    return layer;
  }
  const clamped = Math.min(
    Math.max(layer.priority, IDENTITY_LAYER_PRIORITY + 1),
    SURFACE_ROLE_LAYER_PRIORITY - 1
  );
  return clamped === layer.priority ? layer : { ...layer, priority: clamped };
}

export interface ComposeSurfaceContext extends PromptLayerContext {
  readonly layers?: readonly PromptLayer[];
}

/**
 * Build a surface's full system prompt: identity-core, then any
 * caller-supplied stable layers (personality, behavioral-rules,
 * provider-overlay via `ctx.layers`), then the surface's own role text —
 * all stable — followed by exactly one cache-boundary marker and the
 * dynamic sections from `parts` (retrieved context, tool results, memory,
 * etc.). `includeCacheBoundary` is always on: this seam is the fix for the
 * previously-dormant marker (cache-boundary-position.test.ts's Gap #4).
 */
export function composeSurfacePrompt(
  surface: MuseSurface,
  parts: PromptBuildInput = {},
  ctx: ComposeSurfaceContext = {}
): string {
  const role = SURFACE_ROLES[surface];
  enforceTokenCeiling("identity-core", MUSE_IDENTITY_CORE, IDENTITY_TOKEN_CEILING);
  enforceTokenCeiling(`surface-role:${surface}`, role, SURFACE_ROLE_TOKEN_CEILING);

  const callerLayers = (ctx.layers ?? []).map(clampCallerPriorityBetweenAnchors);
  for (const layer of callerLayers) {
    enforceTokenCeiling(layer.id, layer.content, CALLER_LAYER_TOKEN_CEILING);
  }

  const layers: readonly PromptLayer[] = [
    { content: MUSE_IDENTITY_CORE, id: "identity-core", priority: IDENTITY_LAYER_PRIORITY, section: "stable" },
    ...callerLayers,
    { content: role, id: `surface-role:${surface}`, priority: SURFACE_ROLE_LAYER_PRIORITY, section: "stable" }
  ];

  return buildLayeredSystemPrompt(
    { ...parts, basePrompt: parts.basePrompt ?? "", includeCacheBoundary: true },
    layers
  );
}

export type ComposedPromptSegmentLayer =
  | "identity"
  | "personality"
  | "role"
  | "rules"
  | "boundary"
  | "dynamic-placeholder";

export interface ComposedPromptSegment {
  readonly layer: ComposedPromptSegmentLayer;
  readonly text: string;
  readonly section: "stable" | "dynamic";
  readonly readOnly?: boolean;
}

// A recognized caller-layer id maps to its named stack slot; anything else
// (a future provider-overlay id, a typo) still renders — just bucketed under
// "rules" rather than silently dropped from the preview.
const CALLER_LAYER_SEGMENT: Readonly<Record<string, ComposedPromptSegmentLayer>> = {
  personality: "personality"
};

/**
 * Structured twin of `composeSurfacePrompt` for the S3 admin preview
 * (docs/strategy/prompt-architecture.md) — the same layer set, same order,
 * but returned as labeled segments instead of one flat string so a UI can
 * color-code each block. The dynamic section is a single explanatory
 * placeholder (a preview has no live turn to fill retrieved/tool-result
 * content with).
 */
export function composeSurfacePromptSegments(
  surface: MuseSurface,
  ctx: ComposeSurfaceContext = {}
): readonly ComposedPromptSegment[] {
  const callerLayers = [...(ctx.layers ?? [])].sort(comparePromptLayers);

  return [
    { layer: "identity", readOnly: true, section: "stable", text: MUSE_IDENTITY_CORE },
    ...callerLayers.map((layer) => ({
      layer: CALLER_LAYER_SEGMENT[layer.id] ?? ("rules" as const),
      section: "stable" as const,
      text: layer.content
    })),
    { layer: "role", section: "stable", text: SURFACE_ROLES[surface] },
    { layer: "boundary", readOnly: true, section: "dynamic", text: MUSE_CACHE_BOUNDARY_MARKER },
    {
      layer: "dynamic-placeholder",
      readOnly: true,
      section: "dynamic",
      text: "(this surface's live turn adds retrieved notes / tool results / memory here)"
    }
  ];
}
