/**
 * Interactive OAuth 2.1 login for a remote MCP server, orchestrating the SDK's
 * `auth()` state machine against Muse's provider + loopback callback server.
 *
 * The whole flow lives here (not in the CLI) so it is unit-testable against a
 * mock authorization server. The CLI command is a thin shell that resolves the
 * server URL + oauth dir and calls `runMcpOAuthLogin`.
 *
 * Ordering matters and is security-load-bearing: we generate the CSRF `state`
 * ourselves, hand the SAME value to BOTH the callback server (as the expected
 * state) AND the provider (as its `randomState`), then bind the callback
 * server to learn its ephemeral port BEFORE constructing the provider — so the
 * provider's `redirectUrl` matches the port the browser will actually hit, and
 * the callback can validate the returned `?state=` against the value the SDK
 * embedded in the authorization URL.
 */

import { randomUUID } from "node:crypto";

import { auth as sdkAuth } from "@modelcontextprotocol/sdk/client/auth.js";

import { startOAuthCallbackServer, type OAuthCallbackServer } from "./oauth-callback-server.js";
import { MuseMcpOAuthProvider } from "./oauth-provider.js";

type AuthResult = "AUTHORIZED" | "REDIRECT";

export interface McpOAuthLoginOptions {
  readonly serverId: string;
  readonly serverUrl: string;
  readonly oauthDir: string;
  readonly clientName: string;
  readonly scopes?: readonly string[];
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  /** Injected so tests never spawn a browser; production opens the OS default. */
  readonly openBrowser?: (url: string) => void | Promise<void>;
  /** Injected in tests to drive a mock authorization server; defaults to the SDK's `auth()`. */
  readonly authImpl?: (
    provider: MuseMcpOAuthProvider,
    options: { serverUrl: string; authorizationCode?: string }
  ) => Promise<AuthResult>;
  /** Injected in tests to substitute the callback transport; defaults to the loopback server. */
  readonly startCallbackServer?: typeof startOAuthCallbackServer;
}

export interface McpOAuthLoginResult {
  readonly status: "authorized";
  readonly serverId: string;
}

export async function runMcpOAuthLogin(options: McpOAuthLoginOptions): Promise<McpOAuthLoginResult> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const state = randomUUID();
  const startCallbackServer = options.startCallbackServer ?? startOAuthCallbackServer;
  const authImpl = options.authImpl ?? defaultAuthImpl;

  const callback: OAuthCallbackServer = await startCallbackServer({ expectedState: state, timeoutMs });
  try {
    const provider = new MuseMcpOAuthProvider({
      clientName: options.clientName,
      env: options.env,
      oauthDir: options.oauthDir,
      openBrowser: options.openBrowser,
      randomState: () => state,
      redirectPort: callback.port,
      serverId: options.serverId,
      ...(options.scopes ? { scopes: options.scopes } : {})
    });

    const first = await authImpl(provider, { serverUrl: options.serverUrl });
    if (first === "AUTHORIZED") {
      // Already authorized (valid refresh token / pre-registered) — no browser hop needed.
      return { serverId: options.serverId, status: "authorized" };
    }

    const { code } = await callback.waitForCode();
    const second = await authImpl(provider, { authorizationCode: code, serverUrl: options.serverUrl });
    if (second !== "AUTHORIZED") {
      throw new Error(`OAuth exchange did not authorize (SDK returned '${second}')`);
    }
    return { serverId: options.serverId, status: "authorized" };
  } finally {
    await callback.close();
  }
}

async function defaultAuthImpl(
  provider: MuseMcpOAuthProvider,
  options: { serverUrl: string; authorizationCode?: string }
): Promise<AuthResult> {
  return sdkAuth(provider, options);
}
