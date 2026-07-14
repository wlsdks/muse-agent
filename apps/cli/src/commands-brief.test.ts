import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

import { MUSE_IDENTITY_CORE, SURFACE_ROLES } from "@muse/prompts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BRIEF_AUDIO_PLAYER_TIMEOUT_MS, buildBriefSystemPrompt, isOutsideActiveHours, playAudioFile, playSynthesizedAudio, resolveUserName, selectBriefOverdue, unscheduledTimesInBrief } from "./commands-brief.js";

describe("buildBriefSystemPrompt — Phase 2+3 seam", () => {
  const base = { greetingHint: "morning", hour: 8, knownUserName: undefined, minute: 5, personaPrompt: undefined, routineNote: "" };

  it("anchors identity at position 0, then the brief role, then the cache boundary", () => {
    const prompt = buildBriefSystemPrompt(base);
    expect(prompt.startsWith(MUSE_IDENTITY_CORE)).toBe(true);
    expect(prompt).toContain(SURFACE_ROLES.brief);
    expect(prompt.indexOf(SURFACE_ROLES.brief)).toBeGreaterThan(prompt.indexOf(MUSE_IDENTITY_CORE));
  });

  it("carries the rendering rules and places dynamic content (greeting/name) after the cache boundary", () => {
    const prompt = buildBriefSystemPrompt({ ...base, knownUserName: "Stark" });
    expect(prompt).toContain("Compose a brief summary in 2–3 sentences");
    expect(prompt).toContain("Plain text, no markdown, no bullet list, no JSON.");
    const boundary = prompt.indexOf("<!-- MUSE_CACHE_BOUNDARY -->");
    expect(boundary).toBeGreaterThan(-1);
    expect(prompt.indexOf("It is currently morning")).toBeGreaterThan(boundary);
    expect(prompt.indexOf('Address the user as "Stark".')).toBeGreaterThan(boundary);
  });

  it("never invents a name when none is on file", () => {
    const prompt = buildBriefSystemPrompt(base);
    expect(prompt).toContain("No name is on file for the user");
    expect(prompt).not.toContain("Address the user as");
  });

  it("includes the routine note only when present", () => {
    const withNote = buildBriefSystemPrompt({ ...base, routineNote: "User is OUTSIDE their typical active window." });
    expect(withNote).toContain("OUTSIDE their typical active window");
    expect(buildBriefSystemPrompt(base)).not.toContain("OUTSIDE their typical active window");
  });
});

describe("selectBriefOverdue — the morning brief's OVERDUE heads-up (still actionable today)", () => {
  const now = new Date("2026-06-04T09:00:00Z");
  const past = new Date(now.getTime() - 3 * 86_400_000).toISOString();
  const future = new Date(now.getTime() + 3 * 86_400_000).toISOString();
  const task = (id: string, status: string, dueAt?: string) => ({ dueAt, id, status, title: `task ${id}` });
  const reminder = (text: string, status: "pending" | "fired", dueAt: string) => ({ createdAt: past, dueAt, id: text, status, text });

  it("flags an OPEN task past its due date; ignores a future-due open task, a done task, and a no-date task", () => {
    const { tasks } = selectBriefOverdue(
      [task("t1", "open", past), task("t2", "open", future), task("t3", "done", past), task("t4", "open")],
      [], now
    );
    expect(tasks.map((t) => t.id)).toEqual(["t1"]);
  });

  it("flags a PENDING reminder past its due; ignores a future-due one and a fired one", () => {
    const { reminders } = selectBriefOverdue(
      [], [reminder("r-past", "pending", past), reminder("r-future", "pending", future), reminder("r-fired", "fired", past)], now
    );
    expect(reminders.map((r) => r.text)).toEqual(["r-past"]);
  });

  it("sorts most-overdue-first and returns empty lists when nothing is overdue", () => {
    const older = new Date(now.getTime() - 9 * 86_400_000).toISOString();
    const { tasks } = selectBriefOverdue([task("recent", "open", past), task("older", "open", older)], [], now);
    expect(tasks.map((t) => t.id)).toEqual(["older", "recent"]); // oldest due first
    expect(selectBriefOverdue([task("future", "open", future)], [reminder("soon", "pending", future)], now))
      .toEqual({ reminders: [], tasks: [] });
  });
});

