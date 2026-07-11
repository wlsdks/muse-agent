import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryMcpServerStore } from "@muse/mcp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ConfigurationError,
  diagnoseExternalMcpConfig,
  diagnoseExternalMcpConfigFile,
  loadExternalMcpConfig,
  parseExternalMcpConfig,
  resolveExternalMcpConfigFile,
  seedExternalMcpServers
} from "../src/index.js";

describe("parseExternalMcpConfig", () => {
  it("parses an stdio entry into an McpServerInput", () => {
    const entries = parseExternalMcpConfig(JSON.stringify({
      mcpServers: {
        filesystem: {
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/notes"],
          command: "npx",
          env: { LOG_LEVEL: "info" }
        }
      }
    }));

    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.name).toBe("filesystem");
    expect(entry.transportType).toBe("stdio");
    expect(entry.autoConnect).toBe(true);
    expect(entry.config).toMatchObject({
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/notes"],
      command: "npx",
      env: { LOG_LEVEL: "info" }
    });
  });

  it("parses a streamable URL entry and defaults transport to streamable when url is given", () => {
    const entries = parseExternalMcpConfig(JSON.stringify({
      mcpServers: {
        github: {
          headers: { Authorization: "Bearer token" },
          url: "https://api.githubcopilot.com/mcp/"
        }
      }
    }));

    expect(entries[0]).toMatchObject({
      autoConnect: true,
      config: {
        headers: { Authorization: "Bearer token" },
        url: "https://api.githubcopilot.com/mcp/"
      },
      name: "github",
      transportType: "streamable"
    });
  });

  it("honors an explicit transport: 'sse' override", () => {
    const entries = parseExternalMcpConfig(JSON.stringify({
      mcpServers: {
        analytics: {
          transport: "sse",
          url: "https://example.com/mcp/sse"
        }
      }
    }));

    expect(entries[0]?.transportType).toBe("sse");
  });

  it("skips entries with disabled: true without throwing", () => {
    const entries = parseExternalMcpConfig(JSON.stringify({
      mcpServers: {
        active: { command: "node", args: ["a.js"] },
        retired: { command: "node", args: ["b.js"], disabled: true }
      }
    }));

    expect(entries.map((entry) => entry.name)).toEqual(["active"]);
  });

  it("returns [] when mcpServers is missing", () => {
    expect(parseExternalMcpConfig("{}")).toEqual([]);
  });

  it("rejects an entry with neither command nor url", () => {
    expect(() => parseExternalMcpConfig(JSON.stringify({
      mcpServers: { ghost: { description: "no transport given" } }
    }))).toThrow(ConfigurationError);
  });

  it("rejects an explicit transport value that is not streamable or sse", () => {
    expect(() => parseExternalMcpConfig(JSON.stringify({
      mcpServers: { weird: { transport: "carrier-pigeon", url: "https://example.com" } }
    }))).toThrow(/streamable.*sse/);
  });

  it("rejects malformed JSON with ConfigurationError", () => {
    expect(() => parseExternalMcpConfig("{not json")).toThrow(ConfigurationError);
  });

  it("rejects non-string values inside env / headers maps", () => {
    expect(() => parseExternalMcpConfig(JSON.stringify({
      mcpServers: { fs: { command: "node", env: { TOKEN: 123 } } }
    }))).toThrow(/env\.TOKEN/);
  });

  it("rejects a root that is valid JSON but not an object (array / primitive)", () => {
    // untrusted config must fail LOUD, never silently parse to nothing.
    expect(() => parseExternalMcpConfig("[1,2,3]")).toThrow(/must be a JSON object/);
    expect(() => parseExternalMcpConfig("42")).toThrow(/must be a JSON object/);
  });

  it("rejects an mcpServers that is present but not an object", () => {
    expect(() => parseExternalMcpConfig(JSON.stringify({ mcpServers: "x" }))).toThrow(/mcpServers must be a JSON object/);
    expect(() => parseExternalMcpConfig(JSON.stringify({ mcpServers: [1] }))).toThrow(/mcpServers must be a JSON object/);
  });

  it("treats a null mcpServers as empty (back-compat with missing)", () => {
    expect(parseExternalMcpConfig(JSON.stringify({ mcpServers: null }))).toEqual([]);
  });

  it("rejects an empty (whitespace) server name and a non-object entry", () => {
    expect(() => parseExternalMcpConfig(JSON.stringify({ mcpServers: { "   ": { command: "x" } } }))).toThrow(/empty server name/);
    expect(() => parseExternalMcpConfig(JSON.stringify({ mcpServers: { good: "not-an-object" } }))).toThrow(/mcpServers\.good must be an object/);
  });

  it("rejects a non-array args and an empty command on a stdio entry", () => {
    expect(() => parseExternalMcpConfig(JSON.stringify({ mcpServers: { s: { args: "notarray", command: "run" } } }))).toThrow(/args must be a string array/);
    expect(() => parseExternalMcpConfig(JSON.stringify({ mcpServers: { s: { command: "   " } } }))).toThrow(/command must be a non-empty string/);
  });

  it("honours an explicit autoConnect:false (defaults to true otherwise)", () => {
    const [entry] = parseExternalMcpConfig(JSON.stringify({ mcpServers: { s: { autoConnect: false, command: "run" } } }));
    expect(entry?.autoConnect).toBe(false);
    const [dflt] = parseExternalMcpConfig(JSON.stringify({ mcpServers: { s: { command: "run" } } }));
    expect(dflt?.autoConnect).toBe(true);
  });
});

