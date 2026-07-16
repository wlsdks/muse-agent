import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { credentialPath, defaultCredentialPath, deleteGmailCredential, deleteStoredToken, hasStoredGmailCredentialSync, readGmailCredential, readStoredToken, writeGmailCredential, writeStoredToken, type GmailOAuthCredential } from "./credential-store.js";
import type { ProgramIO } from "./program.js";

const writeFileCalls: Array<{ path: string }> = [];

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: vi.fn(async (filePath: Parameters<typeof actual.writeFile>[0], data: Parameters<typeof actual.writeFile>[1], options?: Parameters<typeof actual.writeFile>[2]) => {
      writeFileCalls.push({ path: String(filePath) });
      return actual.writeFile(filePath, data, options);
    })
  };
});

describe("defaultCredentialPath", () => {
  beforeEach(() => {
    vi.stubEnv("HOME", "/u/jinan");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses HOME when set, rooting the credentials file under ~/.config/muse", () => {
    expect(defaultCredentialPath()).toBe("/u/jinan/.config/muse/credentials.json");
  });

  it("honours an explicit non-empty `home` argument over HOME (trimmed)", () => {
    expect(defaultCredentialPath("/elsewhere")).toBe("/elsewhere/.config/muse/credentials.json");
    expect(defaultCredentialPath("  /trimmed  ")).toBe("/trimmed/.config/muse/credentials.json");
  });

  it("treats an empty / whitespace-only explicit `home` argument as unset and falls through to HOME", () => {
    expect(defaultCredentialPath("")).toBe("/u/jinan/.config/muse/credentials.json");
    expect(defaultCredentialPath("   ")).toBe("/u/jinan/.config/muse/credentials.json");
  });

  it("FAILS LOUD when HOME and os.homedir() both resolve to empty — credentials must NOT silently land at /.config/muse/... at the filesystem root", () => {
    vi.stubEnv("HOME", "");
    // On systems where stubbing HOME="" also makes os.homedir() return "",
    // the resolver MUST throw rather than write to `/.config/muse/...`.
    // Otherwise (homedir() finds a real home via getpwuid), the result
    // must root under that home, never under "/".
    try {
      const credPath = defaultCredentialPath();
      expect(credPath).not.toMatch(/^\/\.config\/muse/u);
      expect(credPath).toMatch(/\/.config\/muse\/credentials\.json$/u);
    } catch (cause) {
      expect((cause as Error).message).toMatch(/Cannot resolve home directory/u);
    }
  });
});

describe("readStoredToken graceful corruption recovery", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "muse-cred-corrupt-"));
  });

  afterEach(async () => {
    await rm(workdir, { force: true, recursive: true });
  });

  it("degrades to `undefined` + a stderr warning when credentials.json is corrupted (0 bytes, malformed JSON, wrong shape) instead of throwing — auth-aware commands fall back to anonymous mode rather than crashing", async () => {
    // Pre-fix: a 0-byte credentials.json (a crash that survived the
    // atomic-write fix, a manual edit, disk corruption) made every
    // `muse chat`, `muse auth status`, `muse today` call crash with
    // `SyntaxError: Unexpected end of JSON input` (from JSON.parse("")).
    // Read-path now degrades to anonymous mode + logs a one-line
    // warning so the user can act on it.
    const fsp = await import("node:fs/promises");
    const credPath = path.join(workdir, "credentials.json");
    const stderr: string[] = [];
    const io: ProgramIO = {
      configDir: workdir,
      credentialKey: "test-credential-key-aaaaaaaaaaaaaa",
      readPipedStdin: async () => "",
      stderr: (m: string) => stderr.push(m),
      stdout: () => undefined
    };

    // Plant a 0-byte file at the credentials path.
    await fsp.mkdir(path.dirname(credPath), { recursive: true });
    await fsp.writeFile(credPath, "", "utf8");

    const result = await readStoredToken(io, "https://api.example.com");
    expect(result, "corrupted credentials must NOT crash the call").toBeUndefined();
    const stderrText = stderr.join("");
    expect(stderrText).toContain("credentials store unreadable");
    expect(stderrText).toContain("muse auth login");

    // Same posture for malformed JSON.
    stderr.length = 0;
    await fsp.writeFile(credPath, "{not-json", "utf8");
    expect(await readStoredToken(io, "https://api.example.com")).toBeUndefined();
    expect(stderr.join("")).toContain("credentials store unreadable");

    // Same posture for valid JSON with wrong shape.
    stderr.length = 0;
    await fsp.writeFile(credPath, `{"random":"junk"}`, "utf8");
    expect(await readStoredToken(io, "https://api.example.com")).toBeUndefined();
    expect(stderr.join("")).toContain("credentials store unreadable");
  });

  it("happy path: an ENOENT (file absent) returns undefined silently — the warning fires only on real corruption, not on the fresh-install no-creds case", async () => {
    const stderr: string[] = [];
    const io: ProgramIO = {
      configDir: workdir,
      credentialKey: "test-credential-key-aaaaaaaaaaaaaa",
      readPipedStdin: async () => "",
      stderr: (m: string) => stderr.push(m),
      stdout: () => undefined
    };
    // No file at credentialPath(io). ENOENT path returns
    // { tokens: {} } silently (no warning).
    expect(await readStoredToken(io, "https://api.example.com")).toBeUndefined();
    expect(stderr.join("")).toBe("");
  });
});

