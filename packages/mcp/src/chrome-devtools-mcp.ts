import type { MuseTool, ToolRisk } from "@muse/tools";

import type { McpServerInput } from "./index.js";

/**
 * Connector preset for the open-source Chrome DevTools MCP server
 * (`ChromeDevTools/chrome-devtools-mcp`, Apache-2.0).
 *
 * It attaches to the user's ALREADY-RUNNING Chrome over the
 * remote-debugging port (launch Chrome with
 * `--remote-debugging-port=9222`) so Muse perceives and acts inside
 * the real, logged-in session — not a fresh headless browser. Read /
 * perceive is the intended default; any state-changing web action
 * under the user's identity stays fail-close + draft-first per
 * `outbound-safety.md`, and banking / payments are out of scope.
 *
 * `npx` is already in the default `allowedStdioCommands`, so the
 * preset connects under the standard MCP security policy once
 * `chrome-devtools` is permitted by `allowedServerNames` (empty =
 * allow all).
 */
export interface ChromeDevToolsMcpOptions {
  /** Remote-debugging endpoint of the user's running Chrome. Default `http://127.0.0.1:9222`. */
  readonly browserUrl?: string;
  /** Connect at startup. Default `false` — opt-in, since it drives the real browser. */
  readonly autoConnect?: boolean;
  /** Optional stdio binary fingerprint pin (passed through to the manager). */
  readonly fingerprintSha256?: string;
}

export const CHROME_DEVTOOLS_MCP_SERVER_NAME = "chrome-devtools";
const DEFAULT_BROWSER_URL = "http://127.0.0.1:9222";

export function createChromeDevToolsMcpServer(options: ChromeDevToolsMcpOptions = {}): McpServerInput {
  const browserUrl = options.browserUrl?.trim();
  const args = [
    "chrome-devtools-mcp@latest",
    "--browser-url",
    browserUrl && browserUrl.length > 0 ? browserUrl : DEFAULT_BROWSER_URL
  ];
  return {
    autoConnect: options.autoConnect ?? false,
    config: {
      args,
      command: "npx",
      ...(options.fingerprintSha256 ? { fingerprintSha256: options.fingerprintSha256 } : {})
    },
    description: "Drive the user's real logged-in Chrome (perceive live pages + gated actions) via Chrome DevTools MCP",
    name: CHROME_DEVTOOLS_MCP_SERVER_NAME,
    transportType: "stdio"
  };
}

// Pure observation — safe to run without approval.
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "take_snapshot",
  "take_screenshot",
  "list_pages",
  "list_console_messages",
  "get_console_message",
  "list_network_requests",
  "get_network_request",
  "wait_for",
  "performance_analyze_insight"
]);

// Arbitrary-code / file / dialog surface — the highest-blast-radius
// actions in the user's logged-in session.
const EXECUTE_TOOLS: ReadonlySet<string> = new Set([
  "evaluate_script",
  "upload_file",
  "handle_dialog"
]);

/**
 * Risk for a Chrome DevTools MCP tool, by bare tool name. We do NOT
 * trust the external server's MCP annotations here: it drives the
 * user's REAL logged-in browser, so the default is fail-close — any
 * tool that isn't a known pure-observation call (click / fill /
 * submit / navigate / and anything unrecognised) is treated as
 * state-changing and must clear the approval gate before it runs.
 */
export function chromeDevToolsToolRisk(toolName: string): ToolRisk {
  if (READ_ONLY_TOOLS.has(toolName)) {
    return "read";
  }
  if (EXECUTE_TOOLS.has(toolName)) {
    return "execute";
  }
  return "write";
}

/**
 * Re-stamp Chrome DevTools MCP tools projected by
 * `McpManager.toMuseTools()`:
 *
 *  - RISK via {@link chromeDevToolsToolRisk}, so the AgentRuntime's
 *    `toolApprovalGate` fires fail-close on a state-changing browser
 *    action (the external server's "read" default would otherwise let
 *    a `fill_form` / `click` through ungated).
 *  - DOMAIN `"web"`, so the relevance filter only advertises the ~30
 *    browser tools on a web/browser prompt. Without a domain an
 *    externally-projected MCP tool is "always-on" and floods every
 *    prompt's catalog, wrecking one-shot tool selection on the local
 *    model (`tool-calling.md` rule 1).
 *
 * Non-Chrome tools pass through untouched.
 */
export function withChromeDevToolsRisk(tools: readonly MuseTool[]): MuseTool[] {
  const prefix = `${CHROME_DEVTOOLS_MCP_SERVER_NAME}.`;
  return tools.map((tool) => {
    if (!tool.definition.name.startsWith(prefix)) {
      return tool;
    }
    const risk = chromeDevToolsToolRisk(tool.definition.name.slice(prefix.length));
    return { ...tool, definition: { ...tool.definition, domain: "web", risk } };
  });
}
