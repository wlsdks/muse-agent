/**
 * In-memory skill registry — small lookup surface used by the
 * runtime and by `muse.skills.read` / `muse.skills.run` tools.
 * Stateless beyond the initial `register` calls; the autoconfigure
 * layer rebuilds it on startup from the on-disk loader.
 */

import type { Skill } from "./skill-contract.js";

export interface SkillRegistry {
  list(): readonly Skill[];
  get(name: string): Skill | undefined;
}

export class InMemorySkillRegistry implements SkillRegistry {
  private readonly skills = new Map<string, Skill>();

  constructor(skills: Iterable<Skill> = []) {
    for (const skill of skills) {
      this.register(skill);
    }
  }

  register(skill: Skill): void {
    this.skills.set(skill.name, skill);
  }

  unregister(name: string): boolean {
    return this.skills.delete(name);
  }

  list(): readonly Skill[] {
    return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }
}
