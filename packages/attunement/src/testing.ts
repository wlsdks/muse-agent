/**
 * Explicit monorepo test seam. Production code must use `@muse/attunement/host`
 * or the narrower read-only subpaths instead.
 */
export {
  createLocalAttunementSnapshotProvider,
  createLocalAttunementSnapshotProviderForTesting
} from "./local-attunement-snapshot-provider.js";
