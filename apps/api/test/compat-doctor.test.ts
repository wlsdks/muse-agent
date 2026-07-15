import { describe, expect, it } from "vitest";

import { adminDiagnostic } from "../src/compat-doctor.js";
import type { CompatibilityRouteOptions } from "../src/compat-routes.js";
import type { FastifyReply, FastifyRequest } from "fastify";

function fakeReply() {
  const headers: Record<string, string> = {};
  const reply = { header(name: string, value: string) { headers[name] = value; return reply; } };
  return { headers, reply: reply as unknown as FastifyReply };
}
const request = (accept?: string): FastifyRequest => ({ headers: accept ? { accept } : {} }) as unknown as FastifyRequest;
const options = (over: Record<string, unknown> = {}): CompatibilityRouteOptions =>
  ({ requireAuthenticated: () => true, ...over }) as unknown as CompatibilityRouteOptions;
const configured = () =>
  options({
    admin: { cache: { responseCache: {} }, observability: { traceSink: {} } },
    historyStore: {},
    mcp: { manager: {} },
    modelProvider: {},
    scheduler: { service: {} }
  });

describe("adminDiagnostic — auth gate", () => {
  it("returns the reply without a report when authentication fails", async () => {
    const { reply } = fakeReply();
    let authChecked = false;
    const opts = options({ requireAuthenticated: () => { authChecked = true; return false; } });
    const result = await adminDiagnostic(request(), reply, opts, "report");
    expect(authChecked).toBe(true);
    expect(result).toBe(reply);
  });
});

describe("adminDiagnostic — report mode (json)", () => {
  it("builds six sections, SKIPPED for unconfigured services and OK for db/mcp, and sets x-doctor-status", async () => {
    const { headers, reply } = fakeReply();
    const report = (await adminDiagnostic(request(), reply, options(), "report")) as { sections: { name: string; status: string }[]; generatedAt: string };
    expect(report.sections).toHaveLength(6);
    const byName = Object.fromEntries(report.sections.map((s) => [s.name, s.status]));
    expect(byName).toEqual({
      Database: "OK",
      "Dynamic Scheduler": "SKIPPED",
      "MCP Live Health": "OK",
      "Model Provider": "SKIPPED",
      "Observability Assets": "SKIPPED",
      "Response Cache": "SKIPPED"
    });
    expect(typeof report.generatedAt).toBe("string");
    expect(headers["x-doctor-status"]).toBe("OK");
  });

  it("reports every section OK when all services are configured", async () => {
    const { reply } = fakeReply();
    const report = (await adminDiagnostic(request(), reply, configured(), "report")) as { sections: { status: string }[] };
    expect(report.sections.every((s) => s.status === "OK")).toBe(true);
  });
});

describe("adminDiagnostic — summary mode", () => {
  it("returns a json summary with allHealthy, status, and a counts string", async () => {
    const { reply } = fakeReply();
    const summary = (await adminDiagnostic(request(), reply, options(), "summary")) as Record<string, unknown>;
    expect(summary).toMatchObject({ allHealthy: true, status: "OK", summary: "6 섹션 — OK 2, SKIPPED 4" });
    expect(typeof summary.generatedAt).toBe("string");
  });

  it("renders a text/plain summary line under an Accept: text/plain", async () => {
    const { headers, reply } = fakeReply();
    const summary = (await adminDiagnostic(request("text/plain"), reply, options(), "summary")) as string;
    expect(headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(summary.split(" | ")[0]).toBe("6 섹션 — OK 2, SKIPPED 4");
    expect(summary).toContain("정상");
  });

  it("renders a markdown summary under an Accept: text/markdown", async () => {
    const { headers, reply } = fakeReply();
    const summary = (await adminDiagnostic(request("text/markdown"), reply, options(), "summary")) as string;
    expect(headers["content-type"]).toBe("text/markdown; charset=utf-8");
    expect(summary.startsWith("*[OK]*")).toBe(true);
  });
});

describe("adminDiagnostic — report formats", () => {
  it("renders a human-readable text report with section short codes", async () => {
    const { headers, reply } = fakeReply();
    const text = (await adminDiagnostic(request("text/plain"), reply, options(), "report")) as string;
    expect(headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(text).toContain("=== Muse Doctor Report ===");
    expect(text).toContain("전체 상태: 정상");
    expect(text).toContain("[SKIP]");
  });

  it("renders a markdown report", async () => {
    const { headers, reply } = fakeReply();
    const md = (await adminDiagnostic(request("text/x-markdown"), reply, options(), "report")) as string;
    expect(headers["content-type"]).toBe("text/markdown; charset=utf-8");
    expect(md.startsWith("*Muse Doctor Report*")).toBe(true);
  });

  it("defaults to a json object report when Accept is not text/markdown", async () => {
    const { reply } = fakeReply();
    const report = await adminDiagnostic(request("application/json"), reply, options(), "report");
    expect(typeof report).toBe("object");
    expect(Array.isArray((report as { sections: unknown }).sections)).toBe(true);
  });
});
