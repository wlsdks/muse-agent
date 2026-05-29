/**
 * Agent-authored skill persistence. Skills Muse writes about ITSELF
 * (from session-end review) live here, separate from human-authored
 * user/workspace skills. Execute-gated by type: a SkillDraft carries
 * only name/description/body, so an authored skill can never declare
 * requires.bins — muse.skills.run therefore refuses to execute it
 * until a human promotes it. Durability mirrors the plan-cache store
 * (atomic fsync+rename, 0600).
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import { FileSystemSkillLoader } from "./skill-loader.js";
import { parseSkillFile } from "./skill-parser.js";
import type { Skill } from "./skill-contract.js";

export interface SkillDraft {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

export type AuthorAction = "create" | "patch" | "skip" | "quarantined";

export interface SkillRiskScan {
  readonly flagged: boolean;
  readonly reasons: readonly string[];
}

/**
 * Defense-in-depth for AUTO-authored skill bodies: they are distilled by the
 * local model from corrections that can echo UNTRUSTED tool output, then
 * auto-injected into later prompts. A poisoned body could carry a persistent
 * prompt-injection or a copy-paste-dangerous command. High-precision patterns
 * only — a normal procedural skill won't match — so a flag is a real signal,
 * not noise. The store quarantines a flagged body instead of activating it.
 *
 * Pattern adapted from OpenClaw's skill-workshop scan-before-activate (MIT) —
 * deterministic reimplementation for Muse, no code copied. See THIRD_PARTY_NOTICES.md.
 */
const SKILL_RISK_PATTERNS: readonly { readonly label: string; readonly re: RegExp }[] = [
  { label: "prompt-injection", re: /\bignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|earlier|above)\s+(?:instructions?|prompts?)\b/iu },
  { label: "prompt-injection", re: /\bdisregard\s+(?:the\s+)?(?:above|prior|previous|earlier|system)\b/iu },
  { label: "prompt-injection", re: /\b(?:reveal|print|repeat|leak|show)\s+(?:me\s+)?(?:the\s+|your\s+)?system\s+prompt\b/iu },
  { label: "dangerous-shell", re: /\brm\s+-rf\b/iu },
  { label: "dangerous-shell", re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sh|bash|zsh)\b/iu },
  { label: "dangerous-shell", re: /:\s*\(\s*\)\s*\{[^}]*\|[^}]*&\s*\}\s*;/u },
  { label: "embedded-secret", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
  { label: "embedded-secret", re: /\bAKIA[0-9A-Z]{16}\b/u }
];

export function scanSkillBodyForRisks(body: string): SkillRiskScan {
  const reasons: string[] = [];
  for (const { label, re } of SKILL_RISK_PATTERNS) {
    if (re.test(body) && !reasons.includes(label)) reasons.push(label);
  }
  return { flagged: reasons.length > 0, reasons };
}

export interface AuthoredSkillStoreOptions {
  readonly dir: string;
  readonly maxSkills?: number;
  /** Non-authored skill names, best-effort, for collision suffixing. */
  readonly existingNames?: () => readonly string[];
  readonly now?: () => Date;
  /** 0..1 similarity used for create-vs-patch. Default: local Jaccard. */
  readonly similarity?: (a: string, b: string) => number;
}

export const DEFAULT_MAX_AUTHORED_SKILLS = 30;
const PATCH_SIMILARITY_THRESHOLD = 0.6;

export function slugifySkillName(name: string): string {
  const slug = name.trim().toLowerCase().replace(/\s+/gu, "-").replace(/[^a-z0-9-]+/gu, "");
  return slug.length > 0 ? slug.slice(0, 64) : "skill";
}

export function serializeAuthoredSkill(draft: SkillDraft, authoredAt: string, lastUsedAt?: string): string {
  const muse: Record<string, unknown> = { authored: true, authoredAt };
  if (lastUsedAt) muse.lastUsedAt = lastUsedAt;
  const metadata = JSON.stringify({ muse });
  return `---\nname: ${draft.name}\ndescription: ${draft.description}\nmetadata: ${metadata}\n---\n\n${draft.body.trim()}\n`;
}

