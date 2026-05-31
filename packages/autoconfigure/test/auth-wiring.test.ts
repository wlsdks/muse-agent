import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MuseDatabase } from "@muse/db";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAuthService } from "../src/auth-wiring.js";
import type { MuseEnvironment } from "../src/index.js";

const SECRET = "x".repeat(40); // >= 32 chars
const env = (over: Record<string, string | undefined> = {}): MuseEnvironment => over as unknown as MuseEnvironment;

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "muse-auth-wiring-")); });
afterEach(async () => { await rm(dir, { force: true, recursive: true }); });
const secretsFile = async (value: unknown): Promise<string> => {
  const f = join(dir, "auth-secrets.json");
  await writeFile(f, typeof value === "string" ? value : JSON.stringify(value), "utf8");
  return f;
};

describe("createAuthService — fail-open JWT secret wiring", () => {
  it("returns undefined when NO secret is configured (auth stays disabled, not crashed)", () => {
    expect(createAuthService(env(), undefined)).toBeUndefined();
  });

  it("builds an in-memory Auth from an env secret when there is no db", () => {
    const auth = createAuthService(env({ MUSE_AUTH_JWT_SECRET: SECRET }), undefined);
    expect(auth?.constructor.name).toBe("Auth");
  });

  it("builds an AsyncAuth (Kysely-backed) when a db is provided", () => {
    const auth = createAuthService(env({ MUSE_AUTH_JWT_SECRET: SECRET }), {} as Kysely<MuseDatabase>);
    expect(auth?.constructor.name).toBe("AsyncAuth");
  });

  it("reads the secret from the rotation file (MUSE_AUTH_SECRETS_FILE) even with NO env secret", async () => {
    const file = await secretsFile({ current: SECRET, previous: [] });
    expect(createAuthService(env({ MUSE_AUTH_SECRETS_FILE: file }), undefined)).toBeDefined();
  });

  it("FAIL-OPEN: a corrupt secrets file falls through to the env secret (a bad file can't lock the operator out)", async () => {
    const file = await secretsFile("{ corrupt json");
    // corrupt file + no env secret → no auth (env-only path is empty)
    expect(createAuthService(env({ MUSE_AUTH_SECRETS_FILE: file }), undefined)).toBeUndefined();
    // corrupt file + env secret → falls through to env → defined
    expect(createAuthService(env({ MUSE_AUTH_JWT_SECRET: SECRET, MUSE_AUTH_SECRETS_FILE: file }), undefined)).toBeDefined();
  });

  it("rejects a too-short current secret (< 32 chars) in the rotation file", async () => {
    const file = await secretsFile({ current: "tooshort" });
    expect(createAuthService(env({ MUSE_AUTH_SECRETS_FILE: file }), undefined)).toBeUndefined();
  });
});
