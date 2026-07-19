import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let activeLease;

function isolatedState(home) {
  const muse = join(home, ".muse");
  return {
    HOME: home,
    MUSE_ACTION_LOG_FILE: join(muse, "action-log.json"),
    MUSE_ATTUNEMENT_FILE: join(muse, "attunement.json"),
    MUSE_BELIEF_PROVENANCE_FILE: join(muse, "belief-provenance.json"),
    MUSE_CALENDAR_FILE: join(muse, "calendar.json"),
    MUSE_CHECKPOINTS_DIR: join(muse, "checkpoints"),
    MUSE_CLI_CONFIG_FILE: join(home, ".config", "muse", "config.json"),
    MUSE_CONVERSATION_SUMMARY_FILE: join(muse, "conversation-summaries.json"),
    MUSE_LOCAL_ONLY: "true",
    MUSE_PROGRESSIVE_AUTONOMY_FILE: join(muse, "progressive-autonomy.json"),
    MUSE_PROGRESSIVE_AUTONOMY_OPPORTUNITIES_FILE: join(muse, "progressive-autonomy-opportunities.json"),
    MUSE_TASK_MEMORY_FILE: join(muse, "task-memory.json"),
    MUSE_TOKEN_USAGE_FILE: join(muse, "token-usage.jsonl"),
    MUSE_USER_MEMORY_AUTO_EXTRACT: "false",
    MUSE_USER_MEMORY_FILE: join(muse, "user-memory.json"),
    USERPROFILE: home,
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share")
  };
}

/**
 * Install a process-wide disposable HOME before importing/configuring the live
 * Muse assembly. Eval batteries are deliberately sequential: overlapping
 * leases would race through process.env, so a second lease fails closed.
 */
export async function createEvalTrialEnvironment({ overrides = {}, prefix = "muse-eval-trial-" } = {}) {
  if (activeLease) {
    throw new Error("A process-wide eval trial environment is already active");
  }

  const token = Symbol("eval-trial-environment");
  activeLease = token;
  let root;
  try {
    root = await mkdtemp(join(tmpdir(), prefix));
    const home = join(root, "home");
    const fixtureDir = join(root, "fixture");
    await Promise.all([mkdir(home, { recursive: true }), mkdir(fixtureDir, { recursive: true })]);

    const inheritedStatePaths = Object.keys(process.env).filter((key) =>
      /^MUSE_[A-Z0-9_]+_(?:DIR|FILE)$/u.test(key)
    );
    const installed = { ...isolatedState(home), ...overrides };
    const touchedKeys = new Set([...inheritedStatePaths, ...Object.keys(installed)]);
    const prior = new Map([...touchedKeys].map((key) => [key, process.env[key]]));
    for (const key of inheritedStatePaths) delete process.env[key];
    Object.assign(process.env, installed);
    let disposed = false;

    return {
      env: { ...process.env },
      fixtureDir,
      home,
      root,
      async dispose() {
        if (disposed) return;
        disposed = true;
        try {
          for (const [key, value] of prior) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        } finally {
          if (activeLease === token) activeLease = undefined;
          await rm(root, { force: true, recursive: true });
        }
      }
    };
  } catch (cause) {
    if (activeLease === token) activeLease = undefined;
    if (root) await rm(root, { force: true, recursive: true }).catch(() => {});
    throw cause;
  }
}
