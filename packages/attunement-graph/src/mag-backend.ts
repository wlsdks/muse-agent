import type {
  MagScope,
  MagSnapshot,
  MagSourceFreshness,
  MagStore
} from "./mag-contracts.js";
import type { GraphAssertion } from "./types.js";
import { types as nodeTypes } from "node:util";
import { registerMagStore } from "./mag-store-internal.js";

export interface MagStoredProjection {
  readonly schemaVersion: 1;
  readonly snapshot: MagSnapshot;
  readonly observationId: string;
  /** Exact canonical JSON of the admitted canonical-projection@1 envelope. */
  readonly canonicalProjection: string;
  /** Content-addressed identifier derived from canonicalProjection. */
  readonly projectionFingerprint: string;
  readonly observedAt: string;
  readonly sourceFreshness: MagSourceFreshness;
  readonly assertions: readonly GraphAssertion[];
}

/**
 * Expert Store Adapter seam. The adapter owns atomic compare-and-swap; MAG Engine
 * owns scope, command, and projection semantics.
 */
export interface MagStoreBackend {
  read(scope: MagScope): Promise<MagStoredProjection | undefined>;
  compareAndSwap(
    scope: MagScope,
    expected: MagSnapshot | undefined,
    proposed: MagStoredProjection
  ): Promise<boolean>;
}

function backendMethod<T extends keyof MagStoreBackend>(
  backend: MagStoreBackend,
  name: T
): MagStoreBackend[T] {
  if (backend === null || typeof backend !== "object" || nodeTypes.isProxy(backend)) {
    throw new TypeError("MAG Store Adapter must be a non-proxy object");
  }
  let cursor: object | null = backend;
  while (cursor !== null) {
    if (nodeTypes.isProxy(cursor)) throw new TypeError("MAG Store Adapter prototype must not be a proxy");
    const descriptor = Object.getOwnPropertyDescriptor(cursor, name);
    if (descriptor) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") {
        throw new TypeError(`MAG Store Adapter ${name} must be a data method`);
      }
      return descriptor.value.bind(backend) as MagStoreBackend[T];
    }
    cursor = Object.getPrototypeOf(cursor);
  }
  throw new TypeError(`MAG Store Adapter is missing ${name}`);
}

/** Creates the opaque root capability from a Store Adapter implementation. */
export function createMagStore(backend: MagStoreBackend): MagStore {
  const safeBackend: MagStoreBackend = Object.freeze({
    compareAndSwap: backendMethod(backend, "compareAndSwap"),
    read: backendMethod(backend, "read")
  });
  const capability = Object.freeze(Object.create(null)) as MagStore;
  registerMagStore(capability, safeBackend);
  return capability;
}
