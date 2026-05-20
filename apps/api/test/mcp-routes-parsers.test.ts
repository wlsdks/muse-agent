import { describe, expect, it } from "vitest";

import { parseMcpSecurityPolicyInput } from "../src/mcp-routes-parsers.js";

describe("parseMcpSecurityPolicyInput allowlist caps", () => {
  it("accepts allowlist arrays at or below the 500-entry cap (symmetric for both fields)", () => {
    const result = parseMcpSecurityPolicyInput({
      allowedServerNames: Array.from({ length: 500 }, (_, i) => `srv-${i.toString()}`),
      allowedStdioCommands: Array.from({ length: 500 }, (_, i) => `cmd-${i.toString()}`)
    });
    expect(result.ok).toBe(true);
  });

  it("rejects allowedServerNames > 500 (already enforced)", () => {
    const result = parseMcpSecurityPolicyInput({
      allowedServerNames: Array.from({ length: 501 }, (_, i) => `srv-${i.toString()}`)
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/allowedServerNames must not exceed 500/u);
  });

  it("rejects allowedStdioCommands > 500 (parallel cap — the sibling-asymmetry this goal closes)", () => {
    const result = parseMcpSecurityPolicyInput({
      allowedStdioCommands: Array.from({ length: 501 }, (_, i) => `cmd-${i.toString()}`)
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/allowedStdioCommands must not exceed 500/u);
  });

  it("returns INVALID_MCP_SECURITY_POLICY on a non-object body", () => {
    const result = parseMcpSecurityPolicyInput("not an object");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_MCP_SECURITY_POLICY");
  });
});
