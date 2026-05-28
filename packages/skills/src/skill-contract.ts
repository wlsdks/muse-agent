/**
 * Skill contract — Muse-side mirror of the OpenClaw / Anthropic
 * SKILL.md format. We keep the same field names so authors can
 * lift a SKILL.md straight from one ecosystem to the other.
 */

export interface SkillRequires {
  /** Required CLI binaries (e.g. ["gh"]). All must be on PATH. */
  readonly bins?: readonly string[];
  /**
   * "Any of these binaries" — at least one must be on PATH.
   * Useful when the skill works against multiple CLIs (e.g.
   * Codex OR Claude Code).
   */
  readonly anyBins?: readonly string[];
  /** Config keys that must be set for the skill to activate. */
  readonly config?: readonly string[];
}

export interface SkillInstallStep {
  readonly id: string;
  /** "brew" | "apt" | "node" | "manual" | future kinds. */
  readonly kind: string;
  readonly label: string;
  readonly formula?: string;
  readonly package?: string;
  readonly bins?: readonly string[];
}

export interface SkillFrontmatter {
  readonly name: string;
  readonly description: string;
  readonly emoji?: string;
  readonly homepage?: string;
  readonly requires?: SkillRequires;
  readonly install?: readonly SkillInstallStep[];
  /**
   * Extra metadata block — anything under
   * `metadata.<vendor>` survives parsing as a JSON object so
   * downstream tooling can read it. Muse honours the
   * `metadata.openclaw` keys (compat) and its own `metadata.muse`
   * keys identically.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type SkillSource = "user" | "workspace" | "bundled" | "remote" | "authored";

export interface SkillSourceInfo {
  readonly source: SkillSource;
  /** Absolute path of the SKILL.md file the skill was parsed from. */
  readonly filePath: string;
  /** Base directory (= dirname of filePath). */
  readonly baseDir: string;
}

export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly frontmatter: SkillFrontmatter;
  /** Full markdown body (everything below the closing `---`). */
  readonly body: string;
  readonly sourceInfo: SkillSourceInfo;
}
