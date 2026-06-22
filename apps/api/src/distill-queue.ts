/**
 * Idle distill-consumer — moved to `@muse/autoconfigure` so the `apps/api`
 * server tick and the `muse daemon` CLI drain the same learn-queue through one
 * grounding-fenced, brake-respecting implementation. Re-exported here to keep
 * this app's existing imports + tests pointing at a stable local path.
 */
export { distillQueuedCorrections } from "@muse/autoconfigure";
