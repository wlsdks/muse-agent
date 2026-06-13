import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  resolveOfficialMcpAuthHeaders,
  resolveOfficialMcpCredentialsFile,
  resolveOfficialMcpToken
} from "../src/official-mcp-credentials.js";
import type { MuseEnvironment } from "../src/index.js";

// Point the credentials file at a missing path by default so a real
// ~/.muse/mcp-credentials.json on the test machine can't bleed in.
const missingFileEnv = {
  MUSE_MCP_CREDENTIALS_FILE: "/nonexistent/muse-mcp-creds-test.json"
} as unknown as MuseEnvironment;

describe("resolveOfficialMcpToken — env var (wins) then file fallback", () => {
  it("resolves the GitHub token from GITHUB_MCP_TOKEN", () => {
    const env = { ...missingFileEnv, GITHUB_MCP_TOKEN: "ghp_from_env" } as MuseEnvironment;
    expect(resolveOfficialMcpToken(env, "github")).toBe("ghp_from_env");
  });

  it("resolves the Notion token from NOTION_MCP_TOKEN", () => {
    const env = { ...missingFileEnv, NOTION_MCP_TOKEN: "ntn_from_env" } as MuseEnvironment;
    expect(resolveOfficialMcpToken(env, "notion")).toBe("ntn_from_env");
  });

  it("resolves the Linear token from the auto-derived LINEAR_MCP_TOKEN", () => {
    const env = { ...missingFileEnv, LINEAR_MCP_TOKEN: "lin_api_from_env" } as MuseEnvironment;
    expect(resolveOfficialMcpToken(env, "linear")).toBe("lin_api_from_env");
  });

  it("returns undefined when no env var and no file credential is present", () => {
    expect(resolveOfficialMcpToken(missingFileEnv, "github")).toBeUndefined();
  });

  it("treats a whitespace-only env value as absent", () => {
    const env = { ...missingFileEnv, GITHUB_MCP_TOKEN: "   " } as MuseEnvironment;
    expect(resolveOfficialMcpToken(env, "github")).toBeUndefined();
  });

  it("returns undefined for an unknown preset name (no env key mapped, no file entry)", () => {
    const env = { ...missingFileEnv, GITHUB_MCP_TOKEN: "ghp_x" } as MuseEnvironment;
    expect(resolveOfficialMcpToken(env, "gitlab")).toBeUndefined();
  });
});

describe("resolveOfficialMcpToken — credentials-file fallback (contract-faithful temp file)", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(pathJoin(tmpdir(), "muse-mcp-creds-"));
    file = pathJoin(dir, "mcp-credentials.json");
  });

  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  it("reads providers.github.token from the file when env is absent", () => {
    writeFileSync(file, JSON.stringify({ providers: { github: { token: "ghp_from_file" } } }), "utf8");
    const env = { MUSE_MCP_CREDENTIALS_FILE: file } as unknown as MuseEnvironment;
    expect(resolveOfficialMcpToken(env, "github")).toBe("ghp_from_file");
  });

  it("reads providers.linear.token from the file when env is absent (auto-derived key)", () => {
    writeFileSync(file, JSON.stringify({ providers: { linear: { token: "lin_api_from_file" } } }), "utf8");
    const env = { MUSE_MCP_CREDENTIALS_FILE: file } as unknown as MuseEnvironment;
    expect(resolveOfficialMcpToken(env, "linear")).toBe("lin_api_from_file");
  });

  it("env var WINS over the file value on conflict", () => {
    writeFileSync(file, JSON.stringify({ providers: { github: { token: "ghp_from_file" } } }), "utf8");
    const env = { MUSE_MCP_CREDENTIALS_FILE: file, GITHUB_MCP_TOKEN: "ghp_from_env" } as unknown as MuseEnvironment;
    expect(resolveOfficialMcpToken(env, "github")).toBe("ghp_from_env");
  });

  it("returns undefined when the file has no entry for the preset", () => {
    writeFileSync(file, JSON.stringify({ providers: { notion: { token: "ntn_x" } } }), "utf8");
    const env = { MUSE_MCP_CREDENTIALS_FILE: file } as unknown as MuseEnvironment;
    expect(resolveOfficialMcpToken(env, "github")).toBeUndefined();
  });

  it("tolerates a malformed file (returns undefined, never throws)", () => {
    writeFileSync(file, "{ not json", "utf8");
    const env = { MUSE_MCP_CREDENTIALS_FILE: file } as unknown as MuseEnvironment;
    expect(resolveOfficialMcpToken(env, "github")).toBeUndefined();
  });
});

describe("resolveOfficialMcpAuthHeaders", () => {
  it("returns Authorization: Bearer <token> when a credential resolves", () => {
    const env = { ...missingFileEnv, GITHUB_MCP_TOKEN: "ghp_abc" } as MuseEnvironment;
    expect(resolveOfficialMcpAuthHeaders(env, "github")).toEqual({ Authorization: "Bearer ghp_abc" });
  });

  it("returns undefined (fail-closed) when no credential resolves", () => {
    expect(resolveOfficialMcpAuthHeaders(missingFileEnv, "github")).toBeUndefined();
  });
});

describe("resolveOfficialMcpCredentialsFile", () => {
  it("honors MUSE_MCP_CREDENTIALS_FILE override", () => {
    const env = { MUSE_MCP_CREDENTIALS_FILE: "/custom/creds.json" } as unknown as MuseEnvironment;
    expect(resolveOfficialMcpCredentialsFile(env)).toBe("/custom/creds.json");
  });

  it("defaults to ~/.muse/mcp-credentials.json when unset", () => {
    const resolved = resolveOfficialMcpCredentialsFile({} as MuseEnvironment);
    expect(resolved.endsWith(pathJoin(".muse", "mcp-credentials.json"))).toBe(true);
  });
});
