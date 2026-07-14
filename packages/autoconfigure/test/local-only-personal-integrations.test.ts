import * as actualFs from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import { describe, expect, it, vi } from "vitest";

const FORBIDDEN_REMOTE_KEYS = [
  "MUSE_GCAL_CLIENT_ID",
  "MUSE_GCAL_CLIENT_SECRET",
  "MUSE_GCAL_REFRESH_TOKEN",
  "MUSE_GCAL_CALENDAR_ID",
  "MUSE_CALDAV_URL",
  "MUSE_CALDAV_USERNAME",
  "MUSE_CALDAV_APP_PASSWORD",
  "MUSE_TELEGRAM_BOT_TOKEN",
  "MUSE_DISCORD_BOT_TOKEN",
  "MUSE_SLACK_BOT_TOKEN",
  "MUSE_MATRIX_ACCESS_TOKEN",
  "MUSE_MATRIX_HOMESERVER_URL",
  "MUSE_LINE_CHANNEL_ACCESS_TOKEN",
  "MUSE_LINE_CHANNEL_SECRET",
  "MUSE_NOTION_TOKEN",
  "MUSE_NOTION_DATABASE_ID",
  "MUSE_NOTION_TITLE_PROPERTY"
] as const;

const THIS_TEST_SOURCE = resolve(fileURLToPath(import.meta.url));

function pathFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string") return resolve(value);
  if (Buffer.isBuffer(value)) return resolve(value.toString("utf8"));
  if (value instanceof URL) return resolve(fileURLToPath(value));
  return undefined;
}

