import type { MagStore } from "./mag-contracts.js";
import type { MagStoreBackend } from "./mag-backend.js";

const registry = new WeakMap<MagStore, MagStoreBackend>();

export function registerMagStore(store: MagStore, backend: MagStoreBackend): void {
  registry.set(store, backend);
}

/** Engine-only capability lookup. This module is deliberately not package-exported. */
export function registeredMagStoreBackend(store: MagStore): MagStoreBackend | undefined {
  return registry.get(store);
}
