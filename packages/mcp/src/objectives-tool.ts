/**
 * `list_objectives` agent tool — surface the standing objectives Muse is
 * autonomously pursuing for the user (the "watch X / keep going until Z / tell
 * me when W" goals). They are otherwise CLI-only (`muse objectives`) + injected
 * passively as grounding; this lets a conversation answer "what are you working
 * on for me?". Read-only — it LISTS goals, it never creates or acts on them
 * (creating/acting is the gated objectives path, not this tool).
 */

import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import type { StandingObjective } from "@muse/stores";

export interface ObjectivesListToolDeps {
  readonly objectives: () => Promise<readonly StandingObjective[]> | readonly StandingObjective[];
}

export function createObjectivesListTool(deps: ObjectivesListToolDeps): MuseTool {
  return {
    definition: {
      description:
        "List the standing objectives Muse is autonomously pursuing for the user — the 'watch X', 'keep going until Z', 'tell me when W' goals they set. Answers 'what are you working on for me?' / 'what am I tracking?' / '내가 뭘 향해 가고 있지?'. Returns only the LIVE ones (active or escalated), not finished or cancelled goals. Read-only — it lists goals; it does NOT create one (that is a separate gated action) and is NOT the to-do list (use the tasks tool for to-dos).",
      domain: "system",
      inputSchema: {
        additionalProperties: false,
        properties: {},
        required: [],
        type: "object"
      },
      keywords: ["objective", "objectives", "goal", "goals", "working toward", "tracking", "pursuing", "목표", "추적", "향해"],
      name: "list_objectives",
      risk: "read"
    },
    execute: async (): Promise<JsonObject> => {
      const all = await Promise.resolve(deps.objectives());
      const live = all.filter((o) => o.status === "active" || o.status === "escalated");
      return {
        count: live.length,
        objectives: live.map((o) => ({ createdAt: o.createdAt, kind: o.kind, spec: o.spec, status: o.status }))
      };
    }
  };
}
