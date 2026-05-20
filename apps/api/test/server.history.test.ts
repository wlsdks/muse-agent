import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";

describe("api server: GET /api/history", () => {
  it("merges reminder + proactive + followup + pattern + episode stores newest-first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-api-history-"));
    const reminderHistoryFile = join(dir, "reminder-history.json");
    const proactiveHistoryFile = join(dir, "proactive-history.json");
    const followupsFile = join(dir, "followups.json");
    const patternsFiredFile = join(dir, "patterns-fired.json");
    const episodesFile = join(dir, "episodes.json");

    const t1 = "2026-05-12T08:00:00.000Z";
    const t2 = "2026-05-12T10:00:00.000Z";
    const t3 = "2026-05-12T22:00:00.000Z";
    const t4 = "2026-05-13T07:00:00.000Z";

    writeFileSync(reminderHistoryFile, JSON.stringify({
      entries: [{ reminderId: "rem_a", text: "Call vet", providerId: "log", destination: "@me", firedAtIso: t2, status: "delivered" }],
      version: 1
    }), "utf8");
    writeFileSync(proactiveHistoryFile, JSON.stringify({
      entries: [{ kind: "calendar", itemId: "evt_a", startIso: t4, title: "Standup", providerId: "log", destination: "@me", text: "Standup in 5 min", firedAtIso: t4, status: "delivered" }],
      version: 1
    }), "utf8");
    writeFileSync(followupsFile, JSON.stringify({
      followups: [{ id: "fu_a", userId: "stark", scheduledFor: t1, status: "fired", summary: "Sent Q3 memo", firedAt: t1, createdAt: t1 }]
    }), "utf8");
    writeFileSync(patternsFiredFile, JSON.stringify({
      fired: [{ patternId: "pat_morning", firedAtMs: Date.parse(t1) - 1000, suggestion: "morning walk" }]
    }), "utf8");
    writeFileSync(episodesFile, JSON.stringify({
      episodes: [{ id: "ep_a", userId: "stark", startedAt: "2026-05-12T21:30:00Z", endedAt: t3, summary: "Budget review" }]
    }), "utf8");

    const server = buildServer({
      episodesFile,
      followupsFile,
      logger: false,
      patternsFiredFile,
      proactiveHistoryFile,
      reminderHistoryFile
    });

    const reply = await server.inject({ method: "GET", url: "/api/history" });
    expect(reply.statusCode).toBe(200);
    const body = reply.json() as { entries: Array<{ kind: string; id?: string; whenIso: string }>; total: number };
    expect(body.total).toBe(5);
    // Newest first: proactive(t4) → episode(t3) → reminder(t2) → followup(t1) → pattern(t1 - 1s).
    expect(body.entries.map((e) => e.kind)).toEqual(["proactive", "episode", "reminder", "followup", "pattern"]);
  });

  it("rejects invalid kind / sinceIso with structured errors", async () => {
    const server = buildServer({ logger: false });
    const bogusKind = await server.inject({ method: "GET", url: "/api/history?kind=bogus" });
    expect(bogusKind.statusCode).toBe(400);
    expect(bogusKind.json()).toMatchObject({ error: expect.stringContaining("kind must be one of") });

    const bogusSince = await server.inject({ method: "GET", url: "/api/history?sinceIso=not-an-iso" });
    expect(bogusSince.statusCode).toBe(400);
    expect(bogusSince.json()).toMatchObject({ error: expect.stringContaining("parseable ISO timestamp") });
  });

  it("returns an empty feed when no store paths are wired", async () => {
    const server = buildServer({ logger: false });
    const reply = await server.inject({ method: "GET", url: "/api/history" });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toEqual({ entries: [], total: 0 });
  });

  it("strict-parses ?limit so lenient-garbage like `20x` / `5min` falls back to the default instead of silently truncating", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-api-history-limit-"));
    const reminderHistoryFile = join(dir, "reminder-history.json");
    const entries: Array<{ reminderId: string; text: string; providerId: string; destination: string; firedAtIso: string; status: string }> = [];
    for (let i = 0; i < 30; i += 1) {
      entries.push({
        reminderId: `rem_${i.toString()}`,
        text: `entry ${i.toString()}`,
        providerId: "log",
        destination: "@me",
        firedAtIso: `2026-05-12T${(i % 24).toString().padStart(2, "0")}:00:00.000Z`,
        status: "delivered"
      });
    }
    writeFileSync(reminderHistoryFile, JSON.stringify({ entries, version: 1 }), "utf8");

    const server = buildServer({ logger: false, reminderHistoryFile });

    // Pre-fix `?limit=20x` was silently parsed as 20 via lenient
    // `Number.parseInt`, masking the typo with the literal default
    // (DEFAULT_LIMIT === 20). Post-fix the strict-parse helper
    // returns the fallback for non-decimal input — same 20 default
    // surface BUT the typo no longer "happens to match". The test
    // pins the asymmetry by setting a non-default valid limit
    // alongside the garbage one.
    const garbage = await server.inject({ method: "GET", url: "/api/history?limit=20x" });
    expect(garbage.statusCode).toBe(200);
    expect((garbage.json() as { total: number }).total).toBe(20);

    const validLow = await server.inject({ method: "GET", url: "/api/history?limit=5" });
    expect((validLow.json() as { total: number }).total).toBe(5);

    // Unit slip: pre-fix `?limit=10min` silently became 10.
    const unitSlip = await server.inject({ method: "GET", url: "/api/history?limit=10min" });
    expect((unitSlip.json() as { total: number; entries: unknown[] }).total, "lenient parseInt would silently truncate `10min` to 10 — the strict-parse helper falls back to the default 20").toBe(20);

    // Cap still applies for genuinely-large values.
    const capped = await server.inject({ method: "GET", url: "/api/history?limit=9999" });
    expect((capped.json() as { total: number }).total).toBeLessThanOrEqual(200);
  });
});
