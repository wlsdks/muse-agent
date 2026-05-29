import { describe, expect, it } from "vitest";

import {
  applyCompatWebContractHeaders,
  applyCorsHeaders,
  createOpenApiDocument,
  currentCompatApiVersion,
  headerValue,
  isPublicRequest,
  routeMethods,
  supportedCompatApiVersions,
  toSpringPathTemplate
} from "../src/server-http-plumbing.js";

function fakeReply() {
  const headers: Record<string, string> = {};
  return { headers, reply: { header(name: string, value: string) { headers[name] = value; } } };
}

describe("toSpringPathTemplate", () => {
  it("rewrites :params to {params} and leaves plain paths unchanged", () => {
    expect(toSpringPathTemplate("/api/users/:id/posts/:postId")).toBe("/api/users/{id}/posts/{postId}");
    expect(toSpringPathTemplate("/no/params")).toBe("/no/params");
  });
});

describe("applyCompatWebContractHeaders", () => {
  it("sets the fixed security + version headers", () => {
    const { headers, reply } = fakeReply();
    applyCompatWebContractHeaders("/api/notes", undefined, reply);
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["X-Muse-Api-Version"]).toBe("1");
    expect(headers["X-Muse-Api-Supported-Versions"]).toBe("1");
    expect(headers["Content-Security-Policy"]).toBe("default-src 'self'");
  });

  it("generates a UUID X-Request-ID when none is supplied, or echoes the trimmed header", () => {
    const a = fakeReply();
    applyCompatWebContractHeaders("/x", undefined, a.reply);
    expect(a.headers["X-Request-ID"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
    const b = fakeReply();
    applyCompatWebContractHeaders("/x", "  given-id  ", b.reply);
    expect(b.headers["X-Request-ID"]).toBe("given-id");
  });

  it("relaxes the CSP for swagger paths only", () => {
    const sw = fakeReply();
    applyCompatWebContractHeaders("/swagger-ui/index.html", undefined, sw.reply);
    expect(sw.headers["Content-Security-Policy"]).toContain("'unsafe-inline'");
  });

  it("sets Cache-Control no-store only on sensitive (chat/auth) paths", () => {
    for (const path of ["/api/chat", "/api/chat/stream", "/api/auth", "/api/auth/login"]) {
      const { headers, reply } = fakeReply();
      applyCompatWebContractHeaders(path, undefined, reply);
      expect(headers["Cache-Control"]).toBe("no-store");
    }
    const { headers, reply } = fakeReply();
    applyCompatWebContractHeaders("/api/notes", undefined, reply);
    expect(headers["Cache-Control"]).toBeUndefined();
  });
});

describe("applyCorsHeaders", () => {
  it("does nothing without options, a disallowed origin, or no origin header", () => {
    const noOpts = fakeReply();
    applyCorsHeaders(undefined, "http://localhost:5173", noOpts.reply);
    expect(Object.keys(noOpts.headers)).toHaveLength(0);

    const disallowed = fakeReply();
    applyCorsHeaders({}, "http://evil.com", disallowed.reply);
    expect(Object.keys(disallowed.headers)).toHaveLength(0);

    const noOrigin = fakeReply();
    applyCorsHeaders({}, undefined, noOrigin.reply);
    expect(Object.keys(noOrigin.headers)).toHaveLength(0);
  });

  it("echoes a default-allowed localhost origin with default methods/headers", () => {
    const { headers, reply } = fakeReply();
    applyCorsHeaders({}, "http://localhost:5173", reply);
    expect(headers["Access-Control-Allow-Origin"]).toBe("http://localhost:5173");
    expect(headers.Vary).toBe("Origin");
    expect(headers["Access-Control-Allow-Methods"]).toBe("GET,POST,PUT,PATCH,DELETE,OPTIONS");
    expect(headers["Access-Control-Allow-Headers"]).toBe("authorization,content-type,x-request-id,x-muse-api-version");
  });

  it("allows any origin under a wildcard, adds credentials, and clamps maxAge to a non-negative int", () => {
    const { headers, reply } = fakeReply();
    applyCorsHeaders({ allowCredentials: true, allowedOrigins: ["*"], maxAgeSeconds: 60.9 }, "http://anything.com", reply);
    expect(headers["Access-Control-Allow-Origin"]).toBe("http://anything.com");
    expect(headers["Access-Control-Allow-Credentials"]).toBe("true");
    expect(headers["Access-Control-Max-Age"]).toBe("60");
  });

  it("clamps a negative maxAge to 0 and omits credentials by default", () => {
    const { headers, reply } = fakeReply();
    applyCorsHeaders({ allowedOrigins: ["http://x.com"], maxAgeSeconds: -5 }, "http://x.com", reply);
    expect(headers["Access-Control-Max-Age"]).toBe("0");
    expect(headers["Access-Control-Allow-Credentials"]).toBeUndefined();
  });
});

describe("version + small helpers", () => {
  it("reports the current and supported compat API versions", () => {
    expect(currentCompatApiVersion()).toBe("1");
    expect(supportedCompatApiVersions()).toEqual(["1"]);
  });

  it("headerValue takes the first of an array, passes a string, and undefined through", () => {
    expect(headerValue(["a", "b"])).toBe("a");
    expect(headerValue("s")).toBe("s");
    expect(headerValue(undefined)).toBeUndefined();
  });

  it("routeMethods wraps a string and passes an array through", () => {
    expect(routeMethods("GET")).toEqual(["GET"]);
    expect(routeMethods(["GET", "POST"])).toEqual(["GET", "POST"]);
  });
});

describe("createOpenApiDocument", () => {
  it("builds a 3.1.0 doc with sorted paths, head/options filtered, sorted methods, and summaries", () => {
    const doc = createOpenApiDocument(
      new Map([
        ["/b", new Set(["get", "head", "options"])],
        ["/a", new Set(["post", "get"])]
      ])
    );
    expect(doc.openapi).toBe("3.1.0");
    expect((doc.info as { title: string }).title).toBe("Muse API");
    const paths = doc.paths as Record<string, Record<string, { summary: string; responses: unknown }>>;
    expect(Object.keys(paths)).toEqual(["/a", "/b"]);
    expect(Object.keys(paths["/b"]!)).toEqual(["get"]);
    expect(Object.keys(paths["/a"]!)).toEqual(["get", "post"]);
    expect(paths["/a"]!.get!.summary).toBe("GET /a");
    expect(paths["/a"]!.get!.responses).toEqual({ "200": { description: "OK" } });
  });
});

describe("isPublicRequest — the auth-bypass allowlist", () => {
  it.each([
    ["GET", "/health"],
    ["GET", "/health?probe=1"],
    ["GET", "/spec"],
    ["GET", "/v3/api-docs"],
    ["GET", "/api/openapi.json"],
    ["GET", "/.well-known/agent-card.json"],
    ["GET", "/api/muse/runtime"],
    ["GET", "/api/muse/loopback"],
    ["POST", "/health"]
  ])("treats %s %s as public", (method, url) => {
    expect(isPublicRequest(method, url)).toBe(true);
  });

  it.each([
    ["POST", "/auth/login"],
    ["POST", "/auth/register"],
    ["POST", "/api/auth/login"],
    ["POST", "/api/auth/register"],
    ["POST", "/api/error-report"]
  ])("treats %s %s as public (POST-gated auth route)", (method, url) => {
    expect(isPublicRequest(method, url)).toBe(true);
  });

  it.each([
    ["GET", "/auth/login"],
    ["GET", "/api/auth/register"],
    ["GET", "/api/chat"],
    ["POST", "/api/chat"],
    ["GET", "/api/notes"]
  ])("requires auth for %s %s", (method, url) => {
    expect(isPublicRequest(method, url)).toBe(false);
  });
});
