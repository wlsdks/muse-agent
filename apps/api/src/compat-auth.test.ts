import type { LoginResult } from "@muse/auth";
import type { FastifyReply } from "fastify";
import { describe, expect, it } from "vitest";

import type { CompatibilityRouteOptions } from "./compat-routes.js";
import { errorMessage, parseAuthCredentials, requireAuthService, toCompatAuthResponse, toCompatUserResponse } from "./compat-auth.js";

// Direct coverage for the compat auth helpers (untested) — security-relevant.
// parseAuthCredentials is the auth input gate (register is stricter than login),
// and toCompatUserResponse must expose ONLY id/email/name — never the password
// hash/salt (no credential leak to the client).

const reply = (): { r: FastifyReply; captured: { status: number | null; payload: unknown } } => {
  const captured = { payload: null as unknown, status: null as number | null };
  return { captured, r: { status: (c: number) => { captured.status = c; return { send: (p: unknown) => { captured.payload = p; } }; } } as unknown as FastifyReply };
};

describe("parseAuthCredentials", () => {
  it("accepts a valid login (name defaults to the email) and rejects missing/blank fields", () => {
    const ok = parseAuthCredentials({ email: "a@b.com", password: "pw" }, "login");
    expect(ok.ok && ok.value).toEqual({ email: "a@b.com", name: "a@b.com", password: "pw" });
    expect(parseAuthCredentials("not-an-object", "login").ok).toBe(false);
    expect(parseAuthCredentials({ email: "  ", password: "pw" }, "login").ok).toBe(false);
    expect(parseAuthCredentials({ email: "a@b.com", password: "" }, "login").ok).toBe(false);
  });

  it("enforces the stricter register rules: email format, password ≥ 8, non-empty name", () => {
    expect(parseAuthCredentials({ email: "notanemail", name: "X", password: "longenough" }, "register"))
      .toMatchObject({ error: { message: "Invalid email format" }, ok: false });
    expect(parseAuthCredentials({ email: "a@b.com", name: "X", password: "short" }, "register"))
      .toMatchObject({ error: { message: "Password must be at least 8 characters" }, ok: false });
    expect(parseAuthCredentials({ email: "a@b.com", name: " ", password: "longenough" }, "register"))
      .toMatchObject({ error: { message: "Registration requires a non-empty name" }, ok: false });
    const ok = parseAuthCredentials({ email: "a@b.com", name: "Jin", password: "longenough" }, "register");
    expect(ok.ok && ok.value).toEqual({ email: "a@b.com", name: "Jin", password: "longenough" });
  });
});

describe("toCompatUserResponse / toCompatAuthResponse", () => {
  it("exposes ONLY id/email/name — never the password hash or salt", () => {
    const user = { email: "a@b.com", id: "u1", name: "Jin", passwordHash: "SECRET", salt: "S" } as unknown as LoginResult["user"];
    const response = toCompatUserResponse(user);
    expect(response).toEqual({ email: "a@b.com", id: "u1", name: "Jin" });
    expect(JSON.stringify(response)).not.toContain("SECRET"); // no credential leak

    const auth = toCompatAuthResponse({ token: "tok", user } as unknown as LoginResult);
    expect(auth).toEqual({ error: null, token: "tok", user: { email: "a@b.com", id: "u1", name: "Jin" } });
    expect(JSON.stringify(auth)).not.toContain("SECRET");
  });
});

describe("requireAuthService / errorMessage", () => {
  it("requireAuthService 404s with AUTH_UNAVAILABLE when no service, else returns it", () => {
    const { captured, r } = reply();
    expect(requireAuthService({} as CompatibilityRouteOptions, r)).toBeUndefined();
    expect(captured.status).toBe(404);
    expect(captured.payload).toMatchObject({ code: "AUTH_UNAVAILABLE" });

    const service = { id: "auth" } as unknown as CompatibilityRouteOptions["authService"];
    expect(requireAuthService({ authService: service } as CompatibilityRouteOptions, reply().r)).toBe(service);
  });

  it("errorMessage preserves Error and string messages", () => {
    expect(errorMessage(new Error("boom"), "fb")).toBe("boom");
    expect(errorMessage("not an error", "fb")).toBe("not an error");
  });
});
