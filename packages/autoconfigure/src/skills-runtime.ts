import {
  createSkillListTool,
  createSkillReadTool,
  createSkillRunTool,
  type MuseTool,
  type SkillRegistryView
} from "@muse/tools";
import type { SkillRegistry } from "@muse/skills";
import { recordSkillView } from "@muse/stores";

import { parseBoolean } from "./env-parsers.js";
import { buildSkillRegistry, resolveSkillUsageFile } from "./personal-providers.js";

import type { MuseEnvironment } from "./index.js";

export interface SkillRuntime {
  /**
   * Pending registry — the disk scan completes asynchronously. The
   * registry view backing `muse.skills.*` tools reads through a
   * cached snapshot, so until the promise resolves the tools see an
   * empty list. Forwarded to the runtime so
   * `buildSkillCatalogProvider` can compose the `[Available Skills]`
   * system-prompt section.
   */
  readonly skillRegistryPromise: Promise<SkillRegistry | undefined>;
  /**
   * `muse.skills.list / read / run` tools (empty array when
   * `MUSE_SKILLS_ENABLED=false`).
   */
  readonly skillTools: readonly MuseTool[];
}

/**
 * Build the SKILL.md registry + the three `muse.skills.*` tools.
 * The disk scan runs async via a Promise wrap so the surrounding
 * runtime assembly stays synchronous; tool calls read through a
 * lazily-populated cache.
 */
export function createSkillRuntime(env: MuseEnvironment): SkillRuntime {
  const skillRegistryPromise = buildSkillRegistry(env);
  // The disk scan is async, so the view awaits the SAME promise on every
  // call rather than reading a cache that may still be unset — an early
  // `list()`/`get()` used to silently see an empty registry and report a
  // populated skills directory as empty.
  const skillRegistryView: SkillRegistryView = {
    list: async () => {
      const registry = await skillRegistryPromise;
      if (!registry) return [];
      return registry.list().map((skill) => ({
        body: skill.body,
        description: skill.description,
        ...(skill.frontmatter.emoji ? { emoji: skill.frontmatter.emoji } : {}),
        name: skill.name,
        ...(skill.frontmatter.requires?.anyBins
          ? { requiresAnyBins: [...skill.frontmatter.requires.anyBins] }
          : {}),
        ...(skill.frontmatter.requires?.bins ? { requiresBins: [...skill.frontmatter.requires.bins] } : {})
      }));
    },
    get: async (name: string) => {
      const registry = await skillRegistryPromise;
      const skill = registry?.get(name);
      if (!skill) return undefined;
      return {
        body: skill.body,
        description: skill.description,
        ...(skill.frontmatter.emoji ? { emoji: skill.frontmatter.emoji } : {}),
        name: skill.name,
        ...(skill.frontmatter.requires?.anyBins
          ? { requiresAnyBins: [...skill.frontmatter.requires.anyBins] }
          : {}),
        ...(skill.frontmatter.requires?.bins ? { requiresBins: [...skill.frontmatter.requires.bins] } : {}),
        source: skill.sourceInfo.source
      };
    },
    onRead: async (skill) => {
      if (skill.source !== "authored") return;
      await recordSkillView(resolveSkillUsageFile(env), skill.name);
    }
  };

  const skillTools = parseBoolean(env.MUSE_SKILLS_ENABLED, true)
    ? [
        createSkillListTool(skillRegistryView),
        createSkillReadTool(skillRegistryView),
        createSkillRunTool(skillRegistryView)
      ]
    : [];

  return { skillRegistryPromise, skillTools };
}
