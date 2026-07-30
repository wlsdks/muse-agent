import type { ExperienceLearningReviewQueue } from "@muse/attunement";
import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import { projectLearningOpportunity } from "./continuity-outcome-tool.js";

export interface ContinuityLearningOpportunityToolDeps {
  readonly readQueue: () => Promise<ExperienceLearningReviewQueue>;
}

export function createContinuityLearningOpportunityTool(
  deps: ContinuityLearningOpportunityToolDeps
): MuseTool {
  return {
    definition: {
      description:
        "List bounded owner-explicit Continuity learning opportunities that still require a draft, frozen replay evidence, and explicit approval. This is read-only and never creates or activates a policy change.",
      domain: "core",
      inputSchema: {
        additionalProperties: false,
        properties: {},
        type: "object"
      },
      keywords: [
        "continuity",
        "learning",
        "review",
        "improvement",
        "학습",
        "개선"
      ],
      name: "muse.continuity.learning.opportunities",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const prototype = Object.getPrototypeOf(args);
      if ((prototype !== Object.prototype && prototype !== null)
        || Reflect.ownKeys(args).length !== 0) {
        throw new Error("continuity learning opportunities input must be an empty plain object");
      }
      const queue = await deps.readQueue();
      return {
        items: queue.items.map(projectLearningOpportunity),
        limit: queue.limit,
        status: queue.status,
        total: queue.total,
        truncated: queue.truncated
      };
    }
  };
}
