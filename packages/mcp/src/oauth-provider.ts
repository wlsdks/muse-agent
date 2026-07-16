/**
 * `MuseMcpOAuthProvider` — Muse's implementation of the MCP SDK's
 * `OAuthClientProvider` for a single remote MCP server.
 *
 * The SDK owns the OAuth PROTOCOL (RFC 9728/8414 discovery, RFC 7591 DCR,
 * RFC 7636 PKCE, token exchange/refresh, RFC 8707 resource indicators). This
 * class only supplies the four things the SDK can't decide for us: what the
 * client is (public + PKCE, loopback redirect — never a client secret), where
 * to persist session state (the file-backed `oauth-store`), how to send the
 * user to the browser (an injectable opener — NEVER an auto-approve), and a
 * CSRF `state` that survives to the callback.
 */

import { randomUUID } from "node:crypto";

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens
} from "@modelcontextprotocol/sdk/shared/auth.js";

import { openUrlInDefaultBrowser } from "./open-url.js";
import {
  clearOAuth,
  loadClientInformation,
  loadCodeVerifier,
  loadState,
  loadTokens,
  saveClientInformation,
  saveCodeVerifier,
  saveState,
  saveTokens,
  type OAuthClearScope
} from "./oauth-store.js";

export interface MuseMcpOAuthProviderOptions {
  readonly serverId: string;
  readonly oauthDir: string;
  readonly redirectPort: number;
  readonly clientName: string;
  readonly scopes?: readonly string[];
  /** Injectable so tests never spawn a real browser; default opens the OS default browser. */
  readonly openBrowser?: (url: string) => void | Promise<void>;
  /** Injectable CSRF-state source for deterministic tests; default is a fresh random UUID. */
  readonly randomState?: () => string;
  readonly env?: NodeJS.ProcessEnv;
}

function requireLoopbackPort(port: number): number {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError("redirectPort must be a safe integer between 1 and 65535");
  }

  return port;
}

export class MuseMcpOAuthProvider implements OAuthClientProvider {
  private readonly serverId: string;
  private readonly oauthDir: string;
  private readonly redirectPort: number;
  private readonly clientName: string;
  private readonly scopes: readonly string[] | undefined;
  private readonly openBrowser: (url: string) => void | Promise<void>;
  private readonly randomState: () => string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: MuseMcpOAuthProviderOptions) {
    this.serverId = options.serverId;
    this.oauthDir = options.oauthDir;
    this.redirectPort = requireLoopbackPort(options.redirectPort);
    this.clientName = options.clientName;
    this.scopes = options.scopes && options.scopes.length > 0 ? options.scopes : undefined;
    this.openBrowser = options.openBrowser ?? openUrlInDefaultBrowser;
    this.randomState = options.randomState ?? randomUUID;
    this.env = options.env ?? process.env;
  }

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.redirectPort.toString()}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.clientName,
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [this.redirectUrl],
      response_types: ["code"],
      // Public client + PKCE: no client secret to leak from a single-user
      // local install. `token_endpoint_auth_method: "none"` is what tells the
      // AS this is a public client so it doesn't demand a secret at exchange.
      token_endpoint_auth_method: "none",
      ...(this.scopes ? { scope: this.scopes.join(" ") } : {})
    };
  }

  async state(): Promise<string> {
    const value = this.randomState();
    await saveState(this.oauthDir, this.serverId, value, this.env);
    return value;
  }

  clientInformation(): Promise<OAuthClientInformationFull | undefined> {
    return loadClientInformation(this.oauthDir, this.serverId, this.env);
  }

  async saveClientInformation(clientInformation: OAuthClientInformationFull): Promise<void> {
    await saveClientInformation(this.oauthDir, this.serverId, clientInformation, this.env);
  }

  tokens(): Promise<OAuthTokens | undefined> {
    return loadTokens(this.oauthDir, this.serverId, this.env);
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await saveTokens(this.oauthDir, this.serverId, tokens, this.env);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.openBrowser(authorizationUrl.toString());
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await saveCodeVerifier(this.oauthDir, this.serverId, codeVerifier, this.env);
  }

  async codeVerifier(): Promise<string> {
    const verifier = await loadCodeVerifier(this.oauthDir, this.serverId, this.env);
    if (!verifier) {
      throw new Error(
        `No PKCE code verifier saved for MCP server '${this.serverId}'. ` +
          "Start the login flow again (`muse mcp login`)."
      );
    }
    return verifier;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    // 'discovery' state isn't persisted by this store (the SDK re-discovers on
    // the next auth), so there's nothing to clear for it — map only the scopes
    // that name persisted state.
    if (scope === "discovery") {
      return;
    }
    await clearOAuth(this.oauthDir, this.serverId, scope satisfies OAuthClearScope, this.env);
  }

  /** The persisted CSRF state, so the callback server can validate `?state=` against it. */
  loadPersistedState(): Promise<string | undefined> {
    return loadState(this.oauthDir, this.serverId, this.env);
  }
}
