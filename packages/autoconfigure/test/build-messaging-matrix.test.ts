import { mkdtempSync, writeFileSync } from "node:fs";
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
    const home = mkdtempSync(join(tmpdir(), "muse-matrix-path-home-"));
    const inboxOverride = join(home, "overrides", "matrix-inbox.json");
    const sinceOverride = join(home, "overrides", "matrix-since.json");
    expect(resolveMatrixInboxFile({ HOME: home })).toBe(join(home, ".muse", "matrix-inbox.json"));
    expect(resolveMatrixSinceFile({ HOME: home })).toBe(join(home, ".muse", "matrix-since.json"));
    expect(resolveMatrixInboxFile({ HOME: home, MUSE_MATRIX_INBOX_FILE: inboxOverride })).toBe(inboxOverride);
    expect(resolveMatrixSinceFile({ HOME: home, MUSE_MATRIX_SINCE_FILE: sinceOverride })).toBe(sinceOverride);
  });
});

describe("T2-B1 local-only containment", () => {
  it("omits every remote provider while retaining the local log", () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-local-only-messaging-"));
    const registry = buildMessagingRegistry({
      MUSE_DISCORD_BOT_TOKEN: "discord-token",
      MUSE_LINE_CHANNEL_ACCESS_TOKEN: "line-token",
      MUSE_LOCAL_ONLY: "true",
      MUSE_MATRIX_ACCESS_TOKEN: "matrix-token",
      MUSE_MATRIX_HOMESERVER_URL: "https://matrix.example.test",
      MUSE_MESSAGING_CREDENTIALS_FILE: join(dir, "messaging.json"),
      MUSE_SLACK_BOT_TOKEN: "slack-token",
      MUSE_TELEGRAM_BOT_TOKEN: "telegram-token"
    });

    expect(registry.describe().map((entry) => entry.id)).toEqual(["log"]);
  });
});