describe("unscheduledTimesInBrief — the brief surface's fabricated-time gate (fail-open)", () => {
  // Fact sheet times: 09:30 (now line), 15:00 + 16:00 (event), 18:00 (reminder).
  const factSheet = "Today: Thursday 09:30 local\nEvents:\n  · 15:00–16:00 Team sync\nReminders:\n  · 18:00 call mom";
  const now = 9 * 60 + 30; // 09:30

  it("flags NOTHING when the brief only echoes scheduled times (12h or 24h) or the current time", () => {
    expect(unscheduledTimesInBrief("You have a team sync at 3pm and should call mom at 6pm.", factSheet, now)).toEqual([]);
    expect(unscheduledTimesInBrief("Team sync at 15:00.", factSheet, now)).toEqual([]); // 24h echo
    expect(unscheduledTimesInBrief("Good morning, it's 9:30am.", factSheet, now)).toEqual([]); // current clock allowed
  });

  it("does NOT flag a relative phrase that isn't a clock time", () => {
    expect(unscheduledTimesInBrief("Your meeting is in 2 hours; 3 tasks are open.", factSheet, now)).toEqual([]);
  });

  it("FLAGS a clock time that is nowhere on the schedule (a fabricated appointment)", () => {
    expect(unscheduledTimesInBrief("Don't forget your dentist at 5pm.", factSheet, now)).toEqual(["5pm"]);
    expect(unscheduledTimesInBrief("Standup at 7:45am.", factSheet, now)).toEqual(["7:45am"]);
  });

  it("flags an invented time even when the schedule is empty, but never the current clock", () => {
    expect(unscheduledTimesInBrief("You have a call at 2pm.", "Open tasks: 0", now)).toEqual(["2pm"]);
    expect(unscheduledTimesInBrief("It's 9:30 — nothing scheduled.", "Open tasks: 0", now)).toEqual([]); // now allowed
  });

  it("dedupes repeated mentions of the same fabricated time", () => {
    expect(unscheduledTimesInBrief("Meet at 5pm, again at 5 pm.", factSheet, now)).toEqual(["5pm"]);
  });
});

describe("resolveUserName — greet by the REAL name or none, never an invented placeholder", () => {
  it("returns the name from a `name` fact (and tolerant key variants)", () => {
    expect(resolveUserName({ name: "Jinan" })).toBe("Jinan");
    expect(resolveUserName({ first_name: "Sam" })).toBe("Sam");
    expect(resolveUserName({ "Preferred Name": "Sammy" })).toBe("Sammy");
    expect(resolveUserName({ nickname: "JJ" })).toBe("JJ");
  });
  it("returns undefined when no name fact is present (so the greeting stays generic, not 'Alex')", () => {
    expect(resolveUserName({ allergy_penicillin: "yes", favorite_color: "teal" })).toBeUndefined();
    expect(resolveUserName({})).toBeUndefined();
    expect(resolveUserName(undefined)).toBeUndefined();
  });
  it("ignores a blank name value", () => {
    expect(resolveUserName({ name: "   " })).toBeUndefined();
  });
});

interface FakeChild extends EventEmitter {
  kill: (signal?: string) => boolean;
  killedWith?: string;
}

function makeFakeSpawn(): { spawnFn: typeof spawn; child: FakeChild } {
  const child = new EventEmitter() as FakeChild;
  child.kill = (signal?: string): boolean => {
    child.killedWith = signal ?? "SIGTERM";
    return true;
  };
  const spawnFn = (() => child) as unknown as typeof spawn;
  return { child, spawnFn };
}

describe("isOutsideActiveHours — the active-window band honours midnight wraparound", () => {
  it("returns false (inside) within ±2 hours on the 24h circle, across midnight", () => {
    // Early-bird active 1-3am, checking in at 23:00 → 2 circular hours before start → inside.
    expect(isOutsideActiveHours([1, 2, 3], 23)).toBe(false);
    // Night-owl active 21-23, checking in at 00:00 → 1 circular hour past → inside.
    expect(isOutsideActiveHours([21, 22, 23], 0)).toBe(false);
    // Same-day band still works.
    expect(isOutsideActiveHours([9, 10, 11], 12)).toBe(false);
  });

  it("returns true (outside) when no active hour is within ±2 circular hours", () => {
    expect(isOutsideActiveHours([9, 10, 11], 15)).toBe(true);
    // Early-bird [1,2,3] at 22:00 is 3 circular hours before start → outside.
    expect(isOutsideActiveHours([1, 2, 3], 22)).toBe(true);
  });

  it("treats the ±2 boundary as inside and just past it as outside (circular)", () => {
    expect(isOutsideActiveHours([23], 1)).toBe(false); // circular dist 2 → inside
    expect(isOutsideActiveHours([23], 2)).toBe(true); // circular dist 3 → outside
  });

  it("an empty active-hours list is never 'outside' (no routine learned yet)", () => {
    expect(isOutsideActiveHours([], 3)).toBe(false);
  });
});

