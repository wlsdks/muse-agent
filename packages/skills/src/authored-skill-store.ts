/**
 * Agent-authored skill persistence. Skills Muse writes about ITSELF
 * (from session-end review) live here, separate from human-authored
 * user/workspace skills. Execute-gated by type: a SkillDraft carries
 * only name/description/body, so an authored skill can never declare
 * requires.bins — muse.skills.run therefore refuses to execute it
 * until a human promotes it. Durability mirrors the plan-cache store
 * (atomic fsync+rename, 0600).
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import { withFileLock, withFileMutationQueue } from "@muse/shared";

import { FileSystemSkillLoader } from "./skill-loader.js";
import { parseSkillFile } from "./skill-parser.js";
import type { Skill } from "./skill-contract.js";
import {
  defaultSimilarity,
  rankSkillsForEviction,
  referencedByScheduledJob,
  scanSkillBodyForRisks,
  serializeAuthoredSkill,
  skillBodyIsSubsumed,
  slugifySkillName,
  stripTimestamps,
  type SkillDraft,
  type SkillReferencingJob,
  type SkillSnapshot,
  type SkillSnapshotEntry
} from "./skill-analysis.js";

export {
  DEFAULT_SKILL_SUBSUMPTION_CONTAINMENT,
  rankSkillsForEviction,
  referencedByScheduledJob,
  scanSkillBodyForRisks,
  serializeAuthoredSkill,
  skillBodyIsSubsumed,
  slugifySkillName,
  type SkillDraft,
  type SkillEvictionEntry,
  type SkillReferencingJob,
  type SkillRiskScan,
  type SkillSnapshot,
  type SkillSnapshotEntry
} from "./skill-analysis.js";

export type AuthorAction = "create" | "patch" | "skip" | "quarantined";

export interface AuthoredSkillStoreOptions {
  readonly dir: string;
  readonly maxSkills?: number;
  /** Non-authored skill names, best-effort, for collision suffixing. */
  readonly existingNames?: () => readonly string[];
  readonly now?: () => Date;
  /** 0..1 similarity used for create-vs-patch. Default: local Jaccard. */
  readonly similarity?: (a: string, b: string) => number;
  /** Pre-mutation snapshot ring size (see {@link DEFAULT_SKILL_SNAPSHOT_RING_SIZE}). */
  readonly snapshotRingSize?: number;
}

export const DEFAULT_MAX_AUTHORED_SKILLS = 30;
const PATCH_SIMILARITY_THRESHOLD = 0.6;

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

/**
 * Snapshot ring size: how many pre-mutation snapshots are kept before the
 * oldest is pruned. 5 mirrors Hermes Agent curator_backup's `DEFAULT_KEEP`
 * — enough undo history to cover several curate/consolidate ticks (this
 * store already ticks at most a few times a day) without unbounded disk
 * growth from a snapshot format that stores full skill content per entry.
 */
export const DEFAULT_SKILL_SNAPSHOT_RING_SIZE = 5;

export class AuthoredSkillStore {
  private readonly dir: string;
  private readonly maxSkills: number;
  private readonly existingNames: () => readonly string[];
  private readonly now: () => Date;
  private readonly similarity: (a: string, b: string) => number;
  private readonly snapshotRingSize: number;

  constructor(options: AuthoredSkillStoreOptions) {
    this.dir = options.dir;
    this.maxSkills = options.maxSkills ?? DEFAULT_MAX_AUTHORED_SKILLS;
    this.existingNames = options.existingNames ?? (() => []);
    this.now = options.now ?? (() => new Date());
    this.similarity = options.similarity ?? defaultSimilarity;
    this.snapshotRingSize = options.snapshotRingSize ?? DEFAULT_SKILL_SNAPSHOT_RING_SIZE;
  }

  async listAuthored(): Promise<readonly Skill[]> {
    return new FileSystemSkillLoader({ roots: [{ path: this.dir, source: "authored" }] }).loadAll();
  }

  async writeOrPatch(draft: SkillDraft): Promise<{ action: AuthorAction; skill: Skill; reasons?: readonly string[] }> {
    return this.serializeMutation(() => this.writeOrPatchUnlocked(draft));
  }

