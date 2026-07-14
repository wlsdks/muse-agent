import { AttunementStoreError } from "@muse/attunement";
import { describe, expect, it } from "vitest";

import {
  resolveMcpResourceArtifact,
  serverFromProviderId,
  validateMcpResource,
  type McpToolCaller
} from "./attunement-mcp-resource.js";

const CANNED_ISSUE = {
  body: "The reconciler drops updates under concurrent renders.",
  number: 1,
  state: "open",
  title: "Fix the render loop"
};

/**
 * Contract-faithful fake: returns the canned GitHub issue only for the exact
 * known coordinate and throws for anything else — the behaviour a real
 * get_issue call has for a missing resource.
 */
function fakeCaller(): { readonly caller: McpToolCaller; readonly calls: Array<{ server: string; tool: string; args: Record<string, unknown> }> } {
  const calls: Array<{ server: string; tool: string; args: Record<string, unknown> }> = [];
  const caller: McpToolCaller = async (server, tool, args) => {
    calls.push({ args, server, tool });
    if (server === "github" && tool === "get_issue" && args["owner"] === "facebook" && args["repo"] === "react" && args["issue_number"] === 1) {
      return CANNED_ISSUE;
    }
    throw new Error("resource not found");
  };
  return { caller, calls };
}

describe("attunement MCP resource adapter", () => {
  it("validates a known github issue into its canonical id + provider", async () => {
    const { caller, calls } = fakeCaller();
    const result = await validateMcpResource("github", "facebook/react/issues/1", caller);
    expect(result).toEqual({ artifactId: "facebook/react/issues/1", providerId: "mcp:github" });
    expect(calls).toEqual([{ args: { issue_number: 1, owner: "facebook", repo: "react" }, server: "github", tool: "get_issue" }]);
  });

  it("maps a pull request to get_pull_request", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const caller: McpToolCaller = async (_server, tool, args) => {
      calls.push({ args, tool });
      return { title: "Add the adapter" };
    };
    const result = await validateMcpResource("github", "facebook/react/pull/42", caller);
    expect(result.artifactId).toBe("facebook/react/pull/42");
    expect(calls[0]).toEqual({ args: { owner: "facebook", pullNumber: 42, repo: "react" }, tool: "get_pull_request" });
  });

  it("fails closed with no caller (connect the server first)", async () => {
    await expect(validateMcpResource("github", "facebook/react/issues/1", undefined))
      .rejects.toThrow("connect the MCP server 'github' first");
  });

  it("fails closed on a malformed resource id (no guessing owner/repo)", async () => {
    const { caller } = fakeCaller();
    await expect(validateMcpResource("github", "issues/1", caller)).rejects.toBeInstanceOf(AttunementStoreError);
    await expect(validateMcpResource("github", "issues/1", caller)).rejects.toThrow("<owner>/<repo>/issues/<n>");
  });

  it("fails closed for an unknown resource — no link", async () => {
    const { caller } = fakeCaller();
    await expect(validateMcpResource("github", "facebook/react/issues/999", caller))
      .rejects.toThrow("could not read resource");
  });

  it("fails closed for a server with no registered adapter", async () => {
    const { caller } = fakeCaller();
    await expect(validateMcpResource("gitlab", "facebook/react/issues/1", caller))
      .rejects.toThrow("no resource adapter is registered for MCP server 'gitlab'");
  });

  it("fails closed when the tool result carries no title (not found)", async () => {
    const caller: McpToolCaller = async () => ({ message: "Not Found" });
    await expect(validateMcpResource("github", "facebook/react/issues/1", caller))
      .rejects.toThrow("was not found on MCP server 'github'");
  });

  it("resolves a reachable resource into untrusted evidence at display time", async () => {
    const { caller } = fakeCaller();
    const resolved = await resolveMcpResourceArtifact("github", "facebook/react/issues/1", "context", caller);
    expect(resolved).toMatchObject({
      artifactId: "facebook/react/issues/1",
      artifactType: "resource",
      providerId: "mcp:github",
      summary: "The reconciler drops updates under concurrent renders.",
      title: "Fix the render loop"
    });
  });

  it("returns undefined (→ unavailable) when the server is unreachable, never a fabricated title", async () => {
    const caller: McpToolCaller = async () => { throw new Error("ECONNREFUSED"); };
    const resolved = await resolveMcpResourceArtifact("github", "facebook/react/issues/1", "context", caller);
    expect(resolved).toBeUndefined();
  });

  it("returns undefined at display time with no caller or unknown server", async () => {
    expect(await resolveMcpResourceArtifact("github", "facebook/react/issues/1", "context", undefined)).toBeUndefined();
    const { caller } = fakeCaller();
    expect(await resolveMcpResourceArtifact("gitlab", "facebook/react/issues/1", "context", caller)).toBeUndefined();
  });

  it("parses / rejects mcp provider ids", () => {
    expect(serverFromProviderId("mcp:github")).toBe("github");
    expect(() => serverFromProviderId("local")).toThrow("resource provider must be 'mcp:<server>'");
  });
});
