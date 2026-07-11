import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildMessagingRegistry, resolveMatrixInboxFile, resolveMatrixSinceFile } from "../src/index.js";

describe("buildMessagingRegistry — matrix", () => {
  it("registers matrix when BOTH env token and homeserver URL are present", () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-mx-creds-"));
    const registry = buildMessagingRegistry({
      MUSE_MATRIX_ACCESS_TOKEN: "syt_tok",
      MUSE_MATRIX_HOMESERVER_URL: "https://hs.test",
      MUSE_MESSAGING_CREDENTIALS_FILE: join(dir, "missing.json"),
      MUSE_MESSAGING_LOG_ENABLED: "false"
    });
    expect(registry.describe().map((entry) => entry.id)).toEqual(["matrix"]);
  });

  it("does NOT register matrix when the homeserver URL is missing (fail-close)", () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-mx-creds-"));
    const registry = buildMessagingRegistry({
      MUSE_MATRIX_ACCESS_TOKEN: "syt_tok",
      MUSE_MESSAGING_CREDENTIALS_FILE: join(dir, "missing.json"),
      MUSE_MESSAGING_LOG_ENABLED: "false"
    });
    expect(registry.describe().map((entry) => entry.id)).toEqual([]);
  });

  it("registers matrix from a credentials-file {token, homeserverUrl} record", () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-mx-creds-"));
    const file = join(dir, "messaging.json");
    writeFileSync(file, JSON.stringify({
      providers: { matrix: { homeserverUrl: "https://hs.test", token: "syt_from_file" } },
      version: 1
    }), "utf8");
    const registry = buildMessagingRegistry({
      MUSE_MESSAGING_CREDENTIALS_FILE: file,
      MUSE_MESSAGING_LOG_ENABLED: "false"
    });
    expect(registry.describe().map((entry) => entry.id)).toEqual(["matrix"]);
  });
});

describe("matrix path resolvers", () => {
  it("default to ~/.muse and honour env overrides", () => {
    expect(resolveMatrixInboxFile({})).toBe(join(homedir(), ".muse", "matrix-inbox.json"));
    expect(resolveMatrixSinceFile({})).toBe(join(homedir(), ".muse", "matrix-since.json"));
    expect(resolveMatrixInboxFile({ MUSE_MATRIX_INBOX_FILE: "/tmp/mx-inbox.json" })).toBe("/tmp/mx-inbox.json");
    expect(resolveMatrixSinceFile({ MUSE_MATRIX_SINCE_FILE: "/tmp/mx-since.json" })).toBe("/tmp/mx-since.json");
  });
});
