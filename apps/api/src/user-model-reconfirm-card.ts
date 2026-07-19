/**
 * The reconfirm-card question builder moved to `@muse/memory` so the CLI
 * daemon's day-rhythm briefing tick (`apps/cli/src/daemon-delivery-ticks.ts`)
 * and this app's `/api/user-model/reconfirm-card*` route can share ONE
 * implementation (`apps/cli` cannot import from `apps/api` or vice versa —
 * separate apps). Re-exported here to keep this app's existing imports
 * pointing at a stable local path.
 */
export { buildReconfirmCard, type ReconfirmableEntry, type ReconfirmCard } from "@muse/memory";
