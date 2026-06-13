import { describe, expect, it } from "vitest";

import { describeOfficialMcpPosture } from "../src/official-mcp-posture.js";
import type { MuseEnvironment } from "../src/index.js";

// Point the credentials file at a missing path so a real
// ~/.muse/mcp-credentials.json on the test machine can't bleed in.
const baseEnv = {
  MUSE_MCP_CREDENTIALS_FILE: "/nonexistent/muse-mcp-posture-test.json"
} as unknown as MuseEnvironment;

const SECRET = "ghp_super_secret_value_should_never_render";

function github(postures: readonly { readonly name: string }[]): { readonly name: string } {
  const found = postures.find((p) => p.name === "github");
  if (!found) throw new Error("github preset missing from posture");
  return found;
}

describe("describeOfficialMcpPosture — audit view per official preset", () => {
  it("reports BOTH curated presets (github + notion) with provenance URLs", () => {
    const postures = describeOfficialMcpPosture(baseEnv);
    const names = postures.map((p) => p.name).sort();
    expect(names).toEqual(["github", "linear", "notion"]);
    for (const p of postures) {
      expect(p.provenanceUrl).toMatch(/^https:\/\//);
    }
  });

  it("Linear posture auto-derives: toggle ON + LINEAR_MCP_TOKEN ⇒ enabled, credentialPresent, allowed, ok", () => {
    const env = {
      ...baseEnv,
      LINEAR_MCP_TOKEN: "lin_api_secret",
      MUSE_LINEAR_MCP_ENABLED: "true"
    } as MuseEnvironment;
    const lin = describeOfficialMcpPosture(env).find((p) => p.name === "linear");
    expect(lin?.enabled).toBe(true);
    expect(lin?.credentialPresent).toBe(true);
    expect(lin?.allowed).toBe(true);
    expect(lin?.status).toBe("ok");
    expect(lin?.provenanceUrl).toContain("linear.app/docs/mcp");
  });

  it("toggle OFF ⇒ preset reported disabled (status ok, not eligible)", () => {
    const postures = describeOfficialMcpPosture(baseEnv);
    const gh = postures.find((p) => p.name === "github");
    expect(gh?.enabled).toBe(false);
    expect(gh?.credentialPresent).toBe(false);
    expect(gh?.status).toBe("ok");
    expect(gh?.detail).toContain("disabled");
  });

  it("toggle ON + credential present ⇒ enabled + credentialPresent:true + allowed + ok", () => {
    const env = { ...baseEnv, GITHUB_MCP_TOKEN: SECRET, MUSE_GITHUB_MCP_ENABLED: "true" } as MuseEnvironment;
    const postures = describeOfficialMcpPosture(env);
    const gh = postures.find((p) => p.name === "github");
    expect(gh?.enabled).toBe(true);
    expect(gh?.credentialPresent).toBe(true);
    expect(gh?.allowed).toBe(true);
    expect(gh?.status).toBe("ok");
    expect(gh?.provenanceUrl).toContain("github");
  });

  it("toggle ON + credential ABSENT ⇒ enabled-but-no-credential (warn, WHY surfaced)", () => {
    const env = { ...baseEnv, MUSE_GITHUB_MCP_ENABLED: "true" } as MuseEnvironment;
    const gh = describeOfficialMcpPosture(env).find((p) => p.name === "github");
    expect(gh?.enabled).toBe(true);
    expect(gh?.credentialPresent).toBe(false);
    expect(gh?.status).toBe("warn");
    expect(gh?.detail).toMatch(/credential/i);
  });

  it("strict allowlist NOT containing the preset ⇒ enabled+credential but BLOCKED (warn)", () => {
    const env = {
      ...baseEnv,
      GITHUB_MCP_TOKEN: SECRET,
      MUSE_GITHUB_MCP_ENABLED: "true",
      MUSE_MCP_ALLOWED_SERVERS: "some-other-server"
    } as MuseEnvironment;
    const gh = describeOfficialMcpPosture(env).find((p) => p.name === "github");
    expect(gh?.enabled).toBe(true);
    expect(gh?.credentialPresent).toBe(true);
    expect(gh?.allowed).toBe(false);
    expect(gh?.status).toBe("warn");
    expect(gh?.detail).toMatch(/allowlist|blocked/i);
  });

  it("strict allowlist CONTAINING the preset ⇒ allowed:true", () => {
    const env = {
      ...baseEnv,
      GITHUB_MCP_TOKEN: SECRET,
      MUSE_GITHUB_MCP_ENABLED: "true",
      MUSE_MCP_ALLOWED_SERVERS: "github,notion"
    } as MuseEnvironment;
    const gh = describeOfficialMcpPosture(env).find((p) => p.name === "github");
    expect(gh?.allowed).toBe(true);
    expect(gh?.status).toBe("ok");
  });

  it("empty/absent allowlist = allow-all ⇒ allowed:true even with a credential", () => {
    const env = { ...baseEnv, GITHUB_MCP_TOKEN: SECRET, MUSE_GITHUB_MCP_ENABLED: "true" } as MuseEnvironment;
    expect(github(describeOfficialMcpPosture(env)) as { allowed?: boolean }).toBeDefined();
    const gh = describeOfficialMcpPosture(env).find((p) => p.name === "github");
    expect(gh?.allowed).toBe(true);
  });

  it("NEVER renders the secret — the token never appears in the serialized posture", () => {
    const env = {
      ...baseEnv,
      GITHUB_MCP_TOKEN: SECRET,
      NOTION_MCP_TOKEN: SECRET,
      LINEAR_MCP_TOKEN: SECRET,
      MUSE_GITHUB_MCP_ENABLED: "true",
      MUSE_NOTION_MCP_ENABLED: "true",
      MUSE_LINEAR_MCP_ENABLED: "true"
    } as MuseEnvironment;
    const postures = describeOfficialMcpPosture(env);
    const serialized = JSON.stringify(postures);
    expect(serialized).not.toContain(SECRET);
    // credential presence is still reported as a boolean
    expect(postures.every((p) => p.credentialPresent === true)).toBe(true);
  });
});