  private async writeOrPatchUnlocked(draft: SkillDraft): Promise<{ action: AuthorAction; skill: Skill; reasons?: readonly string[] }> {
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
    // Write-time SUBSUMPTION dedup (Voyager skill-library novelty gate,
    // arXiv:2305.16291): the name/description match above is symmetric Jaccard and
    // never inspects the BODY, so a draft with a fresh name whose PROCEDURE is a
    // subset of an existing skill would author a near-duplicate (the curator only
    // cleans that up later at idle cost). If an existing authored skill already
    // covers this draft's body, skip the redundant write.
    const subsumer = authored.find((s) => skillBodyIsSubsumed(draft.body, s.body));
    if (subsumer) {
      return { action: "skip", skill: subsumer };
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
    return this.serializeMutation(() => this.recordUsageUnlocked(name));
  }

  private async recordUsageUnlocked(name: string): Promise<boolean> {
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
   * `options.scheduledJobs` exempts a skill still named by a scheduled job /
   * standing objective (enabled or disabled) from idle pruning even at zero uses
   * (see {@link referencedByScheduledJob}) — mirrors treating a cron-
   * referenced skill like a pinned one. Before archiving, a snapshot of
   * every about-to-be-touched skill's content is taken (see
   * {@link SkillSnapshot}) so a bad batch can be undone with `rollback()`.
   *
   * Pattern adapted from Hermes Agent's curator lifecycle — last_used_at
   * feeding stale → auto-archive transitions, cron-reference exemption, and
   * pre-mutation snapshotting (MIT) — reimplemented for Muse.
   */
  async curate(
    maxIdleDays: number,
    options: { readonly scheduledJobs?: readonly SkillReferencingJob[] } = {}
  ): Promise<readonly string[]> {
    return this.serializeMutation(() => this.curateUnlocked(maxIdleDays, options));
  }

  private async curateUnlocked(
    maxIdleDays: number,
    options: { readonly scheduledJobs?: readonly SkillReferencingJob[] }
  ): Promise<readonly string[]> {
    if (!(maxIdleDays > 0)) return [];
    const cutoff = this.now().getTime() - maxIdleDays * 24 * 60 * 60 * 1000;
    const jobs = options.scheduledJobs ?? [];
    const candidates = (await this.listAuthored()).filter(
      (s) => this.lastActiveAt(s) < cutoff && !referencedByScheduledJob(s, jobs)
    );
    if (candidates.length > 0) await this.snapshotSkills(candidates);
    const archived: string[] = [];
    for (const s of candidates) {
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
    merge: (
      cluster: readonly SkillDraft[],
      feedback?: { readonly avoidDropping: readonly string[] }
    ) => Promise<SkillDraft | undefined>,
    options: {
      readonly threshold?: number;
      readonly minClusterSize?: number;
      readonly dryRun?: boolean;
      /**
       * Held-out validation gate (SkillOpt propose-and-test): after the merger
       * proposes an umbrella, accept the merge ONLY when this returns true /
       * `{accept:true}`. Return `{accept, lost}` to also feed the dropped-skill
       * labels into a steered retry (see `feedbackRetry`). A rejected umbrella is
       * dropped and the originals are left intact (rollback) — never
       * archived/overwritten. Injected so this package stays model-free; the
       * caller wires `validateUmbrellaCoverage`. Omitted ⇒ no gate (back-compat).
       */
      readonly validate?: (
        cluster: readonly SkillDraft[],
        umbrella: SkillDraft
      ) =>
        | boolean
        | { readonly accept: boolean; readonly lost?: readonly string[] }
        | Promise<boolean | { readonly accept: boolean; readonly lost?: readonly string[] }>;
      /**
       * SkillOpt rejected-edit loop: when the gate rejects a merge AND the
       * verdict reports the dropped skills (`lost`), re-propose ONCE with that
       * feedback before giving up — so a fixable umbrella converges instead of
       * being recomputed identically next tick. Default false (one attempt).
       */
      readonly feedbackRetry?: boolean;
      /**
       * Self-consistency sampling: propose the umbrella up to `attempts` times and
       * commit the FIRST that passes `validate`, steering each retry away from the
       * gate-reported `lost` skills. Raises the merge-success rate on a stochastic
       * local model (gemma4) where a single try sometimes under-covers — without
       * weakening the gate (a non-covering umbrella is still rejected every time).
       * Default 1 (or 2 when `feedbackRetry` is set, for back-compat).
       */
      readonly attempts?: number;
      /**
       * Cross-tick reject COOLDOWN (injected so this package stays IO-free): a
       * cluster the gate keeps rejecting shouldn't be recomputed (a local-LLM
       * merge + embeds) every idle tick forever. `shouldSkipCluster` is consulted
       * BEFORE proposing — skip when it returns true; `recordReject` bumps the
       * cluster's count on a real held-out reject (NOT on a no-cohere/NONE);
       * `recordMerged` clears it on commit. The caller wires a fingerprint→count
       * ledger (fingerprint over name+content, so editing a member re-opens it).
       * Omitted ⇒ no cooldown (back-compat).
       */
      readonly shouldSkipCluster?: (cluster: readonly SkillDraft[]) => boolean | Promise<boolean>;
      readonly recordReject?: (cluster: readonly SkillDraft[]) => void | Promise<void>;
      readonly recordMerged?: (cluster: readonly SkillDraft[]) => void | Promise<void>;
    } = {}
  ): Promise<readonly { readonly umbrella: string; readonly merged: readonly string[] }[]> {
    return this.serializeMutation(() => this.consolidateUnlocked(merge, options));
  }

  private async consolidateUnlocked(
    merge: (
      cluster: readonly SkillDraft[],
      feedback?: { readonly avoidDropping: readonly string[] }
    ) => Promise<SkillDraft | undefined>,
    options: {
      readonly threshold?: number;
      readonly minClusterSize?: number;
      readonly dryRun?: boolean;
      readonly validate?: (
        cluster: readonly SkillDraft[],
        umbrella: SkillDraft
      ) =>
        | boolean
        | { readonly accept: boolean; readonly lost?: readonly string[] }
        | Promise<boolean | { readonly accept: boolean; readonly lost?: readonly string[] }>;
      readonly feedbackRetry?: boolean;
      readonly attempts?: number;
      readonly shouldSkipCluster?: (cluster: readonly SkillDraft[]) => boolean | Promise<boolean>;
      readonly recordReject?: (cluster: readonly SkillDraft[]) => void | Promise<void>;
      readonly recordMerged?: (cluster: readonly SkillDraft[]) => void | Promise<void>;
    }
  ): Promise<readonly { readonly umbrella: string; readonly merged: readonly string[] }[]> {
    const threshold = typeof options.threshold === "number" && options.threshold > 0 ? options.threshold : 0.5;
    const minSize = Math.max(2, Math.trunc(options.minClusterSize ?? 2));
    const skills = await this.listAuthored();
    const clusters = this.clusterBySimilarity(skills, threshold).filter((c) => c.length >= minSize);
    const out: { umbrella: string; merged: readonly string[] }[] = [];
    for (const cluster of clusters) {
      const drafts = cluster.map((s) => ({ body: s.body, description: s.description, name: s.name }));
      // Cooldown: a cluster that has been rejected too many times is skipped
      // BEFORE the costly merge call, until a member's content changes.
      if (options.shouldSkipCluster && (await options.shouldSkipCluster(drafts))) continue;
      // Self-consistency: a small local model (gemma4) sometimes produces a
      // non-covering umbrella on a single try, so sample up to `attempts` times
      // and accept the FIRST that passes the held-out coverage gate (a later
      // attempt steers away from the previously-dropped skills when the gate
      // reports them). `feedbackRetry` stays as the back-compat one-retry alias.
      const attempts = Math.max(1, Math.trunc(options.attempts ?? (options.feedbackRetry ? 2 : 1)));
      let umbrella: SkillDraft | undefined;
      let accepted = !options.validate; // no gate ⇒ first cohere wins
      let lost: readonly string[] = [];
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const candidate = await merge(drafts, lost.length > 0 ? { avoidDropping: lost } : undefined);
        if (!candidate) break; // cluster didn't cohere — leave the skills alone (no reject)
        umbrella = candidate;
        if (!options.validate) break;
        const verdict = await options.validate(drafts, candidate);
        accepted = typeof verdict === "boolean" ? verdict : verdict.accept;
        lost = typeof verdict === "boolean" ? [] : (verdict.lost ?? []);
        if (accepted) break;
      }
      if (!umbrella) continue; // never cohered — no reject recorded
      if (!accepted) {
        await options.recordReject?.(drafts); // held-out reject → count toward cooldown
        continue; // roll back: originals intact
      }
      if (options.dryRun) {
        out.push({ merged: cluster.map((s) => s.name), umbrella: umbrella.name });
        continue;
      }
      // Snapshot the cluster's current content BEFORE this cluster's mutating
      // pass so a bad merge can be undone with rollback().
      await this.snapshotSkills(cluster);
      // Archive originals FIRST so the subsequent umbrella write can't
      // similarity-match (and accidentally patch) one of them.
      for (const s of cluster) await this.archiveSkill(s);
      const { skill } = await this.writeOrPatchUnlocked(umbrella);
      await options.recordMerged?.(drafts); // merged → clear any cooldown entry
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
    return this.serializeMutation(() => this.restoreUnlocked(name));
  }

  private async restoreUnlocked(name: string): Promise<boolean> {
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

  /** Pre-mutation snapshots, newest last — what `rollback()` can restore. */
  async listSnapshots(): Promise<readonly SkillSnapshot[]> {
    const files = await fs.readdir(this.snapshotsDir()).catch(() => [] as string[]);
    const out: SkillSnapshot[] = [];
    for (const file of files.filter((f) => f.endsWith(".json")).sort()) {
      const raw = await fs.readFile(join(this.snapshotsDir(), file), "utf8").catch(() => undefined);
      if (raw === undefined) continue;
      try {
        out.push(JSON.parse(raw) as SkillSnapshot);
      } catch {
        // corrupt/partial snapshot file — skip, don't fail the whole list
      }
    }
    return out;
  }

  /**
   * Roll a batch back: restore every skill recorded in a snapshot (default:
   * the most recent) to its snapshotted content. Never-delete preserved — a
   * skill that was newly authored/edited into the same slot AFTER the
   * snapshot was taken is preserved by archiving it (under a distinct
   * `<slug>-postsnapshot-<ts>` folder) instead of being overwritten or
   * removed. Throws if no snapshot exists (or a given `snapshotId` isn't
   * found) — there's nothing safe to roll back to.
   */
  async rollback(snapshotId?: string): Promise<{
    readonly snapshotId: string;
    readonly restored: readonly string[];
    readonly archivedConflicts: readonly string[];
  }> {
    return this.serializeMutation(() => this.rollbackUnlocked(snapshotId));
  }

  private async rollbackUnlocked(snapshotId?: string): Promise<{
    readonly snapshotId: string;
    readonly restored: readonly string[];
    readonly archivedConflicts: readonly string[];
  }> {
    const snapshots = await this.listSnapshots();
    const snapshot = snapshotId ? snapshots.find((s) => s.id === snapshotId) : snapshots.at(-1);
    if (!snapshot) {
      throw new Error(
        snapshotId ? `snapshot not found: ${snapshotId}` : "no snapshots available to roll back to"
      );
    }
    const restored: string[] = [];
    const archivedConflicts: string[] = [];
    for (const entry of snapshot.entries) {
      const conflict = await this.restoreSnapshotEntry(entry);
      restored.push(entry.name);
      if (conflict) archivedConflicts.push(entry.name);
    }
    return { archivedConflicts, restored, snapshotId: snapshot.id };
  }

  private snapshotsDir(): string {
    return join(this.dir, ".snapshots");
  }

  /** Serialize every state-changing operation across local and sibling Muse processes. */
  private async serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const mutationFile = join(this.dir, ".authored-skill-store");
    return withFileMutationQueue(mutationFile, () => withFileLock(mutationFile, operation));
  }

  /**
   * Write a pre-mutation snapshot for `skills` (the set about to be
   * archived/merged) and prune the ring down to `snapshotRingSize`. A JSON
   * manifest per skill (name/slug/contentHash/full content) is sufficient in
   * Node — no tar needed, matching the file-based house style already used
   * for skill storage. No-op (writes nothing) when `skills` is empty, so an
   * idle curate/consolidate tick that finds nothing to touch doesn't churn
   * the ring.
   */
  private async snapshotSkills(skills: readonly Skill[]): Promise<string | undefined> {
    if (skills.length === 0) return undefined;
    const entries: SkillSnapshotEntry[] = [];
    for (const skill of skills) {
      const content = await fs.readFile(skill.sourceInfo.filePath, "utf8").catch(() => "");
      entries.push({
        content,
        contentHash: createHash("sha256").update(content).digest("hex"),
        name: skill.name,
        slug: slugifySkillName(skill.name)
      });
    }
    const id = `${this.now().toISOString().replace(/[:.]/gu, "-")}-${Math.random().toString(36).slice(2, 8)}`;
    const snapshot: SkillSnapshot = { createdAt: this.now().toISOString(), entries, id };
    await writeFileAtomic(join(this.snapshotsDir(), `${id}.json`), JSON.stringify(snapshot));
    await this.pruneSnapshots();
    return id;
  }

  private async pruneSnapshots(): Promise<void> {
    const files = (await fs.readdir(this.snapshotsDir()).catch(() => [] as string[]))
      .filter((f) => f.endsWith(".json"))
      .sort();
    const excess = files.length - this.snapshotRingSize;
    if (excess <= 0) return;
    for (const file of files.slice(0, excess)) {
      await fs.unlink(join(this.snapshotsDir(), file)).catch(() => undefined);
    }
  }

  /**
   * Restore one snapshot entry to `<dir>/<slug>/SKILL.md`. Returns true when
   * a DIFFERENT skill occupying the slot (authored/edited after the
   * snapshot) had to be preserved by archiving it under a distinct name —
   * i.e. a conflict was resolved by archive-not-delete rather than a clean
   * restore.
   */
  private async restoreSnapshotEntry(entry: SkillSnapshotEntry): Promise<boolean> {
    const liveDir = join(this.dir, entry.slug);
    const liveFile = join(liveDir, "SKILL.md");
    const archiveDir = join(this.dir, ".archive", entry.slug);

    const currentContent = await fs.readFile(liveFile, "utf8").catch(() => undefined);
    let conflict = false;
    if (currentContent !== undefined && currentContent !== entry.content) {
      const preserveDir = join(this.dir, ".archive", `${entry.slug}-postsnapshot-${this.now().getTime().toString()}`);
      await fs.rename(liveDir, preserveDir).catch(() => undefined);
      conflict = true;
    } else if (currentContent === undefined) {
      // Not live — if curate/consolidate archived it, reclaim the folder so
      // rollback doesn't leave an orphaned duplicate under .archive.
      await fs.rename(archiveDir, liveDir).catch(() => undefined);
    }
    await writeFileAtomic(liveFile, entry.content);
    return conflict;
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

  private hasUsage(skill: Skill): boolean {
    const muse = (skill.frontmatter.metadata?.["muse"] ?? {}) as Record<string, unknown>;
    return typeof muse["lastUsedAt"] === "string" && (muse["lastUsedAt"] as string).length > 0;
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
    // Utility-aware eviction (SkillOps arXiv:2605.13716; value-aware cache
    // eviction, TinyLFU arXiv:1512.00727): evict the LOWEST-utility skills, not
    // merely the oldest-authored — a heavily-used skill must not be archived
    // before a never-used newer one. Degrades to FIFO when no usage data exists
    // (lastActiveAt falls back to authoredAt), so it is a strict superset.
    const order = rankSkillsForEviction(
      skills.map((s) => ({ name: s.name, used: this.hasUsage(s), lastActiveMs: this.lastActiveAt(s) }))
    );
    const evict = new Set(order.slice(0, skills.length - this.maxSkills));
    for (const s of skills) {
      if (evict.has(s.name)) await this.archiveSkill(s);
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
