import { createMagStore, type MagStoreBackend, type MagStoredProjection } from "./mag-backend.js";
import type { MagScope, MagSnapshot, MagStore } from "./mag-contracts.js";

function scopeKey(scope: MagScope): string {
  return JSON.stringify([scope.sourceId, scope.threadId]);
}

function sameSnapshot(
  left: MagSnapshot | undefined,
  right: MagSnapshot | undefined
): boolean {
  return left?.generation === right?.generation
    && left?.commitId === right?.commitId
    && left?.scope.sourceId === right?.scope.sourceId
    && left?.scope.threadId === right?.scope.threadId;
}

/** Process-local semantic oracle. It is exported from ./testing, never selected by default. */
export class InMemoryMagStoreBackend implements MagStoreBackend {
  private readonly projections = new Map<string, MagStoredProjection>();

  async read(scope: MagScope): Promise<MagStoredProjection | undefined> {
    const stored = this.projections.get(scopeKey(scope));
    return stored === undefined
      ? undefined
      : JSON.parse(JSON.stringify(stored)) as MagStoredProjection;
  }

  async compareAndSwap(
    scope: MagScope,
    expected: MagSnapshot | undefined,
    proposed: MagStoredProjection
  ): Promise<boolean> {
    const key = scopeKey(scope);
    const current = this.projections.get(key);
    if (!sameSnapshot(current?.snapshot, expected)) return false;
    this.projections.set(key, JSON.parse(JSON.stringify(proposed)) as MagStoredProjection);
    return true;
  }
}

export function createInMemoryMagStore(): MagStore {
  return createMagStore(new InMemoryMagStoreBackend());
}
