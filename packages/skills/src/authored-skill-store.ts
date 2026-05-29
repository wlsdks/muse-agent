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
import type { Skill } from "./skill-contract.js";

export interface SkillDraft {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

export type AuthorAction = "create" | "patch" | "skip";

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

  async writeOrPatch(draft: SkillDraft): Promise<{ action: AuthorAction; skill: Skill }> {
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

  private authoredAt(skill: Skill): number {
    const muse = (skill.frontmatter.metadata?.["muse"] ?? {}) as Record<string, unknown>;
    const raw = muse["authoredAt"];
    const at = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
    return Number.isFinite(at) ? at : 0;
  }

  private async enforceCap(): Promise<void> {
    const skills = await this.listAuthored();
    if (skills.length <= this.maxSkills) return;
    const ordered = [...skills].sort((a, b) => this.authoredAt(a) - this.authoredAt(b)); // oldest first
    const overflow = ordered.slice(0, ordered.length - this.maxSkills);
    for (const s of overflow) {
      const folder = s.sourceInfo.baseDir;
      const base = folder.split(/[\\/]/u).pop() ?? "skill";
      const dest = join(this.dir, ".archive", base);
      await fs.mkdir(dirname(dest), { recursive: true });
      await fs.rename(folder, dest).catch(() => undefined); // never delete
    }
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
