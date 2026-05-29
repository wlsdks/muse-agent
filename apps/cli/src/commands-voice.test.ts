import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { registerVoiceCommands, type VoiceCommandHelpers } from "./commands-voice.js";
import type { ProgramIO } from "./program.js";

// CLI command-parser + wiring smoke (backlog P5) for `muse voice`. `tts` is the
// rich one: it shapes a POST body from the variadic text + options, calls the
// injectable io.fetch, writes the BINARY audio response to --out, and surfaces a
// non-ok status as an error. providers wraps a GET. Fake helpers + fake fetch +
// a tmp out file — no network, but the real body/file/path wiring is exercised.

const outFile = (): string => join(mkdtempSync(join(tmpdir(), "muse-voice-")), "out.mp3");

const run = async (
  args: string[],
  fetchImpl?: ProgramIO["fetch"],
): Promise<{ apiPaths: string[]; ttsBody?: Record<string, unknown>; ttsUrl?: string; stdout: string; exitCode: number | undefined }> => {
  const apiPaths: string[] = [];
  let ttsBody: Record<string, unknown> | undefined;
  let ttsUrl: string | undefined;
  const out: string[] = [];
  const io: ProgramIO = {
    stderr: () => undefined,
    stdout: (m: string) => out.push(m),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  } as ProgramIO;
  const helpers: VoiceCommandHelpers = {
    apiRequest: async (_io, _command, path) => { apiPaths.push(path); return { _path: path }; },
    readApiOptions: async () => ({ baseUrl: "http://localhost:7070", token: "tok" }),
    writeOutput: () => undefined,
  };
  const trackedFetch: ProgramIO["fetch"] = async (url, init) => {
    ttsUrl = String(url);
    ttsBody = JSON.parse(String((init as { body?: string }).body ?? "{}")) as Record<string, unknown>;
    return (fetchImpl ? fetchImpl(url, init) : new Response(Buffer.from("AUDIODATA"), { headers: { "x-voice-format": "mp3", "x-voice-provider": "openai" } }));
  };
  const ioWithFetch: ProgramIO = { ...io, fetch: trackedFetch };
  const program = new Command();
  program.exitOverride();
  registerVoiceCommands(program, ioWithFetch, helpers);
  let exitCode: number | undefined;
  try {
    await program.parseAsync(["node", "muse", "voice", ...args]);
  } catch (cause) {
    exitCode = (cause as { exitCode?: number }).exitCode ?? 1;
  }
  return { apiPaths, exitCode, stdout: out.join(""), ttsBody, ttsUrl };
};

describe("muse voice — command parser + tts wiring", () => {
  it("providers → GET /api/voice/providers via apiRequest", async () => {
    expect((await run(["providers"])).apiPaths).toEqual(["/api/voice/providers"]);
  });

  it("tts: POSTs the joined+trimmed text + default format to /api/voice/tts and writes the audio bytes to --out", async () => {
    const path = outFile();
    const { ttsBody, ttsUrl, stdout } = await run(["tts", "  hello", "world  ", "--out", path]);
    expect(ttsUrl).toBe("http://localhost:7070/api/voice/tts");
    expect(ttsBody).toEqual({ format: "mp3", text: "hello world" }); // no voice/provider keys unless passed
    expect(readFileSync(path).toString()).toBe("AUDIODATA"); // the binary response landed on disk
    expect(stdout).toContain("Wrote 9 bytes (mp3, openai)");
  });

  it("tts: includes voice + provider in the body only when those options are given", async () => {
    const { ttsBody } = await run(["tts", "hi", "--out", outFile(), "--voice", "nova", "--format", "wav", "--provider", "elevenlabs"]);
    expect(ttsBody).toEqual({ format: "wav", providerId: "elevenlabs", text: "hi", voice: "nova" });
  });

  it("tts: an all-whitespace text is rejected before any fetch (non-empty guard)", async () => {
    const { exitCode, ttsUrl } = await run(["tts", "   ", "--out", outFile()]);
    expect(exitCode).toBeDefined();
    expect(ttsUrl).toBeUndefined();
  });

  it("tts: a non-ok API response surfaces as an error (status + detail), nothing written", async () => {
    const failing: ProgramIO["fetch"] = async () => new Response("backend down", { status: 503 });
    const { exitCode, stdout } = await run(["tts", "hi", "--out", outFile()], failing);
    expect(exitCode).toBeDefined();
    expect(stdout).not.toContain("Wrote");
  });

  it("tts: missing required --out is a parse error", async () => {
    expect((await run(["tts", "hi"])).exitCode).toBeDefined();
  });
});
