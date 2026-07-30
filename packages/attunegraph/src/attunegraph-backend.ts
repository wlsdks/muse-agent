import type {
  AttuneGraphScope,
  AttuneGraphSnapshot,
  AttuneGraphSourceFreshness,
  AttuneGraphStore
} from "./attunegraph-contracts.js";
import type { GraphAssertion } from "./types.js";
import { types as nodeTypes } from "node:util";
import { registerAttuneGraphStore } from "./attunegraph-store-internal.js";

export interface AttuneGraphStoredProjection {
  readonly schemaVersion: 1;
  readonly snapshot: AttuneGraphSnapshot;
  readonly observationId: string;
  /** Exact canonical JSON of the admitted canonical-projection@1 envelope. */
  readonly canonicalProjection: string;
  /** Content-addressed identifier derived from canonicalProjection. */
  readonly projectionFingerprint: string;
  readonly observedAt: string;
  readonly sourceFreshness: AttuneGraphSourceFreshness;
  readonly assertions: readonly GraphAssertion[];
}

/**
 * Expert Store Adapter seam. The adapter owns atomic compare-and-swap; AttuneGraph Engine
 * owns scope, command, and projection semantics.
 */
export interface AttuneGraphStoreBackend {
  read(scope: AttuneGraphScope): Promise<AttuneGraphStoredProjection | undefined>;
  compareAndSwap(
    scope: AttuneGraphScope,
    expected: AttuneGraphSnapshot | undefined,
    proposed: AttuneGraphStoredProjection
  ): Promise<boolean>;
}

function backendMethod<T extends keyof AttuneGraphStoreBackend>(
  backend: AttuneGraphStoreBackend,
  name: T
): AttuneGraphStoreBackend[T] {
  if (backend === null || typeof backend !== "object" || nodeTypes.isProxy(backend)) {
    throw new TypeError("AttuneGraph Store Adapter must be a non-proxy object");
  }
  let cursor: object | null = backend;
  while (cursor !== null) {
    if (nodeTypes.isProxy(cursor)) throw new TypeError("AttuneGraph Store Adapter prototype must not be a proxy");
    const descriptor = Object.getOwnPropertyDescriptor(cursor, name);
    if (descriptor) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") {
        throw new TypeError(`AttuneGraph Store Adapter ${name} must be a data method`);
      }
      return descriptor.value.bind(backend) as AttuneGraphStoreBackend[T];
    }
    cursor = Object.getPrototypeOf(cursor);
  }
  throw new TypeError(`AttuneGraph Store Adapter is missing ${name}`);
}

/** Creates the opaque root capability from a Store Adapter implementation. */
export function createAttuneGraphStore(backend: AttuneGraphStoreBackend): AttuneGraphStore {
  const safeBackend: AttuneGraphStoreBackend = Object.freeze({
    compareAndSwap: backendMethod(backend, "compareAndSwap"),
    read: backendMethod(backend, "read")
  });
  const capability = Object.freeze(Object.create(null)) as AttuneGraphStore;
  registerAttuneGraphStore(capability, safeBackend);
  return capability;
}
