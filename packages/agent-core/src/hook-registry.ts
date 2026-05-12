import type { HookStage } from "./types.js";

export class HookRegistry {
  private readonly hooks = new Map<string, HookStage>();

  constructor(hooks: Iterable<HookStage> = []) {
    for (const hook of hooks) {
      this.register(hook);
    }
  }

  register(hook: HookStage): void {
    this.hooks.set(hook.id, hook);
  }

  unregister(id: string): boolean {
    return this.hooks.delete(id);
  }

  list(): readonly HookStage[] {
    return [...this.hooks.values()];
  }
}
