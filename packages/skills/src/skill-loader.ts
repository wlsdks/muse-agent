/**
 * Filesystem skill loader — walks a list of root directories,
 * picks up every immediate sub-directory's SKILL.md, parses it,
 * dedupes by name with a "later root wins" override semantics so
 * workspace skills can shadow user-global skills.
 *
 * Stays fail-open: a single malformed SKILL.md logs (via injected
 * logger) and is skipped — the loader never throws over a bad
 * skill file because that would block every other skill.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

import { parseSkillFile, SkillParseError } from "./skill-parser.js";
import type { Skill, SkillSource } from "./skill-contract.js";

export interface SkillRootOption {
  readonly path: string;
  readonly source: SkillSource;
}

export interface FileSystemSkillLoaderOptions {
  readonly roots: readonly SkillRootOption[];
  readonly logger?: (message: string, error?: unknown) => void;
}

export class FileSystemSkillLoader {
  private readonly roots: readonly SkillRootOption[];
  private readonly logger: (message: string, error?: unknown) => void;

  constructor(options: FileSystemSkillLoaderOptions) {
    this.roots = options.roots;
    this.logger = options.logger ?? (() => undefined);
  }

  async loadAll(): Promise<readonly Skill[]> {
    const byName = new Map<string, Skill>();
    for (const root of this.roots) {
      const skills = await loadSkillsFromDirectory(root.path, root.source, this.logger);
      for (const skill of skills) {
        // Later root wins — caller passes roots in low → high precedence order.
        byName.set(skill.name, skill);
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}

/**
 * Read one root directory. Each immediate sub-directory is treated
 * as a skill folder; `SKILL.md` inside is the skill manifest. Other
 * files in the folder (assets, scripts) are ignored by the loader
 * but accessible to skills at runtime via `sourceInfo.baseDir`.
 */
export async function loadSkillsFromDirectory(
  root: string,
  source: SkillSource,
  logger: (message: string, error?: unknown) => void = () => undefined
): Promise<readonly Skill[]> {
  let entries: readonly string[];
  try {
    const direntList = await fs.readdir(root, { withFileTypes: true });
    entries = direntList.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
  const out: Skill[] = [];
  for (const entry of entries) {
    const skillPath = join(root, entry, "SKILL.md");
    try {
      const stat = await fs.stat(skillPath).catch(() => undefined);
      if (!stat || !stat.isFile()) {
        continue;
      }
      out.push(await parseSkillFile(skillPath, { source }));
    } catch (error) {
      if (error instanceof SkillParseError) {
        const failedPath: string = error.filePath ?? skillPath;
        logger("skipping malformed skill: " + failedPath, error);
      } else {
        logger("failed to load skill at " + skillPath, error);
      }
    }
  }
  return out;
}
