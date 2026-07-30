import type { AttuneGraphStore } from "./attunegraph-contracts.js";
import type { AttuneGraphStoreBackend } from "./attunegraph-backend.js";

const registry = new WeakMap<AttuneGraphStore, AttuneGraphStoreBackend>();

export function registerAttuneGraphStore(store: AttuneGraphStore, backend: AttuneGraphStoreBackend): void {
  registry.set(store, backend);
}

/** Engine-only capability lookup. This module is deliberately not package-exported. */
export function registeredAttuneGraphStoreBackend(store: AttuneGraphStore): AttuneGraphStoreBackend | undefined {
  return registry.get(store);
}
