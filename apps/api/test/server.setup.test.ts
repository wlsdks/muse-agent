/**
 * Coverage for `GET /api/setup/status`. The route just
 * wraps `collectSetupStatusJson` from @muse/autoconfigure, so this
 * test asserts the shape comes back unmolested and key fields land
 * in their expected places — full data-gathering coverage lives in
 * the CLI test that also exercises the JSON path.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";

describe("GET /api/setup/status", () => {
  it("returns the structured snapshot with all expected sections", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-setup-route-"));
    const prev = {
      tasks: process.env.MUSE_TASKS_FILE,
      notes: process.env.MUSE_NOTES_DIR,
      keys: process.env.MUSE_MODEL_KEYS_FILE,
      mcp: process.env.MUSE_MCP_CONFIG,
      calendar: process.env.MUSE_CALENDAR_FILE,
      messaging: process.env.MUSE_MESSAGING_CREDENTIALS_FILE,
      openai: process.env.OPENAI_API_KEY,
      anthropic: process.env.ANTHROPIC_API_KEY,
      gemini: process.env.GEMINI_API_KEY,
      telegram: process.env.MUSE_TELEGRAM_BOT_TOKEN,
      voice: process.env.MUSE_VOICE_OPENAI_API_KEY
    };
    // Clear ambient env so the snapshot is deterministic on the dev's machine.
    process.env.MUSE_TASKS_FILE = join(root, "tasks.json");
    process.env.MUSE_NOTES_DIR = join(root, "notes");
    process.env.MUSE_MODEL_KEYS_FILE = join(root, "missing-keys.json");
    process.env.MUSE_MCP_CONFIG = join(root, "missing-mcp.json");
    process.env.MUSE_CALENDAR_FILE = join(root, "missing-calendar.json");
    process.env.MUSE_MESSAGING_CREDENTIALS_FILE = join(root, "missing-msg.json");
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.MUSE_TELEGRAM_BOT_TOKEN;
    delete process.env.MUSE_VOICE_OPENAI_API_KEY;
    try {
      const server = buildServer({ logger: false });
      const response = await server.inject({ method: "GET", url: "/api/setup/status" });
      expect(response.statusCode).toBe(200);
      const body = response.json() as Record<string, { status: string; nextStep?: string }>;
      // A fresh box with no keys resolves the local default (ollama/gemma4:12b),
      // so model reads `ok` and agrees with `muse doctor` — never "not configured".
      expect(body.model).toMatchObject({ status: "ok" });
      expect(body.mcp).toMatchObject({ status: "info" });
      expect(body.notes).toMatchObject({ status: "info" });
      expect(body.tasks).toMatchObject({ status: "info" });
      expect(body.voice).toMatchObject({ status: "info" });
      expect(body.messaging).toMatchObject({ status: "info" });
      expect(body.calendar).toBeTruthy();
      // Per-section `nextStep` guidance appears on genuinely non-ok sections
      // (messaging, voice). The model section is `ok` here (a model always
      // resolves — env/config/cloud/local-default); its optional "customize"
      // nudge is source-dependent, so it's not asserted in this env-agnostic test.
      expect(body.messaging.nextStep).toMatch(/muse setup messaging/u);
      expect(body.voice.nextStep).toMatch(/MUSE_VOICE_OPENAI_API_KEY|muse setup model/u);
    } finally {
      const restore = (key: keyof typeof prev, envKey: string) => {
        if (prev[key] === undefined) { delete process.env[envKey]; } else { process.env[envKey] = prev[key]!; }
      };
      restore("tasks", "MUSE_TASKS_FILE");
      restore("notes", "MUSE_NOTES_DIR");
      restore("keys", "MUSE_MODEL_KEYS_FILE");
      restore("mcp", "MUSE_MCP_CONFIG");
      restore("calendar", "MUSE_CALENDAR_FILE");
      restore("messaging", "MUSE_MESSAGING_CREDENTIALS_FILE");
      restore("openai", "OPENAI_API_KEY");
      restore("anthropic", "ANTHROPIC_API_KEY");
      restore("gemini", "GEMINI_API_KEY");
      restore("telegram", "MUSE_TELEGRAM_BOT_TOKEN");
      restore("voice", "MUSE_VOICE_OPENAI_API_KEY");
    }
  });
});
