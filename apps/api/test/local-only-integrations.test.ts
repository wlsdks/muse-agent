import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApiServerOptions, resolveIntegrationEnvironment } from "@muse/autoconfigure";
import { CalendarProviderRegistry, FileCalendarCredentialStore } from "@muse/calendar";
import { MessagingProviderRegistry } from "@muse/messaging";
import { describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";

const DENIAL = {
  code: "LOCAL_ONLY_REMOTE_INTEGRATIONS_DISABLED",
  message: "Remote calendar and messaging integrations are disabled while MUSE_LOCAL_ONLY=true."
};

const REMOTE_KEYS = [
  "MUSE_TELEGRAM_BOT_TOKEN",
  "MUSE_DISCORD_BOT_TOKEN",
  "MUSE_SLACK_BOT_TOKEN",
  "MUSE_MATRIX_ACCESS_TOKEN",
  "MUSE_LINE_CHANNEL_ACCESS_TOKEN",
  "MUSE_LINE_CHANNEL_SECRET"
] as const;

const STATUS_INTEGRATION_KEYS = new Set([
  "MUSE_CALDAV_APP_PASSWORD",
  "MUSE_CALDAV_URL",
  "MUSE_CALDAV_USERNAME",
  "MUSE_CALENDAR_FILE",
  "MUSE_CALENDAR_ICS_FILE",
  "MUSE_CALENDAR_PROVIDERS",
  "MUSE_CHANNEL_OWNERS_FILE",
  "MUSE_CHANNEL_PAIRING_CODES_FILE",
  "MUSE_CREDENTIALS_FILE",
  "MUSE_DISCORD_AFTER_FILE",
  "MUSE_DISCORD_BOT_TOKEN",
  "MUSE_DISCORD_INBOX_FILE",
  "MUSE_DISCORD_INBOX_INJECTION_CURSOR_FILE",
  "MUSE_GCAL_CALENDAR_ID",
  "MUSE_GCAL_CLIENT_ID",
  "MUSE_GCAL_CLIENT_SECRET",
  "MUSE_GCAL_REFRESH_TOKEN",
  "MUSE_LINE_CHANNEL_ACCESS_TOKEN",
  "MUSE_LINE_CHANNEL_SECRET",
  "MUSE_LINE_INBOX_FILE",
  "MUSE_LINE_INBOX_INJECTION_CURSOR_FILE",
  "MUSE_MATRIX_ACCESS_TOKEN",
  "MUSE_MATRIX_HOMESERVER_URL",
  "MUSE_MATRIX_INBOX_FILE",
  "MUSE_MATRIX_INBOX_INJECTION_CURSOR_FILE",
  "MUSE_MATRIX_SINCE_FILE",
  "MUSE_MESSAGING_CREDENTIALS_FILE",
  "MUSE_NOTION_DATABASE_ID",
  "MUSE_NOTION_TITLE_PROPERTY",
  "MUSE_NOTION_TOKEN",
  "MUSE_SLACK_AFTER_FILE",
  "MUSE_SLACK_BOT_TOKEN",
  "MUSE_SLACK_INBOX_FILE",
  "MUSE_SLACK_INBOX_INJECTION_CURSOR_FILE",
  "MUSE_TELEGRAM_BOT_TOKEN",
  "MUSE_TELEGRAM_INBOX_FILE",
  "MUSE_TELEGRAM_INBOX_INJECTION_CURSOR_FILE",
  "MUSE_TELEGRAM_OFFSET_FILE"
]);

function throwingStatusEnvironment(source: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return new Proxy(source, {
    get(target, property, receiver) {
      if (typeof property === "string" && STATUS_INTEGRATION_KEYS.has(property)) {
        throw new Error(`ambient integration key read: ${property}`);
      }
      return Reflect.get(target, property, receiver);
    },
    getOwnPropertyDescriptor(target, property) {
      if (typeof property === "string" && STATUS_INTEGRATION_KEYS.has(property)) {
        throw new Error(`ambient integration key descriptor read: ${property}`);
      }
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
    has(target, property) {
      if (typeof property === "string" && STATUS_INTEGRATION_KEYS.has(property)) {
        throw new Error(`ambient integration key presence check: ${property}`);
      }
      return Reflect.has(target, property);
    },
    ownKeys: Reflect.ownKeys
  }) as NodeJS.ProcessEnv;
}

function localOnlyEnv(root: string): Record<string, string> {
  return {
    HOME: root,
    MUSE_CALENDAR_FILE: join(root, "calendar.json"),
    MUSE_CREDENTIALS_FILE: join(root, "credentials.json"),
    MUSE_LINE_CHANNEL_SECRET: "line-secret-sentinel",
    MUSE_LOCAL_ONLY: "true",
    MUSE_MESSAGING_CREDENTIALS_FILE: join(root, "messaging.json"),
    MUSE_MODEL: "ollama/test",
    MUSE_MODEL_KEYS_FILE: join(root, "models.json"),
    MUSE_NOTES_DIR: join(root, "notes"),
    MUSE_TASKS_FILE: join(root, "tasks.json"),
    MUSE_TELEGRAM_BOT_TOKEN: "telegram-token-sentinel"
  };
}

function directServerOptions(root: string) {
  return {
    calendar: new CalendarProviderRegistry(),
    calendarCredentialStore: new FileCalendarCredentialStore(join(root, "credentials.json")),
    lineInboxFile: join(root, "line-inbox.json"),
    logger: false,
    messaging: new MessagingProviderRegistry()
  };
}

describe.sequential("T2-B1 API local-only integration containment", () => {
  it("uses createApiServerOptions' frozen explicit env for every setup surface before any remote integration I/O", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-api-local-only-"));
    const before = {
      home: process.env.HOME,
      localOnly: process.env.MUSE_LOCAL_ONLY,
      lineSecret: process.env.MUSE_LINE_CHANNEL_SECRET
    };
    const credentialFile = join(root, "credentials.json");
    const messagingFile = join(root, "messaging.json");
    const observed = new Set<string>();
    try {
      process.env.HOME = root;
      process.env.MUSE_LOCAL_ONLY = "false";
      process.env.MUSE_LINE_CHANNEL_SECRET = "ambient-secret-must-not-win";
      await writeFile(join(root, "models.json"), JSON.stringify({ providers: {} }));
      await writeFile(credentialFile, JSON.stringify({ providers: { gcal: { refreshToken: "keep" } } }));
      await writeFile(messagingFile, JSON.stringify({ providers: { telegram: { token: "keep" } } }));

      const target = localOnlyEnv(root);
      const explicitEnv = new Proxy(target, {
        get(source, property, receiver) {
          if (typeof property === "string" && (REMOTE_KEYS as readonly string[]).includes(property)) {
            observed.add(property);
          }
          return Reflect.get(source, property, receiver);
        },
        getOwnPropertyDescriptor: Reflect.getOwnPropertyDescriptor,
        has: Reflect.has,
        ownKeys: Reflect.ownKeys
      });
      const options = createApiServerOptions({ env: explicitEnv });
      expect(options.integrationEnv.localOnly).toBe(true);
      expect(options.localOnly).toBe(true);
      expect(observed).toEqual(new Set());

      const server = buildServer({ ...options, logger: false });
      try {
        const calendarPaths = [
          ["GET", "/api/calendar/credentials"],
          ["PUT", "/api/calendar/credentials/gcal"],
          ["DELETE", "/api/calendar/credentials/gcal"]
        ] as const;
        for (const [method, url] of calendarPaths) {
          const response = await server.inject({ method, payload: method === "PUT" ? { refreshToken: "new" } : undefined, url });
          expect(response.statusCode).toBe(403);
          expect(response.json()).toEqual(DENIAL);
        }

        const messagingPaths = [
          ["GET", "/api/messaging/setup"],
          ["POST", "/api/messaging/setup/telegram"],
          ["DELETE", "/api/messaging/setup/telegram/pairing"],
          ["POST", "/api/messaging/setup/telegram/test-send"],
          ["DELETE", "/api/messaging/setup/telegram"]
        ] as const;
        for (const [method, url] of messagingPaths) {
          const response = await server.inject({ method, payload: method === "POST" ? { token: "must-not-verify" } : undefined, url });
          expect(response.statusCode).toBe(403);
          expect(response.json()).toEqual(DENIAL);
        }

        const webhook = await server.inject({ method: "POST", payload: "{}", url: "/api/messaging/webhooks/line" });
        expect(webhook.statusCode).toBe(404);
        const status = await server.inject({ method: "GET", url: "/api/setup/status" });
        expect(status.statusCode).toBe(200);
        expect(status.json()).toMatchObject({
          calendar: { credentials: { status: "info" } },
          localOnly: { enabled: true },
          messaging: {
            nextStep: "Remote messaging setup is disabled while MUSE_LOCAL_ONLY=true; local log/native notifications remain available.",
            providers: [],
            status: "info"
          },
          webEgress: { enabled: false }
        });
      } finally {
        await server.close();
      }

      expect(await readFile(credentialFile, "utf8")).toBe(JSON.stringify({ providers: { gcal: { refreshToken: "keep" } } }));
      expect(await readFile(messagingFile, "utf8")).toBe(JSON.stringify({ providers: { telegram: { token: "keep" } } }));
      expect(observed).toEqual(new Set());
    } finally {
      if (before.home === undefined) delete process.env.HOME; else process.env.HOME = before.home;
      if (before.localOnly === undefined) delete process.env.MUSE_LOCAL_ONLY; else process.env.MUSE_LOCAL_ONLY = before.localOnly;
      if (before.lineSecret === undefined) delete process.env.MUSE_LINE_CHANNEL_SECRET; else process.env.MUSE_LINE_CHANNEL_SECRET = before.lineSecret;
      await rm(root, { force: true, recursive: true });
    }
  }, 60_000);

  it("lets an actually strict process dominate a source-false API snapshot across setup, status, and daemon posture", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-api-local-only-precedence-"));
    const previous = process.env.MUSE_LOCAL_ONLY;
    try {
      process.env.MUSE_LOCAL_ONLY = "true";
      await writeFile(join(root, "models.json"), JSON.stringify({ providers: {} }));
      const strict = createApiServerOptions({
        env: {
          ...localOnlyEnv(root),
          MUSE_LINE_CHANNEL_SECRET: "normal-line-secret",
          MUSE_LOCAL_ONLY: "false"
        }
      });
      expect(strict.integrationEnv.localOnly).toBe(true);
      expect(strict.localOnly).toBe(true);
      const server = buildServer({ ...strict, logger: false });
      try {
        const status = await server.inject({ method: "GET", url: "/api/setup/status" });
        expect(status.json()).toMatchObject({ localOnly: { enabled: true } });
        const webhook = await server.inject({ method: "POST", payload: "{}", url: "/api/messaging/webhooks/line" });
        expect(webhook.statusCode).toBe(404);
      } finally {
        await server.close();
      }
      expect(() => buildServer({
        integrationEnv: resolveIntegrationEnvironment({ MUSE_LOCAL_ONLY: "false" }),
        localOnly: true,
        logger: false
      })).toThrow(/must match/u);
    } finally {
      if (previous === undefined) delete process.env.MUSE_LOCAL_ONLY; else process.env.MUSE_LOCAL_ONLY = previous;
      await rm(root, { force: true, recursive: true });
    }
  }, 60_000);

  it("preserves source-true plus explicit-false API composition only when the actual process is normal", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-api-explicit-normal-"));
    const previous = process.env.MUSE_LOCAL_ONLY;
    try {
      process.env.MUSE_LOCAL_ONLY = "false";
      await writeFile(join(root, "models.json"), JSON.stringify({ providers: {} }));
      const normal = createApiServerOptions({
        env: { ...localOnlyEnv(root), MUSE_LOCAL_ONLY: "true" },
        localOnlyOverride: false
      });
      expect(normal.integrationEnv.localOnly).toBe(false);
      expect(normal.localOnly).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.MUSE_LOCAL_ONLY; else process.env.MUSE_LOCAL_ONLY = previous;
      await rm(root, { force: true, recursive: true });
    }
  }, 60_000);

  it("keeps explicit normal setup status isolated from a throwing ambient integration environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-api-status-snapshot-"));
    const previousEnv = process.env;
    const ambientCredentials = join(root, "ambient-messaging.json");
    const ambientModels = join(root, "ambient-models.json");
    const explicitCredentials = join(root, "explicit-messaging.json");
    const ambientEnv: NodeJS.ProcessEnv = {
      ...Object.fromEntries([...STATUS_INTEGRATION_KEYS].map((key) => [key, ""])),
      HOME: root,
      MUSE_LOCAL_ONLY: "false",
      MUSE_MCP_CONFIG: join(root, "mcp.json"),
      MUSE_MESSAGING_CREDENTIALS_FILE: ambientCredentials,
      MUSE_MODEL_KEYS_FILE: ambientModels,
      MUSE_NOTES_DIR: join(root, "notes"),
      MUSE_TASKS_FILE: join(root, "tasks.json"),
      MUSE_TELEGRAM_BOT_TOKEN: "ambient-telegram-token"
    };
    try {
      process.env = ambientEnv;
      await writeFile(ambientModels, JSON.stringify({ providers: { openai: { suggestedModel: "openai/gpt-4.1-mini", token: "model-key" } } }));
      await writeFile(ambientCredentials, JSON.stringify({ providers: { telegram: { token: "ambient-file-token" } } }));

      const explicitEnv = localOnlyEnv(root);
      explicitEnv.MUSE_LOCAL_ONLY = "false";
      explicitEnv.MUSE_MESSAGING_CREDENTIALS_FILE = explicitCredentials;
      delete explicitEnv.MUSE_LINE_CHANNEL_SECRET;
      delete explicitEnv.MUSE_TELEGRAM_BOT_TOKEN;
      await writeFile(explicitEnv.MUSE_MODEL_KEYS_FILE, JSON.stringify({ providers: {} }));
      const options = createApiServerOptions({ env: explicitEnv });
      expect(options.integrationEnv.localOnly).toBe(false);
      expect(options.integrationEnv.messaging.providers.telegram.envConfigured).toBe(false);

      const server = buildServer({ ...options, logger: false });
      try {
        process.env = throwingStatusEnvironment(ambientEnv);
        const status = await server.inject({ method: "GET", url: "/api/setup/status" });
        expect(status.statusCode).toBe(200);
        expect(status.json()).toMatchObject({
          localOnly: { enabled: false },
          messaging: { providers: [], status: "info" }
        });
      } finally {
        await server.close();
      }

      process.env = ambientEnv;
      const ambientServer = buildServer({ ...directServerOptions(root), logger: false });
      try {
        const status = await ambientServer.inject({ method: "GET", url: "/api/setup/status" });
        expect(status.statusCode).toBe(200);
        expect(status.json().messaging.providers).toContain("telegram (env)");
      } finally {
        await ambientServer.close();
      }
    } finally {
      process.env = previousEnv;
      await rm(root, { force: true, recursive: true });
    }
  }, 60_000);

  it("direct buildServer gives explicit localOnly precedence and otherwise falls back to ambient", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-api-direct-local-only-"));
    const previous = {
      credentials: process.env.MUSE_CREDENTIALS_FILE,
      home: process.env.HOME,
      lineSecret: process.env.MUSE_LINE_CHANNEL_SECRET,
      localOnly: process.env.MUSE_LOCAL_ONLY,
      messaging: process.env.MUSE_MESSAGING_CREDENTIALS_FILE
    };
    const close = async (server: ReturnType<typeof buildServer>) => {
      await server.close();
    };
    try {
      process.env.HOME = root;
      process.env.MUSE_CREDENTIALS_FILE = join(root, "credentials.json");
      process.env.MUSE_MESSAGING_CREDENTIALS_FILE = join(root, "messaging.json");
      process.env.MUSE_LINE_CHANNEL_SECRET = "direct-line-secret";

      // Direct explicit true wins over ambient false and closes setup + LINE.
      process.env.MUSE_LOCAL_ONLY = "false";
      const forcedLocal = buildServer({ ...directServerOptions(root), localOnly: true });
      try {
        expect((await forcedLocal.inject({ method: "GET", url: "/api/calendar/credentials" })).statusCode).toBe(403);
        expect((await forcedLocal.inject({ method: "GET", url: "/api/messaging/setup" })).statusCode).toBe(403);
        expect((await forcedLocal.inject({ method: "POST", payload: "{}", url: "/api/messaging/webhooks/line" })).statusCode).toBe(404);
      } finally {
        await close(forcedLocal);
      }

      // Direct explicit false wins over ambient true and leaves eligible normal
      // integration routes, including LINE, registered.
      process.env.MUSE_LOCAL_ONLY = "true";
      const forcedNormal = buildServer({ ...directServerOptions(root), localOnly: false });
      try {
        await forcedNormal.ready();
        expect((await forcedNormal.inject({ method: "GET", url: "/api/calendar/credentials" })).statusCode).toBe(200);
        expect((await forcedNormal.inject({ method: "GET", url: "/api/messaging/setup" })).statusCode).toBe(200);
        expect((await forcedNormal.inject({ method: "POST", payload: "{}", url: "/api/messaging/webhooks/line" })).statusCode).not.toBe(404);
      } finally {
        await close(forcedNormal);
      }

      // With no option, direct buildServer follows ambient local-only.
      const ambientLocal = buildServer(directServerOptions(root));
      try {
        expect((await ambientLocal.inject({ method: "GET", url: "/api/calendar/credentials" })).statusCode).toBe(403);
        expect((await ambientLocal.inject({ method: "GET", url: "/api/messaging/setup" })).statusCode).toBe(403);
        expect((await ambientLocal.inject({ method: "POST", payload: "{}", url: "/api/messaging/webhooks/line" })).statusCode).toBe(404);
      } finally {
        await close(ambientLocal);
      }
    } finally {
      if (previous.home === undefined) delete process.env.HOME; else process.env.HOME = previous.home;
      if (previous.localOnly === undefined) delete process.env.MUSE_LOCAL_ONLY; else process.env.MUSE_LOCAL_ONLY = previous.localOnly;
      if (previous.lineSecret === undefined) delete process.env.MUSE_LINE_CHANNEL_SECRET; else process.env.MUSE_LINE_CHANNEL_SECRET = previous.lineSecret;
      if (previous.credentials === undefined) delete process.env.MUSE_CREDENTIALS_FILE; else process.env.MUSE_CREDENTIALS_FILE = previous.credentials;
      if (previous.messaging === undefined) delete process.env.MUSE_MESSAGING_CREDENTIALS_FILE; else process.env.MUSE_MESSAGING_CREDENTIALS_FILE = previous.messaging;
      await rm(root, { force: true, recursive: true });
    }
  }, 60_000);
});
