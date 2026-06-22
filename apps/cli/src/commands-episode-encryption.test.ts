import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isEpisodesEncrypted, upsertEpisode, type PersistedEpisode } from "@muse/stores";
import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { registerEpisodeCommands } from "./commands-episode.js";

async function run(
  file: string,
  key: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = { stderr: (m: string) => stderr.push(m), stdout: (m: string) => stdout.push(m) };
  const prevFile = process.env.MUSE_EPISODES_FILE;
  const prevKey = process.env.MUSE_MEMORY_KEY;
  process.env.MUSE_EPISODES_FILE = file;
  process.env.MUSE_MEMORY_KEY = key;
  let exitCode: number | undefined;
  try {
    const program = new Command();
    program.exitOverride();
    registerEpisodeCommands(program, io);
    await program.parseAsync(["node", "muse", "episode", ...args]);
  } catch (cause) {
    exitCode = (cause as { exitCode?: number }).exitCode ?? 1;
  } finally {
    if (prevFile === undefined) delete process.env.MUSE_EPISODES_FILE;
    else process.env.MUSE_EPISODES_FILE = prevFile;
    if (prevKey === undefined) delete process.env.MUSE_MEMORY_KEY;
    else process.env.MUSE_MEMORY_KEY = prevKey;
  }
  return { exitCode, stderr: stderr.join(""), stdout: stdout.join("") };
}

async function freshFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "muse-cli-epi-enc-"));
  return join(dir, "episodes.json");
}

const episode = (id: string, summary: string): PersistedEpisode => ({
  endedAt: "2026-06-01T01:00:00Z",
  id,
  startedAt: "2026-06-01T00:00:00Z",
  summary,
  userId: "u"
});

describe("muse episode encrypt/decrypt/encryption-status — the at-rest control surface", () => {
  const KEY = "cli-episodes-key-A";

  it("status → encrypt (cleartext-backup warning) → status → list decrypts transparently", async () => {
    const file = await freshFile();
    await upsertEpisode(file, episode("s1", "talked about the MTU 1380 fix"), { MUSE_MEMORY_KEY: KEY });

    const before = await run(file, KEY, ["encryption-status"]);
    expect(before.exitCode).toBeUndefined();
    expect(before.stdout).toContain("plaintext");

    const enc = await run(file, KEY, ["encrypt"]);
    expect(enc.exitCode).toBeUndefined();
    expect(enc.stdout).toContain("Encrypted episodes store at rest");
    expect(enc.stdout).toContain("Plaintext backup saved");
    expect(enc.stdout).toContain("CLEARTEXT"); // the disclosure the red-team required
    // On disk it is an AES envelope, NOT the readable summary.
    const onDisk = await readFile(file, "utf8");
    expect(onDisk).toContain("aes-256-gcm");
    expect(onDisk).not.toContain("MTU 1380");

    const after = await run(file, KEY, ["encryption-status"]);
    expect(after.stdout).toContain("ENCRYPTED");

    const list = await run(file, KEY, ["list"]);
    expect(list.exitCode).toBeUndefined();
    expect(list.stdout).toContain("MTU 1380");
  });

  it("a WRONG key fails closed on read and leaves the ciphertext intact (no destruction)", async () => {
    const file = await freshFile();
    await upsertEpisode(file, episode("s1", "secret recap"), { MUSE_MEMORY_KEY: KEY });
    await run(file, KEY, ["encrypt"]);
    const ciphertext = await readFile(file, "utf8");

    const wrong = await run(file, "TOTALLY-WRONG-KEY", ["list"]);
    expect(wrong.exitCode).toBe(1);
    expect(await readFile(file, "utf8")).toBe(ciphertext);
    expect(await isEpisodesEncrypted(file)).toBe(true);
    // The right key still reads it — fail-closed did not destroy anything.
    const ok = await run(file, KEY, ["list"]);
    expect(ok.stdout).toContain("secret recap");
  });

  it("decrypt reverts to plaintext and stays readable", async () => {
    const file = await freshFile();
    await upsertEpisode(file, episode("s1", "revertible recap"), { MUSE_MEMORY_KEY: KEY });
    await run(file, KEY, ["encrypt"]);

    const dec = await run(file, KEY, ["decrypt"]);
    expect(dec.exitCode).toBeUndefined();
    expect(dec.stdout).toContain("Reverted episodes store to plaintext");
    expect(await isEpisodesEncrypted(file)).toBe(false);
    expect((await run(file, KEY, ["list"])).stdout).toContain("revertible recap");
  });

  it("encryption-status emits structured JSON with --json", async () => {
    const file = await freshFile();
    await upsertEpisode(file, episode("s1", "x"), { MUSE_MEMORY_KEY: KEY });
    await run(file, KEY, ["encrypt"]);
    const r = await run(file, KEY, ["encryption-status", "--json"]);
    const parsed = JSON.parse(r.stdout) as { encrypted: boolean; file: string };
    expect(parsed.encrypted).toBe(true);
    expect(parsed.file).toBe(file);
  });
});
