import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerEmailStatusRoutes } from "../src/email-status-routes.js";
import { buildServer } from "../src/server.js";
import { createAuthService } from "./helpers/test-auth.js";

const CREDENTIAL_KEY = "email-status-test-key-aaaaaaaaaaaaaa";

/** Encrypts a `{tokens, gmail?}` payload the SAME way `@muse/stores`'s encrypted-credentials.ts does — a fixture credentials.json for the route to read. */
async function writeCredentialsFixture(dir: string, payload: unknown, credentialKey = CREDENTIAL_KEY): Promise<void> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(credentialKey, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  await writeFile(join(dir, "credentials.json"), `${JSON.stringify({
    algorithm: "aes-256-gcm",
    data: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    salt: salt.toString("base64"),
    tag: tag.toString("base64"),
    version: 1
  }, null, 2)}\n`, "utf8");
}

describe("GET /api/email/status", () => {
  it("not configured on a fresh box (no env token, no credentials file)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-email-status-"));
    const server = Fastify({ logger: false });
    registerEmailStatusRoutes(server, { credentialsDir: dir, env: {} });
    const response = await server.inject({ method: "GET", url: "/api/email/status" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ configured: false, method: null });
  });

  it("reports method:'env' when MUSE_GMAIL_TOKEN is set, WITHOUT ever echoing the token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-email-status-"));
    const server = Fastify({ logger: false });
    registerEmailStatusRoutes(server, { credentialsDir: dir, env: { MUSE_GMAIL_TOKEN: "ya29.super-secret-token" } });
    const response = await server.inject({ method: "GET", url: "/api/email/status" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ configured: true, method: "env" });
    expect(response.body).not.toContain("ya29.super-secret-token");
  });

  it("reports method:'oauth' + hasRefreshToken from a decrypted Gmail credential fixture, WITHOUT echoing any secret", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-email-status-"));
    await writeCredentialsFixture(dir, {
      gmail: {
        clientId: "client-id.apps.googleusercontent.com",
        clientSecret: "top-secret-client-secret",
        refreshToken: "top-secret-refresh-token"
      },
      tokens: {}
    });
    const server = Fastify({ logger: false });
    registerEmailStatusRoutes(server, { credentialsDir: dir, env: { MUSE_CREDENTIAL_KEY: CREDENTIAL_KEY } });
    const response = await server.inject({ method: "GET", url: "/api/email/status" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ configured: true, hasRefreshToken: true, method: "oauth" });
    expect(response.body).not.toContain("top-secret-client-secret");
    expect(response.body).not.toContain("top-secret-refresh-token");
    expect(response.body).not.toContain("client-id.apps.googleusercontent.com");
  });

  it("reports method:'imap' from a decrypted App Password credential fixture, WITHOUT echoing the password", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-email-status-"));
    await writeCredentialsFixture(dir, {
      emailImap: { appPassword: "top-secret-app-password", email: "user@gmail.com" },
      tokens: {}
    });
    const server = Fastify({ logger: false });
    registerEmailStatusRoutes(server, { credentialsDir: dir, env: { MUSE_CREDENTIAL_KEY: CREDENTIAL_KEY } });
    const response = await server.inject({ method: "GET", url: "/api/email/status" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ configured: true, method: "imap" });
    expect(response.body).not.toContain("top-secret-app-password");
  });

  it("an OAuth credential takes priority over an App Password credential when both are present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-email-status-"));
    await writeCredentialsFixture(dir, {
      emailImap: { appPassword: "pw", email: "user@gmail.com" },
      gmail: { clientId: "c", clientSecret: "s", refreshToken: "r" },
      tokens: {}
    });
    const server = Fastify({ logger: false });
    registerEmailStatusRoutes(server, { credentialsDir: dir, env: { MUSE_CREDENTIAL_KEY: CREDENTIAL_KEY } });
    const response = await server.inject({ method: "GET", url: "/api/email/status" });
    expect(response.json()).toMatchObject({ configured: true, method: "oauth" });
  });

  it("env token takes priority over a stored OAuth credential when both are present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-email-status-"));
    await writeCredentialsFixture(dir, {
      gmail: { clientId: "c", clientSecret: "s", refreshToken: "r" },
      tokens: {}
    });
    const server = Fastify({ logger: false });
    registerEmailStatusRoutes(server, { credentialsDir: dir, env: { MUSE_GMAIL_TOKEN: "raw-token" } });
    const response = await server.inject({ method: "GET", url: "/api/email/status" });
    expect(response.json()).toMatchObject({ configured: true, method: "env" });
  });

  it("a corrupted / undecryptable credentials.json degrades to configured:false — never a 500", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-email-status-"));
    await writeFile(join(dir, "credentials.json"), "{not-json", "utf8");
    const server = Fastify({ logger: false });
    registerEmailStatusRoutes(server, { credentialsDir: dir, env: {} });
    const response = await server.inject({ method: "GET", url: "/api/email/status" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ configured: false, method: null });
  });

  it("an absent credentials.json (no file at all) degrades to configured:false — never a 500", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-email-status-empty-"));
    const server = Fastify({ logger: false });
    registerEmailStatusRoutes(server, { credentialsDir: dir, env: {} });
    const response = await server.inject({ method: "GET", url: "/api/email/status" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ configured: false, method: null });
  });
});

describe("GET /api/email/status — auth gate", () => {
  it("401s without a bearer token when requireAuth is on, and 200s with a valid one", async () => {
    const authService = createAuthService();
    const registered = authService.register({ email: "owner@example.com", name: "Owner", password: "password-1" });
    const dir = mkdtempSync(join(tmpdir(), "muse-email-status-auth-"));
    const server = buildServer({
      authService,
      emailCredentialsDir: dir,
      env: {},
      logger: false,
      requireAuth: true
    });

    const anon = await server.inject({ method: "GET", url: "/api/email/status" });
    expect(anon.statusCode).toBe(401);

    const authed = await server.inject({
      headers: { authorization: `Bearer ${registered.token}` },
      method: "GET",
      url: "/api/email/status"
    });
    expect(authed.statusCode).toBe(200);
    expect(authed.json()).toEqual({ configured: false, method: null });
  });
});