describe("playAudioFile (muse brief --speak player watchdog)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves when the player exits 0", async () => {
    const { child, spawnFn } = makeFakeSpawn();
    const promise = playAudioFile("afplay", "/tmp/brief.wav", spawnFn);
    child.emit("close", 0);
    await expect(promise).resolves.toBeUndefined();
  });

  it("rejects with the exit code on a non-zero exit", async () => {
    const { child, spawnFn } = makeFakeSpawn();
    const promise = playAudioFile("aplay", "/tmp/brief.wav", spawnFn);
    child.emit("close", 3);
    await expect(promise).rejects.toThrow(/aplay exited with code 3/u);
  });

  it("rejects on a spawn error (player not installed)", async () => {
    const { child, spawnFn } = makeFakeSpawn();
    const promise = playAudioFile("afplay", "/tmp/brief.wav", spawnFn);
    child.emit("error", new Error("ENOENT afplay"));
    await expect(promise).rejects.toThrow(/ENOENT afplay/u);
  });

  it("SIGKILLs and rejects when the player wedges past the timeout", async () => {
    vi.useFakeTimers();
    const { child, spawnFn } = makeFakeSpawn();
    const promise = playAudioFile("afplay", "/tmp/brief.wav", spawnFn);
    const assertion = expect(promise).rejects.toThrow(/afplay timed out after 30000ms and was killed/u);
    await vi.advanceTimersByTimeAsync(BRIEF_AUDIO_PLAYER_TIMEOUT_MS);
    await assertion;
    expect(child.killedWith).toBe("SIGKILL");
  });

  it("does not double-settle: a late close after the timeout is ignored", async () => {
    vi.useFakeTimers();
    const { child, spawnFn } = makeFakeSpawn();
    const promise = playAudioFile("afplay", "/tmp/brief.wav", spawnFn);
    const assertion = expect(promise).rejects.toThrow(/timed out/u);
    await vi.advanceTimersByTimeAsync(BRIEF_AUDIO_PLAYER_TIMEOUT_MS);
    child.emit("close", 0);
    await assertion;
  });
});

describe("playSynthesizedAudio cleans up its mkdtempSync directory after playback so `muse brief --speak` doesn't leak a /tmp/muse-brief-speak-* directory + audio file on every invocation", () => {
  it("removes the temp dir on the happy path (player exits 0)", async () => {
    const { child, spawnFn } = makeFakeSpawn();
    const audio = new Uint8Array([1, 2, 3, 4]);
    const promise = playSynthesizedAudio(audio, "wav", { playerCommand: "afplay", playerSpawn: spawnFn });
    child.emit("close", 0);
    const result = await promise;
    expect(existsSync(result.dir)).toBe(false);
  });

  it("removes the temp dir on the error path (player exits non-zero) — finally fires regardless of success/failure", async () => {
    let capturedAudioFile = "";
    const child = new EventEmitter() as FakeChild;
    child.kill = () => true;
    const spawnFn = ((_player: string, args: readonly string[]) => {
      capturedAudioFile = String(args[0]);
      return child;
    }) as unknown as typeof spawn;
    const audio = new Uint8Array([1, 2, 3, 4]);
    const promise = playSynthesizedAudio(audio, "wav", { playerCommand: "afplay", playerSpawn: spawnFn });
    const assertion = expect(promise).rejects.toThrow(/afplay exit/u);
    child.emit("close", 7);
    await assertion;
    expect(capturedAudioFile.length).toBeGreaterThan(0);
    expect(existsSync(capturedAudioFile)).toBe(false);
    expect(existsSync(dirname(capturedAudioFile))).toBe(false);
  });
});
