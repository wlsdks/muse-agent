/**
 * CLI binding of `@muse/recall`'s session/feed/reflection grounding stage:
 * resolves the store paths through `@muse/autoconfigure` (which the package
 * must not import — that reference would cycle) and embeds through the CLI's
 * models.json-merged endpoint. Paths resolve at CALL time so env changes
 * (tests, `muse setup`) stay effective.
 */

import { resolveBrowsingFile, resolveEpisodesFile, resolveReflectionsFile } from "@muse/autoconfigure";
import {
  buildSessionFeedReflectionGrounding as buildSessionFeedReflectionGroundingCore,
  type SessionFeedReflectionGrounding
} from "@muse/recall";

import { embed } from "./embed.js";

export type { SessionFeedReflectionGrounding } from "@muse/recall";

type CoreParams = Parameters<typeof buildSessionFeedReflectionGroundingCore>[0];

export async function buildSessionFeedReflectionGrounding(
  params: Omit<CoreParams, "episodesFile" | "reflectionsFile" | "browsingFile" | "embedFn">
): Promise<SessionFeedReflectionGrounding> {
  const env = process.env as Record<string, string | undefined>;
  return buildSessionFeedReflectionGroundingCore({
    ...params,
    embedFn: embed,
    episodesFile: resolveEpisodesFile(env),
    reflectionsFile: resolveReflectionsFile(env),
    browsingFile: resolveBrowsingFile(env)
  });
}
