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