function under(root: string, value: string): boolean {
  const rel = relative(root, value);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

function localRuntimeEnv(root: string): Record<string, string> {
  const file = (name: string) => join(root, name);
  return {
    HOME: root,
    MUSE_ACTION_LOG_FILE: file("action-log.json"),
    MUSE_APPLE_NOTES_FOLDER: "Local Notes",
    MUSE_AUTH_SECRETS_FILE: file("auth-secrets.json"),
    MUSE_BELIEF_PROVENANCE_FILE: file("belief-provenance.json"),
    MUSE_CALENDAR_FILE: file("calendar.json"),
    MUSE_CALENDAR_ICS_FILE: file("calendar.ics"),
    MUSE_CALENDAR_PROVIDERS: "local,macos,gcal,caldav",
    MUSE_CHECKPOINTS_DIR: file("checkpoints"),
    MUSE_CONVERSATION_SUMMARY_FILE: file("conversation-summary.json"),
    MUSE_CREDENTIALS_ENCRYPT: "false",
    MUSE_CREDENTIALS_FILE: file("credentials-sentinel.json"),
    MUSE_LINE_CHANNEL_SECRET: "line-secret-sentinel",
    MUSE_LOCAL_ONLY: "true",
    MUSE_MACOS_CALENDAR_NAME: "Local Calendar",
    MUSE_MATRIX_ACCESS_TOKEN: "matrix-token-sentinel",
    MUSE_MEMORY_KEY: "deterministic-test-memory-key",
    MUSE_MCP_CONFIG: file("mcp.json"),
    MUSE_MCP_CREDENTIALS_FILE: file("mcp-credentials.json"),
    MUSE_MESSAGING_CREDENTIALS_FILE: file("messaging-sentinel.json"),
    MUSE_MODEL: "ollama/test",
    MUSE_MODEL_KEYS_FILE: file("models.json"),
    MUSE_NOTES_DIR: file("notes"),
    MUSE_NOTES_PROVIDERS: "local,apple,notion",
    MUSE_PERSONA_MD_FILE: file("persona.md"),
    MUSE_TASK_MEMORY_FILE: file("task-memory.json"),
    MUSE_TASKS_FILE: file("tasks.json"),
    MUSE_TELEGRAM_BOT_TOKEN: "telegram-token-sentinel",
    MUSE_TOKEN_USAGE_FILE: file("token-usage.jsonl"),
    MUSE_USER_MEMORY_FILE: file("user-memory.json"),
    USERPROFILE: root
  };
}

describe.sequential("T2-B1 local-only standard runtime containment", () => {
  it("assembles only local personal integrations with real HOME/USERPROFILE isolation and no credential/token reads", async () => {
    const root = actualFs.mkdtempSync(join(tmpdir(), "muse-local-only-runtime-"));
    const env = localRuntimeEnv(root);
    const modelFile = env.MUSE_MODEL_KEYS_FILE!;
    const credentialsFile = env.MUSE_CREDENTIALS_FILE!;
    const messagingFile = env.MUSE_MESSAGING_CREDENTIALS_FILE!;
    actualFs.writeFileSync(modelFile, JSON.stringify({ providers: {} }), "utf8");
    actualFs.writeFileSync(credentialsFile, JSON.stringify({
      providers: {
        caldav: { password: "file-password", url: "https://caldav.example.test", username: "file-user" },
        gcal: { clientId: "file-id", clientSecret: "file-secret", refreshToken: "file-refresh" },
        notion: { token: "notion-file-token" }
      }
    }), "utf8");
    actualFs.writeFileSync(messagingFile, JSON.stringify({
      providers: { telegram: { token: "file-telegram-token" } }
    }), "utf8");

    const processKeys = new Set([
      "HOME",
      "USERPROFILE",
      "MUSE_MEMORY_KEY",
      "MUSE_CREDENTIALS_ENCRYPT",
      "MUSE_CALENDAR_ENCRYPT",
      ...Object.keys(process.env).filter((key) => key.startsWith("MUSE_")),
      ...Object.keys(env)
    ]);
    const previous = new Map<string, string | undefined>([...processKeys].map((key) => [key, process.env[key]]));
    const forbiddenGets = new Set<string>();
    let modelReads = 0;
    let integrationReads = 0;
    let mockInstalled = false;
    try {
      for (const key of processKeys) delete process.env[key];
      Object.assign(process.env, env);
      process.env.MUSE_CALENDAR_ENCRYPT = "false";

      const source = new Proxy(env, {
        get(target, property, receiver) {
          if (typeof property === "string" && (FORBIDDEN_REMOTE_KEYS as readonly string[]).includes(property)) {
            forbiddenGets.add(property);
          }
          return Reflect.get(target, property, receiver);
        },
        getOwnPropertyDescriptor: Reflect.getOwnPropertyDescriptor,
        has: Reflect.has,
        ownKeys: Reflect.ownKeys
      });
      const workspaceReadAllowlist = new Set([THIS_TEST_SOURCE]);
      const recordRead = (file: string): void => {
        if (file === modelFile) modelReads += 1;
        if (file === credentialsFile || file === messagingFile) integrationReads += 1;
      };
      const requireReadPath = (candidate: unknown): void => {
        const file = pathFromUnknown(candidate);
        if (!file) return;
        recordRead(file);
        if (!under(root, file) && !workspaceReadAllowlist.has(file)) {
          throw new Error(`T2-B1 runtime attempted read outside root/fixture allowlist: ${file}`);
        }
      };
      const requireRootPaths = (...candidates: readonly unknown[]): void => {
        for (const candidate of candidates) {
          const file = pathFromUnknown(candidate);
          if (file && !under(root, file)) {
            throw new Error(`T2-B1 runtime attempted mutation outside isolated root: ${file}`);
          }
        }
      };
      const accessWrites = (mode: unknown): boolean =>
        typeof mode === "number" && (mode & actualFs.constants.W_OK) !== 0;
      const openWrites = (flags: unknown): boolean => {
        if (flags === undefined) return false;
        if (typeof flags === "number") {
          const writeBits = actualFs.constants.O_WRONLY
            | actualFs.constants.O_RDWR
            | actualFs.constants.O_APPEND
            | actualFs.constants.O_CREAT
            | actualFs.constants.O_TRUNC;
          return (flags & writeBits) !== 0;
        }
        return flags !== "r" && flags !== "rs";
      };
      const streamFlags = (options: unknown): unknown => {
        if (typeof options === "string" || typeof options === "number") {
          return options;
        }
        if (options && typeof options === "object" && "flags" in options) {
          return (options as { readonly flags?: unknown }).flags;
        }
        return undefined;
      };
      const wrapSync = <T extends (...args: never[]) => unknown>(
        fn: T,
        check: (args: Parameters<T>) => void
      ): T =>
        ((...args: Parameters<T>) => {
          check(args);
          return fn(...args);
        }) as T;
      const wrapAsync = <T extends (...args: never[]) => Promise<unknown>>(
        fn: T,
        check: (args: Parameters<T>) => void
      ): T =>
        (async (...args: Parameters<T>) => {
          check(args);
          return fn(...args);
        }) as T;

      const guardedPromises = {
        ...actualFs.promises,
        access: wrapAsync(actualFs.promises.access, (args) => {
          if (accessWrites(args[1])) requireRootPaths(args[0]); else requireReadPath(args[0]);
        }),
        appendFile: wrapAsync(actualFs.promises.appendFile, (args) => requireRootPaths(args[0])),
        chmod: wrapAsync(actualFs.promises.chmod, (args) => requireRootPaths(args[0])),
        cp: wrapAsync(actualFs.promises.cp, (args) => requireRootPaths(args[0], args[1])),
        copyFile: wrapAsync(actualFs.promises.copyFile, (args) => requireRootPaths(args[0], args[1])),
        lstat: wrapAsync(actualFs.promises.lstat, (args) => requireReadPath(args[0])),
        mkdir: wrapAsync(actualFs.promises.mkdir, (args) => requireRootPaths(args[0])),
        open: wrapAsync(actualFs.promises.open, (args) => {
          if (openWrites(args[1])) requireRootPaths(args[0]); else requireReadPath(args[0]);
        }),
        readFile: wrapAsync(actualFs.promises.readFile, (args) => requireReadPath(args[0])),
        readdir: wrapAsync(actualFs.promises.readdir, (args) => requireReadPath(args[0])),
        rename: wrapAsync(actualFs.promises.rename, (args) => requireRootPaths(args[0], args[1])),
        rm: wrapAsync(actualFs.promises.rm, (args) => requireRootPaths(args[0])),
        stat: wrapAsync(actualFs.promises.stat, (args) => requireReadPath(args[0])),
        unlink: wrapAsync(actualFs.promises.unlink, (args) => requireRootPaths(args[0])),
        writeFile: wrapAsync(actualFs.promises.writeFile, (args) => requireRootPaths(args[0]))
      };
      vi.resetModules();
      vi.doMock("node:fs", () => ({
        ...actualFs,
        accessSync: wrapSync(actualFs.accessSync, (args) => {
          if (accessWrites(args[1])) requireRootPaths(args[0]); else requireReadPath(args[0]);
        }),
        appendFileSync: wrapSync(actualFs.appendFileSync, (args) => requireRootPaths(args[0])),
        chmodSync: wrapSync(actualFs.chmodSync, (args) => requireRootPaths(args[0])),
        cp: wrapSync(actualFs.cp, (args) => requireRootPaths(args[0], args[1])),
        cpSync: wrapSync(actualFs.cpSync, (args) => requireRootPaths(args[0], args[1])),
        copyFile: wrapSync(actualFs.copyFile, (args) => requireRootPaths(args[0], args[1])),
        copyFileSync: wrapSync(actualFs.copyFileSync, (args) => requireRootPaths(args[0], args[1])),
        createReadStream: wrapSync(actualFs.createReadStream, (args) => {
          if (openWrites(streamFlags(args[1]) ?? "r")) requireRootPaths(args[0]); else requireReadPath(args[0]);
        }),
        createWriteStream: wrapSync(actualFs.createWriteStream, (args) => {
          if (openWrites(streamFlags(args[1]) ?? "w")) requireRootPaths(args[0]); else requireReadPath(args[0]);
        }),
        existsSync: wrapSync(actualFs.existsSync, (args) => requireReadPath(args[0])),
        lstatSync: wrapSync(actualFs.lstatSync, (args) => requireReadPath(args[0])),
        mkdirSync: wrapSync(actualFs.mkdirSync, (args) => requireRootPaths(args[0])),
        open: wrapSync(actualFs.open, (args) => {
          if (openWrites(args[1])) requireRootPaths(args[0]); else requireReadPath(args[0]);
        }),
        openSync: wrapSync(actualFs.openSync, (args) => {
          if (openWrites(args[1])) requireRootPaths(args[0]); else requireReadPath(args[0]);
        }),
        readFileSync: wrapSync(actualFs.readFileSync, (args) => requireReadPath(args[0])),
        readdirSync: wrapSync(actualFs.readdirSync, (args) => requireReadPath(args[0])),
        renameSync: wrapSync(actualFs.renameSync, (args) => requireRootPaths(args[0], args[1])),
        rmSync: wrapSync(actualFs.rmSync, (args) => requireRootPaths(args[0])),
        statSync: wrapSync(actualFs.statSync, (args) => requireReadPath(args[0])),
        unlinkSync: wrapSync(actualFs.unlinkSync, (args) => requireRootPaths(args[0])),
        writeFileSync: wrapSync(actualFs.writeFileSync, (args) => requireRootPaths(args[0])),
        promises: guardedPromises
      }));
      vi.doMock("node:fs/promises", () => guardedPromises);
      mockInstalled = true;

      const { createMuseRuntimeAssembly } = await import("../src/index.js");
      const { resolveCalendarIcsFile, resolveCheckpointsDir, resolveCredentialsFile, resolveLineInboxFile, resolveMessagingCredentialsFile, resolveNotesDir, resolveTasksFile } = await import("../src/provider-paths.js");
      const { defaultBeliefProvenanceFile } = await import("@muse/memory");
      const { homedir } = await import("node:os");
      const assembly = createMuseRuntimeAssembly({ env: source });

      expect(homedir()).toBe(root);
      expect(assembly.calendar.list().map((provider) => provider.id)).toEqual(["local", "macos"]);
      expect(assembly.messaging.list().map((provider) => provider.id)).toEqual(["log"]);
      expect(assembly.notesProviderRegistry?.list().map((provider) => provider.id)).toEqual(["local", "apple"]);
      expect(integrationReads).toBe(0);
      expect(modelReads).toBeGreaterThanOrEqual(1);
      expect(forbiddenGets).toEqual(new Set());

      // Regression: only an explicit source fixture can be read from the
      // workspace. Every mutation category, including a rename destination
      // and a write-capable open, is root-only across both fs APIs.
      const guardedFs = await import("node:fs");
      const guardedFsPromises = await import("node:fs/promises");
      const workspaceMuse = join(resolve(process.cwd()), ".muse", "t2b-runtime-guard-regression");
      const renameSource = join(root, "rename-source");
      const rootCopySource = join(root, "copy-source");
      const rootCopyDestination = join(root, "copy-destination");
      const rootCopyFileSyncDestination = join(root, "copy-file-sync-destination");
      const rootCopyFilePromiseDestination = join(root, "copy-file-promise-destination");
      const rootCopyFileCallbackDestination = join(root, "copy-file-callback-destination");
      const workspaceCopyDestination = join(workspaceMuse, "copied-source.ts");
      actualFs.writeFileSync(renameSource, "root-only", "utf8");
      actualFs.writeFileSync(rootCopySource, "root-only-copy", "utf8");
      expect(() => guardedFs.readFileSync(THIS_TEST_SOURCE, "utf8")).not.toThrow();
      await expect(guardedFsPromises.readFile(THIS_TEST_SOURCE, "utf8")).resolves.toContain("T2-B1 local-only standard runtime containment");
      expect(() => guardedFs.writeFileSync(workspaceMuse, "nope", "utf8")).toThrow(/outside isolated root/u);
      expect(() => guardedFs.mkdirSync(workspaceMuse)).toThrow(/outside isolated root/u);
      expect(() => guardedFs.renameSync(renameSource, workspaceMuse)).toThrow(/outside isolated root/u);
      expect(() => guardedFs.chmodSync(workspaceMuse, 0o600)).toThrow(/outside isolated root/u);
      expect(() => guardedFs.openSync(workspaceMuse, "w")).toThrow(/outside isolated root/u);
      expect(() => guardedFs.open(THIS_TEST_SOURCE, "w", () => {})).toThrow(/outside isolated root/u);
      const readableFixture = guardedFs.createReadStream(THIS_TEST_SOURCE, { flags: "r" });
      readableFixture.destroy();
      expect(() => guardedFs.createReadStream(THIS_TEST_SOURCE, { flags: "w" })).toThrow(/outside isolated root/u);
      expect(() => guardedFs.cpSync(THIS_TEST_SOURCE, workspaceCopyDestination)).toThrow(/outside isolated root/u);
      expect(() => guardedFs.cp(THIS_TEST_SOURCE, workspaceCopyDestination, () => {})).toThrow(/outside isolated root/u);
      expect(() => guardedFs.cpSync(rootCopySource, rootCopyDestination)).not.toThrow();
      expect(actualFs.readFileSync(rootCopyDestination, "utf8")).toBe("root-only-copy");
      expect(() => guardedFs.copyFileSync(THIS_TEST_SOURCE, rootCopyFileSyncDestination)).toThrow(/outside isolated root/u);
      expect(() => guardedFs.copyFileSync(rootCopySource, workspaceCopyDestination)).toThrow(/outside isolated root/u);
      expect(() => guardedFs.copyFileSync(rootCopySource, rootCopyFileSyncDestination)).not.toThrow();
      expect(actualFs.readFileSync(rootCopyFileSyncDestination, "utf8")).toBe("root-only-copy");
      await expect(guardedFsPromises.writeFile(workspaceMuse, "nope", "utf8")).rejects.toThrow(/outside isolated root/u);
      await expect(guardedFsPromises.mkdir(workspaceMuse)).rejects.toThrow(/outside isolated root/u);
      await expect(guardedFsPromises.rename(renameSource, workspaceMuse)).rejects.toThrow(/outside isolated root/u);
      await expect(guardedFsPromises.chmod(workspaceMuse, 0o600)).rejects.toThrow(/outside isolated root/u);
      await expect(guardedFsPromises.open(workspaceMuse, "w")).rejects.toThrow(/outside isolated root/u);
      await expect(guardedFsPromises.cp(THIS_TEST_SOURCE, workspaceCopyDestination)).rejects.toThrow(/outside isolated root/u);
      await expect(guardedFsPromises.copyFile(THIS_TEST_SOURCE, rootCopyFilePromiseDestination)).rejects.toThrow(/outside isolated root/u);
      await expect(guardedFsPromises.copyFile(rootCopySource, workspaceCopyDestination)).rejects.toThrow(/outside isolated root/u);
      await expect(guardedFsPromises.copyFile(rootCopySource, rootCopyFilePromiseDestination)).resolves.toBeUndefined();
      expect(actualFs.readFileSync(rootCopyFilePromiseDestination, "utf8")).toBe("root-only-copy");
      expect(() => guardedFs.copyFile(THIS_TEST_SOURCE, rootCopyFileCallbackDestination, () => {})).toThrow(/outside isolated root/u);
      expect(() => guardedFs.copyFile(rootCopySource, workspaceCopyDestination, () => {})).toThrow(/outside isolated root/u);
      {
        const copyDone = Promise.withResolvers<void>();
        guardedFs.copyFile(rootCopySource, rootCopyFileCallbackDestination, (error) => {
          if (error) {
            copyDone.reject(error);
          } else {
            copyDone.resolve();
          }
        });
        await copyDone.promise;
      }
      expect(actualFs.readFileSync(rootCopyFileCallbackDestination, "utf8")).toBe("root-only-copy");

      const resolvedPaths = [
        defaultBeliefProvenanceFile(),
        resolveCalendarIcsFile(source),
        resolveCheckpointsDir(source),
        resolveCredentialsFile(source),
        resolveLineInboxFile(source),
        resolveMessagingCredentialsFile(source),
        resolveNotesDir(source),
        resolveTasksFile(source),
        env.MUSE_CONVERSATION_SUMMARY_FILE!,
        env.MUSE_TASK_MEMORY_FILE!,
        env.MUSE_USER_MEMORY_FILE!,
        env.MUSE_PERSONA_MD_FILE!,
        env.MUSE_MCP_CONFIG!,
        env.MUSE_MCP_CREDENTIALS_FILE!,
        env.MUSE_TOKEN_USAGE_FILE!
      ];
      for (const file of resolvedPaths) {
        expect(under(root, file), `path escaped temp root: ${file}`).toBe(true);
      }
    } finally {
      if (mockInstalled) {
        vi.doUnmock("node:fs");
        vi.doUnmock("node:fs/promises");
      }
      vi.resetModules();
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      actualFs.rmSync(root, { force: true, recursive: true });
    }
  }, 60_000);
});
