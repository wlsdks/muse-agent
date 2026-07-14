/**
 * CLI binding of `@muse/recall`'s activity grounding stage: the action-log
 * path resolves through `@muse/autoconfigure` at CALL time (the package must
 * not import autoconfigure — cycle), embeddings go through the CLI's
 * models.json-merged endpoint.
 */

import { resolveActionLogFile } from "@muse/autoconfigure";
import {
  buildActivityGrounding as buildActivityGroundingCore,
  type ActivityGrounding
} from "@muse/recall";

import { embed } from "./embed.js";

export type { ActivityGrounding } from "@muse/recall";

type CoreParams = Parameters<typeof buildActivityGroundingCore>[0];

export async function buildActivityGrounding(
  params: Omit<CoreParams, "actionLogFile" | "embedFn">
): Promise<ActivityGrounding> {
  return buildActivityGroundingCore({
    ...params,
    actionLogFile: resolveActionLogFile(process.env),
    embedFn: embed
  });
}
