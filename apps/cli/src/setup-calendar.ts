/**
 * `muse setup calendar` — interactive wizard that walks the user
 * through enabling calendar providers and storing their credentials
 * to `~/.muse/credentials.json` (chmod 600).
 *
 * Local: enabled by default, just confirms the storage path.
 * Google: runs an OAuth code-flow against an ephemeral localhost
 *   redirect URI, exchanges the code for a refresh token, persists
 *   it. Requires the user to provide a Google Cloud OAuth client
 *   created with `http://localhost:<port>/callback` as a redirect.
 * CalDAV: prompts for URL / username / app-password (works for
 *   iCloud, Fastmail, Proton, generic CalDAV).
 * macOS: prompts for the Calendar.app calendar name (or empty to
 *   use the primary). The first agent call will trigger the system
 *   permission prompt.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";
import { URL, URLSearchParams } from "node:url";
import { on, once } from "node:events";

import { confirm, isCancel, multiselect, password, text } from "@clack/prompts";
import { FileCalendarCredentialStore } from "@muse/calendar";
import { isLocalOnlyEnabled } from "@muse/model";

interface SetupCalendarIO {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
  readonly home?: string;
  readonly fetchImpl?: typeof fetch;
  readonly openBrowser?: (url: string) => Promise<void> | void;
  /** Optional test seam; production commands inherit process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const googleAuthUrl = "https://accounts.google.com/o/oauth2/v2/auth";
const googleTokenUrl = "https://oauth2.googleapis.com/token";
const googleScope = "https://www.googleapis.com/auth/calendar";

export async function runCalendarSetup(io: SetupCalendarIO): Promise<void> {
  if (isLocalOnlyEnabled(io.env ?? process.env)) {
    io.stdout(
      "Remote Google/CalDAV setup is disabled while MUSE_LOCAL_ONLY=true. "
      + "Local file, exported ICS, and macOS Calendar.app remain available; "
      + "set MUSE_MACOS_CALENDAR_NAME to scope Calendar.app. "
      + "Set MUSE_LOCAL_ONLY=false to configure Google/CalDAV.\n"
    );
    return;
  }
  const home = io.home ?? homedir();
  const credentialsFile = pathJoin(home, ".muse", "credentials.json");
  const store = new FileCalendarCredentialStore(credentialsFile);

  io.stdout(`Calendar setup — credentials will be saved to ${credentialsFile} (chmod 600).\n\n`);

  const selection = await multiselect({
    initialValues: ["local"],
    message: "Which calendar providers do you want to enable?",
    options: [
      { label: "Local file (always available)", value: "local" },
      { label: "Google Calendar (OAuth)", value: "gcal" },
      { label: "CalDAV (iCloud / Fastmail / Proton / generic)", value: "caldav" },
      { label: "macOS Calendar.app (AppleScript)", value: "macos" }
    ],
    required: true
  });

  if (isCancel(selection)) {
    io.stdout("Setup cancelled.\n");
    return;
  }

  const providers = selection as readonly string[];

  for (const id of providers) {
    if (id === "local") {
      io.stdout(`✓ local — events will be stored at ${pathJoin(home, ".muse", "calendar.json")}\n`);
      continue;
    }

    if (id === "gcal") {
      const ok = await setupGoogle(store, io);
      if (!ok) {
        io.stdout("- gcal — skipped\n");
      }
      continue;
    }

    if (id === "caldav") {
      const ok = await setupCalDAV(store, io);
      if (!ok) {
        io.stdout("- caldav — skipped\n");
      }
      continue;
    }

    if (id === "macos") {
      const ok = await setupMacOs(store, io);
      if (!ok) {
        io.stdout("- macos — skipped\n");
      }
      continue;
    }
  }

  const enabled = await store.list();
  const all = ["local", ...enabled];
  io.stdout(
    `\nDone. Active providers: ${[...new Set(all)].join(", ")}\n` +
    `Set MUSE_CALENDAR_PROVIDERS=${[...new Set(all)].join(",")} when starting muse-api to load all of them.\n`
  );
}

async function setupGoogle(store: FileCalendarCredentialStore, io: SetupCalendarIO): Promise<boolean> {
  io.stdout(
    `\nGoogle Calendar setup\n` +
    `  Pre-requisite: a Google Cloud OAuth 2.0 client created at\n` +
    `  https://console.cloud.google.com/apis/credentials with redirect\n` +
    `  URI matching the loopback address shown below.\n\n`
  );

  const clientId = await text({ message: "Google OAuth Client ID:", placeholder: "xxx.apps.googleusercontent.com" });
  if (isCancel(clientId) || typeof clientId !== "string" || clientId.trim().length === 0) {
    return false;
  }
  const clientSecret = await password({ message: "Google OAuth Client Secret:" });
  if (isCancel(clientSecret) || typeof clientSecret !== "string" || clientSecret.length === 0) {
    return false;
  }
  const calendarId = await text({
    message: "Calendar ID (default: primary):",
    placeholder: "primary"
  });
  if (isCancel(calendarId)) {
    return false;
  }

  const pkce = generatePkcePair();
  const { code, redirectUri } = await runOAuthCallbackServer({
    authUrl: googleAuthUrl,
    clientId: clientId.trim(),
    io,
    pkce,
    scope: googleScope
  });

  const params = new URLSearchParams({
    client_id: clientId.trim(),
    client_secret: clientSecret,
    code,
    code_verifier: pkce.verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri
  });

  const fetchImpl = io.fetchImpl ?? fetch;
  const tokenResponse = await fetchImpl(googleTokenUrl, {
    body: params.toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST"
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text().catch(() => "");
    io.stderr(`Google OAuth token exchange failed (${tokenResponse.status}): ${errorText}\n`);
    return false;
  }

  const payload = await tokenResponse.json() as { readonly refresh_token?: string };
  if (!payload.refresh_token) {
    io.stderr("Google response missing refresh_token. Make sure the OAuth consent screen requests offline access.\n");
    return false;
  }

  await store.save("gcal", {
    calendarId: typeof calendarId === "string" && calendarId.trim().length > 0 ? calendarId.trim() : "primary",
    clientId: clientId.trim(),
    clientSecret,
    refreshToken: payload.refresh_token
  });

  io.stdout("✓ gcal — saved\n");
  return true;
}

async function setupCalDAV(store: FileCalendarCredentialStore, io: SetupCalendarIO): Promise<boolean> {
  io.stdout(
    `\nCalDAV setup (works with iCloud, Fastmail, Proton, Yahoo, generic)\n` +
    `  iCloud users: app-specific password from https://appleid.apple.com/account/manage\n` +
    `  Fastmail users: app password from https://app.fastmail.com/settings/security\n\n`
  );

  const url = await text({
    message: "CalDAV URL (full path to the calendar):",
    placeholder: "https://caldav.icloud.com/123456/calendars/home/"
  });
  if (isCancel(url) || typeof url !== "string" || url.trim().length === 0) {
    return false;
  }

  const username = await text({ message: "Username (usually email):", placeholder: "user@example.com" });
  if (isCancel(username) || typeof username !== "string" || username.trim().length === 0) {
    return false;
  }

  const appPassword = await password({ message: "App-specific password:" });
  if (isCancel(appPassword) || typeof appPassword !== "string" || appPassword.length === 0) {
    return false;
  }

  await store.save("caldav", { password: appPassword, url: url.trim(), username: username.trim() });
  io.stdout("✓ caldav — saved\n");
  return true;
}

async function setupMacOs(store: FileCalendarCredentialStore, io: SetupCalendarIO): Promise<boolean> {
  io.stdout(
    `\nmacOS Calendar.app setup\n` +
    `  The first agent call will trigger the system permission prompt —\n` +
    `  grant access to your terminal in System Settings → Privacy & Security → Calendars.\n\n`
  );

  const calendarName = await text({
    message: "Calendar name (leave empty to use all calendars):",
    placeholder: "Personal"
  });
  if (isCancel(calendarName)) {
    return false;
  }

  const trimmed = typeof calendarName === "string" ? calendarName.trim() : "";
  await store.save("macos", trimmed.length > 0 ? { calendarName: trimmed } : {});
  io.stdout("✓ macos — saved\n");

  const tryNow = await confirm({ initialValue: false, message: "Trigger the permission prompt now? (Calendar.app will open briefly)" });
  if (!isCancel(tryNow) && tryNow) {
    io.stdout("Open Calendar.app manually if the permission dialog does not appear automatically.\n");
  }

  return true;
}

interface OAuthCallbackOptions {
  readonly authUrl: string;
  readonly clientId: string;
  readonly io: SetupCalendarIO;
  readonly scope: string;
  readonly pkce?: PkcePair;
}

export function generateOAuthState(): string {
  return randomBytes(16).toString("hex");
}

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
  readonly method: "S256";
}

export function generatePkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, method: "S256" };
}

async function runOAuthCallbackServer(
  options: OAuthCallbackOptions
): Promise<{ readonly code: string; readonly redirectUri: string }> {
  const state = generateOAuthState();
  const server = createServer();
  const requests = on(server, "request");
  const iterator = requests[Symbol.asyncIterator]();
  server.listen(0, "127.0.0.1");

  try {
    await once(server, "listening");

    const address = server.address() as AddressInfo;
    const redirectUri = `http://127.0.0.1:${address.port}/callback`;
    const params = new URLSearchParams({
      access_type: "offline",
      client_id: options.clientId,
      prompt: "consent",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: options.scope,
      state,
      ...(options.pkce ? {
        code_challenge: options.pkce.challenge,
        code_challenge_method: options.pkce.method
      } : {})
    });
    const launchUrl = `${options.authUrl}?${params.toString()}`;
    options.io.stdout(`\nOpen this URL to authorize:\n  ${launchUrl}\n\nWaiting for callback on ${redirectUri} ...\n`);

    const open = options.io.openBrowser;
    if (open) {
      Promise.resolve(open(launchUrl)).catch(() => undefined);
    }

    while (true) {
      const requestResult = await Promise.race([
        iterator.next().then((event) => ({ kind: "request" as const, event })),
        once(server, "error").then(([error]) => ({ kind: "error" as const, error }))
      ]);

      if (requestResult.kind === "error") {
        throw requestResult.error;
      }

      if (requestResult.event.done) {
        throw new Error("OAuth callback server closed unexpectedly");
      }

      const [request, response] = requestResult.event.value as readonly [IncomingMessage, ServerResponse];

      if (!request.url) {
        response.statusCode = 400;
        response.end("OAuth callback URL missing");
        continue;
      }

      const url = new URL(request.url, "http://localhost");
      if (url.pathname !== "/callback") {
        response.statusCode = 404;
        response.end("Not found");
        continue;
      }

      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        response.statusCode = 400;
        response.end(`OAuth error: ${error}`);
        throw new Error(`OAuth error: ${error}`);
      }

      if (!code || returnedState !== state) {
        response.statusCode = 400;
        response.end("Missing or mismatched state — please retry.");
        throw new Error("OAuth state mismatch");
      }

      response.statusCode = 200;
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end("<h1>Authorization received</h1><p>You can close this window and return to the terminal.</p>");
      return { code, redirectUri };
    }
  } finally {
    server.close();
    await iterator.return();
  }
}
