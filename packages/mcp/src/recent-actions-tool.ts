/**
 * `recent_actions` agent tool — surface the autonomous actions Muse has taken on
 * the user's behalf (the append-only action log: sends, web submissions, home
 * commands, AND refusals). Otherwise CLI-only (`muse actions`); this lets a
 * conversation answer "what have you done for me?" — Muse's "shows its work"
 * transparency promise on the action surface. Read-only: it LISTS the history,
 * it never takes an action. Internal fields (userId, the hash-chain link, ids)
 * are NOT exposed — only the user-facing what / why / outcome / when.
 */

import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import type { ActionLogEntry } from "./personal-action-log-store.js";

export interface RecentActionsToolDeps {
  /** The action-log entries, append-ordered (oldest first), as written. */
  readonly actions: () => Promise<readonly ActionLogEntry[]> | readonly ActionLogEntry[];
}

export function createRecentActionsTool(deps: RecentActionsToolDeps): MuseTool {
  return {
    definition: {
      description:
        "List the autonomous actions Muse has taken on the user's behalf — what it did (a message/comment it posted, a booking, a home command), WHY, the outcome (performed / refused / failed), and when. Includes REFUSALS (what it declined to do and why). Answers 'what have you done for me?' / 'did you do anything I should know about?' / '내 대신 뭘 했어?'. Read-only transparency — it shows the action history, it does NOT take or undo an action.",
      domain: "system",
      inputSchema: {
        additionalProperties: false,
        properties: {
          limit: { description: "How many recent actions to return, e.g. 10. Defaults to 20.", maximum: 100, minimum: 1, type: "integer" }
        },
        required: [],
        type: "object"
      },
      keywords: ["action", "actions", "did", "done", "taken", "what did you do", "history", "log", "한 일", "뭘 했", "행동", "내역"],
      name: "recent_actions",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const raw = args["limit"];
      const limit = typeof raw === "number" && Number.isFinite(raw) && raw >= 1 ? Math.min(100, Math.trunc(raw)) : 20;
      const all = await Promise.resolve(deps.actions());
      const recent = [...all].reverse().slice(0, limit); // most-recent first
      return {
        count: recent.length,
        actions: recent.map((a) => ({
          result: a.result,
          what: a.what,
          when: a.when,
          why: a.why,
          ...(a.detail ? { detail: a.detail } : {})
        }))
      };
    }
  };
}
