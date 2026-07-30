import { createAttuneGraphStore, type AttuneGraphStoreBackend, type AttuneGraphStoredProjection } from "./attunegraph-backend.js";
import type { AttuneGraphScope, AttuneGraphSnapshot, AttuneGraphStore } from "./attunegraph-contracts.js";

function scopeKey(scope: AttuneGraphScope): string {
  return JSON.stringify([scope.sourceId, scope.threadId]);
}

function sameSnapshot(
  left: AttuneGraphSnapshot | undefined,
  right: AttuneGraphSnapshot | undefined
): boolean {
  return left?.generation === right?.generation
    && left?.commitId === right?.commitId
    && left?.scope.sourceId === right?.scope.sourceId
    && left?.scope.threadId === right?.scope.threadId;
}

/** Process-local semantic oracle. It is exported from ./testing, never selected by default. */
export class InMemoryAttuneGraphStoreBackend implements AttuneGraphStoreBackend {
  private readonly projections = new Map<string, AttuneGraphStoredProjection>();

  async read(scope: AttuneGraphScope): Promise<AttuneGraphStoredProjection | undefined> {
    const stored = this.projections.get(scopeKey(scope));
    return stored === undefined
      ? undefined
      : JSON.parse(JSON.stringify(stored)) as AttuneGraphStoredProjection;
  }

  async compareAndSwap(
    scope: AttuneGraphScope,
    expected: AttuneGraphSnapshot | undefined,
    proposed: AttuneGraphStoredProjection
  ): Promise<boolean> {
    const key = scopeKey(scope);
    const current = this.projections.get(key);
    if (!sameSnapshot(current?.snapshot, expected)) return false;
    this.projections.set(key, JSON.parse(JSON.stringify(proposed)) as AttuneGraphStoredProjection);
    return true;
  }
}

export function createInMemoryAttuneGraphStore(): AttuneGraphStore {
  return createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend());
}
