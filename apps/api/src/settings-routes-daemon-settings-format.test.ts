import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerSettingsRoutes } from "./settings-routes.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "muse-daemon-settings-format-"));
  file = join(dir, "daemon-settings.json");
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

describe("daemon-settings format conflicts", () => {
  it("returns 409 and preserves an unsupported root for both settings mutations", async () => {
    const original = "[]";
    writeFileSync(file, original, "utf8");
    const server = Fastify();
    registerSettingsRoutes(server, { authService: undefined, daemonSettingsFile: file });

    const flag = await server.inject({
      method: "PATCH",
      payload: { enabled: true, key: "MUSE_TELEGRAM_POLL_ENABLED" },
      url: "/api/settings/daemon-flags"
    });
    const quietHours = await server.inject({
      method: "PATCH",
      payload: { enabled: true, range: "23:00-08:00" },
      url: "/api/settings/quiet-hours"
    });

    expect(flag.statusCode).toBe(409);
    expect(flag.json()).toMatchObject({ reason: expect.stringContaining("unsupported format") });
    expect(quietHours.statusCode).toBe(409);
    expect(quietHours.json()).toMatchObject({ reason: expect.stringContaining("unsupported format") });
    expect(readFileSync(file, "utf8")).toBe(original);
    await server.close();
  });
});