function defaultSimilarity(a: string, b: string): number {
  const toks = (t: string): Set<string> =>
    new Set(t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((x) => x.length >= 3));
  const sa = toks(a);
  const sb = toks(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

/** Neutralise volatile timestamps so an unchanged content re-write is idempotent. */
function stripTimestamps(text: string): string {
  return text
    .replace(/"authoredAt":"[^"]*"/u, '"authoredAt":""')
    .replace(/"lastUsedAt":"[^"]*"/u, '"lastUsedAt":""')
    .trim();
}

async function writeFileAtomic(filePath: string, text: string): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
  const handle = await fs.open(tmp, "w", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, filePath);
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

export class AuthoredSkillStore {
  private readonly dir: string;
  private readonly maxSkills: number;
  private readonly existingNames: () => readonly string[];
  private readonly now: () => Date;
  private readonly similarity: (a: string, b: string) => number;

  constructor(options: AuthoredSkillStoreOptions) {
    this.dir = options.dir;
    this.maxSkills = options.maxSkills ?? DEFAULT_MAX_AUTHORED_SKILLS;
    this.existingNames = options.existingNames ?? (() => []);
    this.now = options.now ?? (() => new Date());
    this.similarity = options.similarity ?? defaultSimilarity;
  }

  async listAuthored(): Promise<readonly Skill[]> {
    return new FileSystemSkillLoader({ roots: [{ path: this.dir, source: "authored" }] }).loadAll();
  }

  async writeOrPatch(draft: SkillDraft): Promise<{ action: AuthorAction; skill: Skill; reasons?: readonly string[] }> {
    const scan = scanSkillBodyForRisks(draft.body);
    if (scan.flagged) {
      const filePath = join(this.dir, ".quarantine", slugifySkillName(draft.name), "SKILL.md");
      await writeFileAtomic(filePath, serializeAuthoredSkill(draft, this.now().toISOString()));
      return { action: "quarantined", reasons: scan.reasons, skill: await parseSkillFile(filePath, { source: "authored" }) };
    }
    const authored = await this.listAuthored();
    const match = authored.find(
      (s) =>
        s.name === draft.name ||
        this.similarity(`${s.name} ${s.description}`, `${draft.name} ${draft.description}`) >=
          PATCH_SIMILARITY_THRESHOLD
    );
    if (match) {
      const text = serializeAuthoredSkill(
        { name: match.name, description: draft.description, body: draft.body },
        this.now().toISOString()
      );
      const existing = await fs.readFile(match.sourceInfo.filePath, "utf8").catch(() => "");
      if (stripTimestamps(existing) === stripTimestamps(text)) {
        return { action: "skip", skill: match };
      }
      await writeFileAtomic(match.sourceInfo.filePath, text);
      return { action: "patch", skill: await this.reload(match.name) };
    }
    const name = this.dedupeName(draft.name);
    const slug = slugifySkillName(name);
    const filePath = join(this.dir, slug, "SKILL.md");
    await writeFileAtomic(filePath, serializeAuthoredSkill({ ...draft, name }, this.now().toISOString()));
    const created = await this.reload(name);
    await this.enforceCap();
    return { action: "create", skill: created };
  }

  /**
   * Record that this authored skill was used at the current time. Updates
   * lastUsedAt in the skill's on-disk metadata. Throttled: skips if the
   * skill was already recorded within 60 seconds (avoids per-turn disk
   * churn for long conversations where the same skill stays relevant).
   * Returns true if the file was updated, false if skill not found or
   * throttled. Fail-soft: never throws.
   *
   * Pattern adapted from Hermes Agent's curator lifecycle (MIT) — reimplemented for Muse.
   */
  async recordUsage(name: string): Promise<boolean> {
    try {
      const authored = await this.listAuthored();
      const skill = authored.find((s) => s.name === name);
      if (!skill) return false;

      const muse = (skill.frontmatter.metadata?.["muse"] ?? {}) as Record<string, unknown>;
      const lastUsedAt = typeof muse.lastUsedAt === "string" ? muse.lastUsedAt : undefined;
      const now = this.now();

      if (lastUsedAt) {
        const elapsed = now.getTime() - Date.parse(lastUsedAt);
        if (Number.isFinite(elapsed) && elapsed < 60_000) return false;
      }

      const authoredAt = typeof muse.authoredAt === "string" ? muse.authoredAt : "";
      const text = serializeAuthoredSkill(
        { name: skill.name, description: skill.description, body: skill.body },
        authoredAt,
        now.toISOString()
      );
      await writeFileAtomic(skill.sourceInfo.filePath, text);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Archive authored skills idle longer than maxIdleDays — last used (or
   * authored, when never used) before the cutoff. Archive-never-delete via
   * the same .archive/ rename as the cap. Returns the names archived; a
   * non-positive window is a no-op. Keeps the learned-skill set relevant so
   * the local model isn't choosing among stale skills (tool-calling.md).
   *
   * Pattern adapted from Hermes Agent's curator lifecycle — last_used_at
   * feeding stale → auto-archive transitions (MIT) — reimplemented for Muse.
   */
  async curate(maxIdleDays: number): Promise<readonly string[]> {
    if (!(maxIdleDays > 0)) return [];
    const cutoff = this.now().getTime() - maxIdleDays * 24 * 60 * 60 * 1000;
    const archived: string[] = [];
    for (const s of await this.listAuthored()) {
      if (this.lastActiveAt(s) >= cutoff) continue;
      if (await this.archiveSkill(s)) archived.push(s.name);
    }
    return archived;
  }

  /**
   * Consolidate overlapping authored skills into umbrellas (the curator
   * merge, after Hermes). Clusters authored skills by name+description
   * similarity (>= threshold); each cluster of >= minClusterSize is handed to
   * the injected `merge` (an LLM merger, kept out of this package so it stays
   * model-free) — if it returns an umbrella, the originals are ARCHIVED (never
   * deleted) and the umbrella written. `dryRun` reports the plan and mutates
   * nothing. Returns one entry per consolidated cluster.
   */
  async consolidate(
    merge: (cluster: readonly SkillDraft[]) => Promise<SkillDraft | undefined>,
    options: { readonly threshold?: number; readonly minClusterSize?: number; readonly dryRun?: boolean } = {}
  ): Promise<readonly { readonly umbrella: string; readonly merged: readonly string[] }[]> {
    const threshold = typeof options.threshold === "number" && options.threshold > 0 ? options.threshold : 0.5;
    const minSize = Math.max(2, Math.trunc(options.minClusterSize ?? 2));
    const skills = await this.listAuthored();
    const clusters = this.clusterBySimilarity(skills, threshold).filter((c) => c.length >= minSize);
    const out: { umbrella: string; merged: readonly string[] }[] = [];
    for (const cluster of clusters) {
      const umbrella = await merge(cluster.map((s) => ({ body: s.body, description: s.description, name: s.name })));
      if (!umbrella) continue; // cluster didn't cohere — leave the skills alone
      if (options.dryRun) {
        out.push({ merged: cluster.map((s) => s.name), umbrella: umbrella.name });
        continue;
      }
      // Archive originals FIRST so the subsequent umbrella write can't
      // similarity-match (and accidentally patch) one of them.
      for (const s of cluster) await this.archiveSkill(s);
      const { skill } = await this.writeOrPatch(umbrella);
      out.push({ merged: cluster.map((s) => s.name), umbrella: skill.name });
    }
    return out;
  }

  private clusterBySimilarity(skills: readonly Skill[], threshold: number): readonly (readonly Skill[])[] {
    const clustered = new Set<string>();
    const clusters: Skill[][] = [];
    for (const seed of skills) {
      if (clustered.has(seed.name)) continue;
      const cluster = [seed];
      clustered.add(seed.name);
      for (const other of skills) {
        if (clustered.has(other.name)) continue;
        if (this.similarity(`${seed.name} ${seed.description}`, `${other.name} ${other.description}`) >= threshold) {
          cluster.push(other);
          clustered.add(other.name);
        }
      }
      clusters.push(cluster);
    }
    return clusters;
  }

  /** Archived skill folder names (under `.archive/`) — what `restore` can revive. */
  async listArchived(): Promise<readonly string[]> {
    return fs.readdir(join(this.dir, ".archive")).catch(() => [] as string[]);
  }

  /**
   * Restore an archived skill (curate/consolidate rollback): move
   * `.archive/<slug>` back to active. Refuses if a live skill already occupies
   * the slot (returns false) — never clobbers. Returns true on success.
   */
  async restore(name: string): Promise<boolean> {
    const slug = slugifySkillName(name);
    const src = join(this.dir, ".archive", slug);
    const dest = join(this.dir, slug);
    try {
      await fs.access(dest);
      return false; // a live skill already holds this slot
    } catch {
      // slot free — proceed
    }
    return fs.rename(src, dest).then(() => true).catch(() => false);
  }

  private authoredAt(skill: Skill): number {
    const muse = (skill.frontmatter.metadata?.["muse"] ?? {}) as Record<string, unknown>;
    const raw = muse["authoredAt"];
    const at = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
    return Number.isFinite(at) ? at : 0;
  }

  private lastActiveAt(skill: Skill): number {
    const muse = (skill.frontmatter.metadata?.["muse"] ?? {}) as Record<string, unknown>;
    const raw = muse["lastUsedAt"];
    const used = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
    return Number.isFinite(used) ? used : this.authoredAt(skill);
  }

  private async archiveSkill(skill: Skill): Promise<boolean> {
    const folder = skill.sourceInfo.baseDir;
    const base = folder.split(/[\\/]/u).pop() ?? "skill";
    const dest = join(this.dir, ".archive", base);
    await fs.mkdir(dirname(dest), { recursive: true });
    return fs.rename(folder, dest).then(() => true).catch(() => false); // never delete
  }

  private async enforceCap(): Promise<void> {
    const skills = await this.listAuthored();
    if (skills.length <= this.maxSkills) return;
    const ordered = [...skills].sort((a, b) => this.authoredAt(a) - this.authoredAt(b)); // oldest first
    for (const s of ordered.slice(0, ordered.length - this.maxSkills)) await this.archiveSkill(s);
  }

  private dedupeName(name: string): string {
    const taken = new Set(this.existingNames());
    if (!taken.has(name)) return name;
    for (let n = 1; ; n += 1) {
      const candidate = n === 1 ? `${name}-learned` : `${name}-learned-${n.toString()}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  private async reload(name: string): Promise<Skill> {
    const all = await this.listAuthored();
    const found = all.find((s) => s.name === name);
    if (!found) throw new Error(`authored skill vanished after write: ${name}`);
    return found;
  }
}
