import { afterEach, describe, expect, it } from "vitest";

import { startOAuthCallbackServer, type OAuthCallbackServer } from "../src/oauth-callback-server.js";

let server: OAuthCallbackServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function hit(port: number, query: string): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port.toString()}/callback${query}`);
  await res.text();
  return res.status;
}

describe("startOAuthCallbackServer", () => {
  it("resolves the code when state matches exactly", async () => {
    server = await startOAuthCallbackServer({ expectedState: "s-good", timeoutMs: 5_000 });
    const status = await hit(server.port, "?code=auth-code-1&state=s-good");
    expect(status).toBe(200);
    expect(await server.waitForCode()).toEqual({ code: "auth-code-1" });
  });

  it("REJECTS with no code and returns 400 on a state mismatch (CSRF guard)", async () => {
    server = await startOAuthCallbackServer({ expectedState: "s-real", timeoutMs: 5_000 });
    const status = await hit(server.port, "?code=attacker-code&state=s-wrong");
    expect(status).toBe(400);
    await expect(server.waitForCode()).rejects.toThrow(/state mismatch/i);
  });

  it("REJECTS with no code when state is absent (CSRF guard)", async () => {
    server = await startOAuthCallbackServer({ expectedState: "s-real", timeoutMs: 5_000 });
    const status = await hit(server.port, "?code=attacker-code");
    expect(status).toBe(400);
    await expect(server.waitForCode()).rejects.toThrow(/state mismatch/i);
  });

  it("rejects when the AS returns an ?error=", async () => {
    server = await startOAuthCallbackServer({ expectedState: "s", timeoutMs: 5_000 });
    const status = await hit(server.port, "?error=access_denied&error_description=user+said+no");
    expect(status).toBe(400);
    await expect(server.waitForCode()).rejects.toThrow(/access_denied/);
  });

  it("rejects on timeout", async () => {
    server = await startOAuthCallbackServer({ expectedState: "s", timeoutMs: 30 });
    await expect(server.waitForCode()).rejects.toThrow(/timed out/i);
  });

  it("ignores non-callback probes (favicon) without settling", async () => {
    server = await startOAuthCallbackServer({ expectedState: "s-good", timeoutMs: 5_000 });
    const favicon = await fetch(`http://127.0.0.1:${server.port.toString()}/favicon.ico`);
    await favicon.text();
    expect(favicon.status).toBe(404);
    // The real callback still resolves afterwards — the probe did not settle it.
    await hit(server.port, "?code=real-code&state=s-good");
    expect(await server.waitForCode()).toEqual({ code: "real-code" });
  });
});
