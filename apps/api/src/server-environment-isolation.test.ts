import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const servers: { close: () => Promise<unknown> }[] = [];
const savedEnvironment = { ...process.env };

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnvironment);
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("buildServer environment isolation", () => {
  it("has one ambient fallback and otherwise uses its authoritative env variable", () => {
    const source = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    expect(source.match(/process\.env/gu)).toHaveLength(1);
    expect(source).toContain("const env = options.env ?? process.env;");
  });

  it("imports and assembles after poisoning, while routes, daemons, and connectors use only injected env", async () => {
    const ambientRoot = temporaryRoot("muse-api-ambient-poison-");
    const injectedRoot = temporaryRoot("muse-api-injected-env-");
    const ambientBeliefs = join(ambientRoot, "beliefs.json");
    const injectedBeliefs = join(injectedRoot, "beliefs.json");
    const ambientDaemonSettings = join(ambientRoot, "daemon-settings.json");
    const ambientMessagingLog = join(ambientRoot, "notifications.log");
    writeBeliefs(ambientBeliefs, "ambient_owner_fact");
    writeBeliefs(injectedBeliefs, "injected_fact");

    Object.assign(process.env, {
      DATABASE_URL: "postgres://ambient-owner.invalid/muse",
      HTTPS_PROXY: "https://ambient-owner.invalid",
      MUSE_AUTHORED_SKILLS_DIR: join(ambientRoot, "authored-skills"),
      MUSE_BELIEF_PROVENANCE_FILE: ambientBeliefs,
      MUSE_DAEMON_SETTINGS_FILE: ambientDaemonSettings,
      MUSE_DISCORD_POLL_ENABLED: "true",
      MUSE_DISCORD_BOT_TOKEN: "ambient-discord-secret",
      MUSE_GMAIL_TOKEN: "ambient-gmail-secret",
      MUSE_HOMEASSISTANT_TOKEN: "ambient-home-secret",
      MUSE_HOMEASSISTANT_URL: "https://ambient-owner.invalid/home-assistant",
      MUSE_INBOUND_REPLY_ENABLED: "true",
      MUSE_LOCAL_ONLY: "false",
      MUSE_MESSAGING_LOG_FILE: ambientMessagingLog,
      MUSE_SLACK_BOT_TOKEN: "ambient-slack-secret",
      MUSE_SLACK_POLL_ENABLED: "true",
      MUSE_TELEGRAM_BOT_TOKEN: "ambient-telegram-secret",
      MUSE_TELEGRAM_POLL_ENABLED: "true",
      OPENAI_API_KEY: "ambient-owner-secret",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://ambient-owner.invalid/otel",
      XDG_CONFIG_HOME: join(ambientRoot, "xdg")
    });

    const injectedEnv = {
      HOME: injectedRoot,
      MUSE_BELIEF_PROVENANCE_FILE: injectedBeliefs,
      MUSE_DAEMON_SETTINGS_FILE: join(injectedRoot, ".muse", "daemon-settings.json"),
      MUSE_LOCAL_ONLY: "true",
      MUSE_MODEL: "diagnostic/env-isolation",
      MUSE_MODEL_PROVIDER_ID: "diagnostic",
      MUSE_USER_MEMORY_AUTO_EXTRACT: "false",
      USERPROFILE: injectedRoot
    };

    // Application imports deliberately happen only after the ambient poison is
    // installed. This catches import/assembly paths that bypass the injected env.
    const [{ createApiServerOptions }, { buildServer }] = await Promise.all([
      import("../../../packages/autoconfigure/src/index.js"),
      import("./server.js")
    ]);
    const options = createApiServerOptions({ env: injectedEnv });
    expect(options.integrationEnv.localOnly).toBe(true);
    expect(Object.values(options.integrationEnv.messaging.providers).every((provider) => !provider.envConfigured)).toBe(true);
    const messaging = options.messaging;
    expect(messaging).toBeDefined();
    if (!messaging) throw new Error("expected local log messaging registry");
    expect(messaging.list().map((provider) => provider.id)).toEqual(["log"]);
    expect(messaging.describe()[0]?.description).toContain(injectedRoot);
    expect(messaging.describe()[0]?.description).not.toContain(ambientRoot);
    expect(options.agentCardToolProvider().map((tool) => tool.name))
      .not.toEqual(expect.arrayContaining(["email_send", "home_action"]));

    const server = buildServer({ ...options, logger: false });
    servers.push({
      close: async () => {
        await options.scheduler.service.shutdown(1_000);
        await server.close();
      }
    });

    const response = await server.inject({ method: "GET", url: "/api/journey?kind=fact" });
    expect(response.statusCode).toBe(200);
    const refs = (response.json() as { events: readonly { ref?: string }[] }).events.map((event) => event.ref);
    expect(refs).toContain("injected_fact");
    expect(refs).not.toContain("ambient_owner_fact");

    const flagsResponse = await server.inject({ method: "GET", url: "/api/settings/daemon-flags" });
    expect(flagsResponse.statusCode).toBe(200);
    const flags = (flagsResponse.json() as { flags: readonly { enabled: boolean; key: string; running?: boolean }[] }).flags;
    for (const key of ["MUSE_TELEGRAM_POLL_ENABLED", "MUSE_INBOUND_REPLY_ENABLED"]) {
      expect(flags.find((flag) => flag.key === key)).toMatchObject({ enabled: false, running: false });
    }

    const patchResponse = await server.inject({
      method: "PATCH",
      payload: { enabled: true, key: "MUSE_EPISODIC_MEMORY_ENABLED" },
      url: "/api/settings/daemon-flags"
    });
    expect(patchResponse.statusCode).toBe(200);
    const injectedDaemonSettings = join(injectedRoot, ".muse", "daemon-settings.json");
    expect(existsSync(injectedDaemonSettings)).toBe(true);
    expect(existsSync(ambientDaemonSettings)).toBe(false);
    expect(JSON.parse(readFileSync(injectedDaemonSettings, "utf8"))).toMatchObject({
      flags: { MUSE_EPISODIC_MEMORY_ENABLED: true }
    });
    expect(existsSync(ambientMessagingLog)).toBe(false);
  });
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writeBeliefs(file: string, key: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({
    entries: [{
      key,
      kind: "fact",
      learnedAt: "2026-07-21T00:00:00.000Z",
      source: "user",
      userId: "owner",
      value: key
    }]
  }), "utf8");
}