describe("writeCredentialStore atomic write", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "muse-cred-atomic-"));
    writeFileCalls.length = 0;
  });

  afterEach(async () => {
    await rm(workdir, { force: true, recursive: true });
  });

  it("routes through an atomic tmp+rename so a mid-write crash never truncates the existing credentials.json (pre-fix `writeFile(filePath, …)` opens with O_TRUNC; a crash between truncate and write would leave the user with a 0-byte file → JSON.parse fails on next read → forced re-login)", async () => {
    const io: ProgramIO = {
      configDir: workdir,
      credentialKey: "test-credential-key-aaaaaaaaaaaaaa",
      readPipedStdin: async () => "",
      stderr: () => undefined,
      stdout: () => undefined
    };
    const credPath = path.join(workdir, "credentials.json");

    await writeStoredToken(io, "https://api.example.com", "initial-token");
    expect(await readStoredToken(io, "https://api.example.com")).toBe("initial-token");

    const callsBeforeSecondWrite = writeFileCalls.length;
    await writeStoredToken(io, "https://api.example.com", "second-token");

    const secondWriteCalls = writeFileCalls.slice(callsBeforeSecondWrite);
    expect(secondWriteCalls.length, "writeStoredToken must invoke writeFile at least once").toBeGreaterThan(0);
    // Every writeFile call during the second write must target a
    // tmp file, NOT credPath directly. Pre-fix the path argument
    // would have been exactly credPath, truncating the original
    // before any encrypted bytes landed.
    for (const call of secondWriteCalls) {
      expect(call.path, "writeFile target must NOT be the final credentials.json (pre-fix path)").not.toBe(credPath);
      expect(call.path, "writeFile target must follow the tmp-<pid>-<hex> pattern").toMatch(
        /credentials\.json\.tmp-\d+-[a-f0-9]+$/u
      );
    }

    // Happy path still works end-to-end: the new token is readable,
    // the final file lives at credPath, encrypted body doesn't leak
    // the plaintext token.
    expect(await readStoredToken(io, "https://api.example.com")).toBe("second-token");
    const finalContent = await readFile(credPath, "utf8");
    expect(finalContent.length, "the final file must be non-empty").toBeGreaterThan(0);
    expect(finalContent, "the encrypted body must not leak the plaintext token").not.toContain("second-token");
  });
});

describe("credential store — write paths preserve unreadable ciphertext", () => {
  let workdir: string;
  const io = (credentialKey: string): ProgramIO => ({
    configDir: workdir,
    credentialKey,
    readPipedStdin: async () => "",
    stderr: () => undefined,
    stdout: () => undefined
  });

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "muse-cred-relogin-"));
  });
  afterEach(async () => {
    await rm(workdir, { force: true, recursive: true });
  });

  it("writeStoredToken refuses to clobber a store encrypted under another host key", async () => {
    // Key A writes a token; the per-host fallback key then changes (e.g. the
    // hostname changed), so the existing ciphertext no longer decrypts.
    await writeStoredToken(io("key-A-aaaaaaaaaaaaaaaaaaaaaaaa"), "https://api", "tok-A");
    const changed = io("key-B-bbbbbbbbbbbbbbbbbbbbbbbb");

    const before = await readFile(credentialPath(changed), "utf8");
    // Read degrades to anonymous, but a write cannot assume this is the only
    // token in the unreadable file and silently destroy the remaining data.
    expect(await readStoredToken(changed, "https://api")).toBeUndefined();
    await expect(writeStoredToken(changed, "https://api", "tok-B"))
      .rejects.toThrow(/Refusing to overwrite unreadable credentials/u);
    expect(await readFile(credentialPath(changed), "utf8")).toBe(before);
  });

  it("deleteStoredToken refuses to clobber an undecryptable store", async () => {
    await writeStoredToken(io("key-A-aaaaaaaaaaaaaaaaaaaaaaaa"), "https://api", "tok-A");
    const changed = io("key-B-bbbbbbbbbbbbbbbbbbbbbbbb");
    const before = await readFile(credentialPath(changed), "utf8");
    await expect(deleteStoredToken(changed, "https://api"))
      .rejects.toThrow(/Refusing to overwrite unreadable credentials/u);
    expect(await readFile(credentialPath(changed), "utf8")).toBe(before);
  });

  it("a VALID store is never clobbered — other baseUrls survive a write", async () => {
    const valid = io("key-same-cccccccccccccccccccccccc");
    await writeStoredToken(valid, "https://a", "ta");
    await writeStoredToken(valid, "https://b", "tb");
    expect(await readStoredToken(valid, "https://a")).toBe("ta");
    expect(await readStoredToken(valid, "https://b")).toBe("tb");
  });
});

