/**
 * Per-turn skill exposure (ITR, arXiv:2602.17046: retrieve the minimal
 * system-prompt fragments per step). The chat used to bake EVERY skill's full
 * body into the system prompt for the whole session — N×~600 chars the model
 * pays for and is distracted by on every turn, however irrelevant. Instead,
 * select the skills whose name/description lexically match THIS turn's prompt
 * and inject only their bodies; every other skill still appears as a one-line
 * index entry, so discoverability is never lost — only the body cost is.
 */

import type { Skill } from "@muse/skills";

const SKILL_BODY_CHARS = 600;
const DEFAULT_MAX_BODIES = 2;

// Generic words that would otherwise make every skill "match" every prompt
// (skill descriptions are written "Use when the user wants to …").
const STOPWORDS = new Set([
  "the", "and", "for", "you", "your", "when", "with", "that", "this", "use",
  "user", "wants", "want", "will", "can", "should", "muse", "are", "from",
  "into", "let", "its", "their", "them", "they", "have", "has", "about"
]);

function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const token of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (token.length >= 3 && !STOPWORDS.has(token)) out.add(token);
  }
  return out;
}

/** Start-anchored, suffix-tolerant match (mirrors the tool-relevance rule):
 * "posts" hits "post", but "postpone" does not hit "post". */
function tokenHits(token: string, target: string): boolean {
  if (token === target) return true;
  return target.length >= 4 && token.startsWith(target) && token.length - target.length <= 3;
}

/** Skills whose name/description share a content word with the prompt, ranked
 * by overlap count, capped. Empty when nothing lexically matches. */
export function selectRelevantSkills(
  skills: readonly Skill[],
  prompt: string,
  max: number = DEFAULT_MAX_BODIES,
  isAvoided?: (name: string) => boolean
): Skill[] {
  const promptTokens = contentTokens(prompt);
  if (promptTokens.size === 0) return [];
  const scored = skills
    .filter((skill) => !isAvoided?.(skill.name)) // RL avoidance: a corrected-into-the-floor skill is not applied
    .map((skill) => {
      const skillTokens = contentTokens(`${skill.name} ${skill.description}`);
      let score = 0;
      for (const skillToken of skillTokens) {
        for (const promptToken of promptTokens) {
          if (tokenHits(promptToken, skillToken)) { score += 1; break; }
        }
      }
      return { score, skill };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
  return scored.slice(0, Math.max(0, max)).map((entry) => entry.skill);
}

/**
 * The skills system-prompt block for one turn: the relevant skills carry their
 * full body, the rest are name+description index lines only. `prompt` omitted
 * (or no match) → all index-only. `onSelected` fires for each skill whose
 * body is injected this turn — callers use it to record usage. `isAvoided`
 * (the RL signal) drops a repeatedly-corrected skill from the prompt entirely —
 * no body, not even an index line — so the model stops applying it.
 */
export function buildSkillsPrompt(
  skills: readonly Skill[],
  prompt = "",
  onSelected?: (skill: Skill) => void,
  isAvoided?: (name: string) => boolean
): string {
  const eligible = isAvoided ? skills.filter((skill) => !isAvoided(skill.name)) : skills;
  if (eligible.length === 0) return "";
  const selectedSkills = selectRelevantSkills(eligible, prompt);
  const relevant = new Set(selectedSkills.map((skill) => skill.name));
  if (onSelected) {
    for (const skill of selectedSkills) onSelected(skill);
  }
  const blocks = eligible.map((skill) => {
    const head = `### ${skill.name}\n${skill.description}`;
    return relevant.has(skill.name) ? `${head}\n${skill.body.slice(0, SKILL_BODY_CHARS).trim()}` : head;
  });
  return `\n\n## Skills — follow the most relevant one when the user's request matches its purpose.\n${blocks.join("\n\n")}`;
}
