/**
 * Loopback OAuth redirect catcher. The user's browser is sent to the
 * authorization server; after they approve, the AS redirects back to
 * `http://127.0.0.1:<port>/callback?code=...&state=...`. This tiny server
 * (bound to loopback ONLY) captures that one redirect and hands the code back
 * to the login flow.
 *
 * SECURITY (the CSRF guard — this is the whole point of `state`): a redirect
 * whose `state` does not EXACTLY match the value we generated is rejected with
 * a 400 and `waitForCode` REJECTS with NO code. An attacker who tricks the
 * browser into hitting our callback with their own `?code=` cannot make us
 * exchange it, because they can't know our random `state`. A missing `state`
 * is treated the same as a mismatch — never resolved.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface OAuthCallbackServerOptions {
  /** Bind port; omit or 0 for an ephemeral OS-assigned port. */
  readonly port?: number;
  /** The exact CSRF state generated for this login attempt. */
  readonly expectedState: string;
  readonly timeoutMs: number;
}

export interface OAuthCallbackServer {
  readonly port: number;
  waitForCode(): Promise<{ readonly code: string }>;
  close(): Promise<void>;
}

const SUCCESS_HTML =
  "<!doctype html><meta charset=utf-8><title>Muse</title>" +
  "<body style=\"font-family:system-ui;padding:2rem\"><h1>Authorized</h1>" +
  "<p>Muse captured the authorization. You can close this tab and return to the terminal.</p></body>";

export async function startOAuthCallbackServer(
  options: OAuthCallbackServerOptions
): Promise<OAuthCallbackServer> {
  if (options.expectedState.trim().length === 0) {
    throw new Error("OAuth callback requires a non-empty CSRF state");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("OAuth callback timeout must be a positive finite number");
  }
  const codeDeferred = Promise.withResolvers<{ readonly code: string }>();
  let settled = false;

  const settleResolve = (value: { readonly code: string }): void => {
    if (!settled) {
      settled = true;
      codeDeferred.resolve(value);
    }
  };
  const settleReject = (reason: Error): void => {
    if (!settled) {
      settled = true;
      codeDeferred.reject(reason);
    }
  };

  const server = createServer((req, res) => handleRequest(req, res, options.expectedState, settleResolve, settleReject));

  const listening = Promise.withResolvers<void>();
  const onListeningError = (error: Error): void => {
    server.removeListener("listening", onListening);
    listening.reject(error);
  };
  const onListening = (): void => {
    server.removeListener("error", onListeningError);
    listening.resolve();
  };
  server.once("error", onListeningError);
  server.once("listening", onListening);
  server.listen(options.port ?? 0, "127.0.0.1");
  await listening.promise;

  const address = server.address();
  const port = address && typeof address === "object" ? address.port : options.port ?? 0;

  const timeout = setTimeout(() => {
    settleReject(new Error(`OAuth callback timed out after ${options.timeoutMs.toString()}ms`));
  }, options.timeoutMs);
  timeout.unref();

  // Keep callback path clean: once the wait has been resolved/rejected,
  // clear the timer so an unused waiting path doesn't hold resources.
  void codeDeferred.promise.finally(() => {
    clearTimeout(timeout);
  }).catch(() => undefined);

  const close = async (): Promise<void> => {
    clearTimeout(timeout);
    if (!server.listening) {
      return;
    }
    const closeResult = Promise.withResolvers<void>();
    server.once("close", () => {
      closeResult.resolve();
    });
    server.close();
    await closeResult.promise;
  };

  return {
    port,
    waitForCode: () => codeDeferred.promise,
    close
  };
}

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedState: string,
  resolveCode: (value: { readonly code: string }) => void,
  rejectCode: (reason: Error) => void
): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/callback") {
    // favicon / stray probes — never a callback, so don't settle on them.
    res.writeHead(404).end();
    return;
  }

  const error = url.searchParams.get("error");
  if (error) {
    const description = url.searchParams.get("error_description");
    respond(res, 400, `Authorization failed: ${error}`);
    rejectCode(new Error(description ? `${error}: ${description}` : `Authorization failed: ${error}`));
    return;
  }

  const state = url.searchParams.get("state");
  if (state !== expectedState) {
    // CSRF guard: never resolve a code when state doesn't match exactly.
    respond(res, 400, "State mismatch — refusing this callback.");
    rejectCode(new Error("OAuth state mismatch: the callback did not carry the expected CSRF state"));
    return;
  }

  const code = url.searchParams.get("code");
  if (!code) {
    respond(res, 400, "Missing authorization code.");
    rejectCode(new Error("OAuth callback carried no authorization code"));
    return;
  }

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(SUCCESS_HTML);
  resolveCode({ code });
}

function respond(res: ServerResponse, status: number, message: string): void {
  res
    .writeHead(status, { "content-type": "text/html; charset=utf-8" })
    .end(`<!doctype html><meta charset=utf-8><body style="font-family:system-ui;padding:2rem">${message}</body>`);
}