describe("Gmail OAuth credential — backward-compatible new section on the SAME encrypted store", () => {
  let workdir: string;
  const makeIo = (): ProgramIO => ({
    configDir: workdir,
    credentialKey: "test-credential-key-aaaaaaaaaaaaaa",
    stderr: () => undefined,
    stdout: () => undefined
  });
  const credential: GmailOAuthCredential = {
    accessToken: "access-1",
    accessTokenExpiresAt: Date.now() + 3600_000,
    clientId: "client-id.apps.googleusercontent.com",
    clientSecret: "client-secret-value",
    refreshToken: "refresh-token-value"
  };

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "muse-cred-gmail-"));
  });
  afterEach(async () => {
    await rm(workdir, { force: true, recursive: true });
  });

  it("round-trips a Gmail credential through write → read", async () => {
    const io = makeIo();
    expect(await readGmailCredential(io)).toBeUndefined();
    await writeGmailCredential(io, credential);
    expect(await readGmailCredential(io)).toEqual(credential);
  });

  it("MUTATION-RED: readGmailCredential/hasStoredGmailCredentialSync would wrongly report 'configured' if the validator didn't require clientId/clientSecret/refreshToken — an old-format credentials.json (no `gmail` key at all, written before this field existed) must decrypt cleanly and report `undefined` / false, not throw and not silently 'succeed' with a garbage credential", async () => {
    const io = makeIo();
    // writeStoredToken never touches `gmail` — this is EXACTLY the shape a
    // pre-existing `muse auth login` user's credentials.json has today.
    await writeStoredToken(io, "https://api.example.com", "some-api-token");
    expect(await readGmailCredential(io)).toBeUndefined();
    expect(hasStoredGmailCredentialSync(io)).toBe(false);
    // The original token section must still work untouched.
    expect(await readStoredToken(io, "https://api.example.com")).toBe("some-api-token");
  });

  it("writing a Gmail credential preserves the pre-existing api-token section (both live in the same store)", async () => {
    const io = makeIo();
    await writeStoredToken(io, "https://api.example.com", "some-api-token");
    await writeGmailCredential(io, credential);
    expect(await readStoredToken(io, "https://api.example.com")).toBe("some-api-token");
    expect(await readGmailCredential(io)).toEqual(credential);
  });

  it("deleteGmailCredential removes only the Gmail section, leaving api tokens intact", async () => {
    const io = makeIo();
    await writeStoredToken(io, "https://api.example.com", "some-api-token");
    await writeGmailCredential(io, credential);
    await deleteGmailCredential(io);
    expect(await readGmailCredential(io)).toBeUndefined();
    expect(await readStoredToken(io, "https://api.example.com")).toBe("some-api-token");
  });

  it("writeGmailCredential keeps the file at chmod 600", async () => {
    const io = makeIo();
    await writeGmailCredential(io, credential);
    const stat = await (await import("node:fs/promises")).stat(path.join(workdir, "credentials.json"));
    expect((stat.mode & 0o777).toString(8)).toBe("600");
  });

  describe("hasStoredGmailCredentialSync — the sync seam resolveGmailProvider/summarizeActuators/buildActuatorTools depend on to stay fully synchronous", () => {
    it("false when no credentials.json exists at all", async () => {
      expect(hasStoredGmailCredentialSync(makeIo())).toBe(false);
    });

    it("true once a Gmail credential is stored", async () => {
      const io = makeIo();
      await writeGmailCredential(io, credential);
      expect(hasStoredGmailCredentialSync(io)).toBe(true);
    });

    it("false once the refresh token is marked invalid — armed actuators must NOT claim Gmail is usable after invalid_grant", async () => {
      const io = makeIo();
      await writeGmailCredential(io, { ...credential, refreshTokenInvalid: true });
      expect(hasStoredGmailCredentialSync(io)).toBe(false);
    });

    it("false (fail-soft, never throws) on a corrupted credentials.json", async () => {
      const io = makeIo();
      await writeFile(path.join(workdir, "credentials.json"), "{not-json", "utf8");
      expect(hasStoredGmailCredentialSync(io)).toBe(false);
    });

    it("false (fail-soft) when the store can't be decrypted (wrong key)", async () => {
      const salt = randomBytes(16);
      const iv = randomBytes(12);
      const key = scryptSync("some-other-key", salt, 32);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(JSON.stringify({ tokens: {} }), "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      await writeFile(path.join(workdir, "credentials.json"), JSON.stringify({
        algorithm: "aes-256-gcm",
        data: encrypted.toString("base64"),
        iv: iv.toString("base64"),
        salt: salt.toString("base64"),
        tag: tag.toString("base64"),
        version: 1
      }), "utf8");
      expect(hasStoredGmailCredentialSync(makeIo())).toBe(false);
    });
  });
});