describe("resolveExternalMcpConfigFile", () => {
  it("uses MUSE_MCP_CONFIG when set", () => {
    const path = resolveExternalMcpConfigFile({ MUSE_MCP_CONFIG: "/custom/path/mcp.json" });
    expect(path).toBe("/custom/path/mcp.json");
  });

  it("defaults to ~/.muse/mcp.json when MUSE_MCP_CONFIG is unset", () => {
    const path = resolveExternalMcpConfigFile({});
    expect(path.replaceAll("\\", "/").endsWith("/.muse/mcp.json")).toBe(true);
  });
});

describe("loadExternalMcpConfig", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "muse-mcp-config-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { force: true, recursive: true });
  });

  it("returns an empty list when the file does not exist", () => {
    const entries = loadExternalMcpConfig({ MUSE_MCP_CONFIG: join(tmpRoot, "missing.json") });
    expect(entries).toEqual([]);
  });

  it("reads + parses a real file via MUSE_MCP_CONFIG override", () => {
    const path = join(tmpRoot, "mcp.json");
    writeFileSync(path, JSON.stringify({
      mcpServers: { fs: { command: "node", args: ["server.js"] } }
    }), "utf8");

    const entries = loadExternalMcpConfig({ MUSE_MCP_CONFIG: path });
    expect(entries.map((entry) => entry.name)).toEqual(["fs"]);
  });
});

describe("seedExternalMcpServers", () => {
  it("inserts new entries and skips already-registered names", async () => {
    const store = new InMemoryMcpServerStore();
    await store.save({
      autoConnect: true,
      config: { command: "existing" },
      name: "existing",
      transportType: "stdio"
    });

    const inserted = await seedExternalMcpServers(store, [
      { autoConnect: true, config: { command: "node" }, name: "fresh", transportType: "stdio" },
      { autoConnect: true, config: { command: "node" }, name: "existing", transportType: "stdio" }
    ]);

    expect(inserted).toEqual(["fresh"]);
    const all = await store.list();
    expect(all.map((entry) => entry.name).sort()).toEqual(["existing", "fresh"]);
  });

  it("returns [] when given no entries", async () => {
    const store = new InMemoryMcpServerStore();
    expect(await seedExternalMcpServers(store, [])).toEqual([]);
  });
});

describe("diagnoseExternalMcpConfig", () => {
  it("collects per-entry errors instead of bailing on the first one", () => {
    const diagnoses = diagnoseExternalMcpConfig(JSON.stringify({
      mcpServers: {
        good: { command: "node", args: ["a.js"] },
        broken: { description: "no transport given" },
        also_good: { url: "https://example.com/mcp" }
      }
    }));

    expect(diagnoses.map((entry) => [entry.name, entry.status])).toEqual([
      ["good", "ok"],
      ["broken", "error"],
      ["also_good", "ok"]
    ]);
    const broken = diagnoses.find((entry) => entry.name === "broken");
    expect(broken?.findings.join(" ")).toMatch(/command.*url/);
  });

  it("marks disabled entries as skipped, not error", () => {
    const diagnoses = diagnoseExternalMcpConfig(JSON.stringify({
      mcpServers: {
        retired: { command: "node", args: ["b.js"], disabled: true }
      }
    }));

    expect(diagnoses).toHaveLength(1);
    expect(diagnoses[0]?.status).toBe("skipped");
    expect(diagnoses[0]?.findings.join(" ")).toContain("disabled: true");
  });

  it("flags malformed URLs as findings on otherwise-ok entries", () => {
    const diagnoses = diagnoseExternalMcpConfig(JSON.stringify({
      mcpServers: {
        bad_url: { url: "not a url" }
      }
    }));

    expect(diagnoses[0]?.status).toBe("ok");
    expect(diagnoses[0]?.findings.join(" ")).toContain("not a valid URL");
  });

  it("warns on non-http(s) URL protocols", () => {
    const diagnoses = diagnoseExternalMcpConfig(JSON.stringify({
      mcpServers: {
        ftp_entry: { url: "ftp://example.com/mcp" }
      }
    }));

    expect(diagnoses[0]?.status).toBe("ok");
    expect(diagnoses[0]?.findings.join(" ")).toContain("expected http: or https:");
  });

  it("still throws ConfigurationError on outer JSON parse failure", () => {
    expect(() => diagnoseExternalMcpConfig("{not json")).toThrow(ConfigurationError);
  });

  it("returns [] when mcpServers is missing", () => {
    expect(diagnoseExternalMcpConfig("{}")).toEqual([]);
  });
});

describe("diagnoseExternalMcpConfigFile", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "muse-mcp-doctor-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { force: true, recursive: true });
  });

  it("returns [] when the file does not exist", () => {
    const diagnoses = diagnoseExternalMcpConfigFile({ MUSE_MCP_CONFIG: join(tmpRoot, "missing.json") });
    expect(diagnoses).toEqual([]);
  });

  it("reads + diagnoses an existing file via MUSE_MCP_CONFIG override", () => {
    const path = join(tmpRoot, "mcp.json");
    writeFileSync(path, JSON.stringify({
      mcpServers: {
        good: { command: "node" },
        bad: { url: "https://" }
      }
    }), "utf8");

    const diagnoses = diagnoseExternalMcpConfigFile({ MUSE_MCP_CONFIG: path });
    expect(diagnoses.map((entry) => entry.name)).toEqual(["good", "bad"]);
    expect(diagnoses[0]?.status).toBe("ok");
    expect(diagnoses[1]?.status).toBe("ok");
    expect(diagnoses[1]?.findings.join(" ")).toMatch(/url.*not a valid|expected http/);
  });
});
