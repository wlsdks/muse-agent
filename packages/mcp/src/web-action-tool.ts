/**
 * P17 conversational actuation: expose the gated web action (submit /
 * book) as an AGENT tool so Muse can act on "book a table at X for 7pm"
 * mid-turn — not only via `muse web-action`. Execution routes through
 * the proven fail-closed `performWebActionWithApproval` (draft-first
 * approval gate, action-logged), so the agent path inherits the SAME
 * outbound-safety guarantee: deny / timeout / absent confirm ⇒ no HTTP.
 *
 * NOT for banking / payments — out of scope per outbound-safety.
 */

import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import { performWebActionWithApproval, type WebActionApprovalGate } from "./web-action.js";

export interface WebActionToolDeps {
  readonly fetchImpl: typeof fetch;
  readonly approvalGate: WebActionApprovalGate;
  readonly actionLogFile: string;
  readonly userId: string;
}

export function createWebActionTool(deps: WebActionToolDeps): MuseTool {
  return {
    definition: {
      description:
        "Perform a state-changing web request (submit a form, book) to a third party. The user must confirm the exact action before anything is sent; absent confirmation nothing fires. Not for payments or money movement.",
      domain: "system",
      inputSchema: {
        additionalProperties: false,
        properties: {
          body: { description: "Request body (e.g. JSON).", type: "string" },
          method: { description: "HTTP method (default POST).", type: "string" },
          summary: { description: "Human description of what this action does (shown for confirmation).", type: "string" },
          url: { description: "Target URL.", type: "string" }
        },
        required: ["summary", "url"],
        type: "object"
      },
      keywords: ["web", "submit", "book", "form", "action"],
      name: "web_action",
      risk: "execute"
    },
    execute: async (args): Promise<JsonObject> => {
      const url = typeof args["url"] === "string" ? args["url"].trim() : "";
      const summary = typeof args["summary"] === "string" ? args["summary"].trim() : "";
      if (url.length === 0 || summary.length === 0) {
        return { performed: false, reason: "web_action requires a non-empty 'url' and 'summary'" };
      }
      const method = typeof args["method"] === "string" && args["method"].trim().length > 0
        ? args["method"].trim().toUpperCase()
        : "POST";
      const body = typeof args["body"] === "string" ? args["body"] : undefined;
      const outcome = await performWebActionWithApproval({
        actionLogFile: deps.actionLogFile,
        approvalGate: deps.approvalGate,
        fetchImpl: deps.fetchImpl,
        request: { method, url, ...(body !== undefined ? { body } : {}) },
        summary,
        userId: deps.userId
      });
      return outcome.performed
        ? { performed: true, status: outcome.status }
        : { detail: outcome.detail, performed: false, reason: outcome.reason };
    }
  };
}
