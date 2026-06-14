/**
 * `muse demo` — the zero-setup front door.
 *
 * A first-time user with no notes ingested and nothing configured can
 * still SEE Muse's edge in one command: it points the REAL `muse ask`
 * recall path at a bundled sample corpus (shipped with the package) in
 * an isolated temp home, then runs two scripted questions —
 *   1. an ANSWERABLE one, to show a cited answer with an openable source,
 *   2. a MUST-REFUSE one, to show an honest "I'm not sure" (fabrication=0).
 *
 * It NEVER touches the user's real `~/.muse`: `MUSE_NOTES_DIR` +
 * `MUSE_NOTES_INDEX_FILE` are repointed at the sample corpus and a temp
 * index for the duration of the spawned `ask` calls only.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * The sample corpus ships under the package root (`sample-corpus/`),
 * one level above both `src/` (dev/tsx) and `dist/` (built), so the
 * same relative climb resolves in either layout. Falls back to the
 * repo fixtures seed if the packaged copy is absent.
 */
export function resolveDemoCorpusDir(moduleDir: string = MODULE_DIR): string {
  const packaged = join(moduleDir, "..", "sample-corpus", "notes");
  if (existsSync(packaged)) {
    return packaged;
  }
  return join(moduleDir, "..", "..", "..", "fixtures", "mock-corpus", "notes");
}

/**
 * The bundled corpus is 6 small notes; injecting this many chunks
 * guarantees every note is in context (well under `ask`'s top-K cap of
 * 20), so the demo's answerable question is never lost to ranking.
 */
const DEMO_CORPUS_SIZE = 12;

export interface DemoQuestion {
  readonly kind: "answerable" | "refuse";
  readonly question: string;
  readonly expect: string;
}

/**
 * Drawn from the bundled corpus oracle (`EXPECTED.md`): two ANSWERABLE
 * questions that cite DIFFERENT notes (so the demo shows the edge is real
 * across the corpus, not a single lucky hit), then one MUST-REFUSE the
 * corpus can't ground — so the first 30 seconds show both halves of the
 * edge: cited recall AND honest refusal.
 */
export const DEMO_QUESTIONS: readonly DemoQuestion[] = [
  {
    kind: "answerable",
    question: "What MTU did I set for the WireGuard VPN?",
    expect: "cites 2026-03-03-vpn-wireguard.md and answers 1380"
  },
  {
    kind: "answerable",
    question: "When is rent due and how much?",
    expect: "cites tasks/finances.md and answers the 25th, $1,450"
  },
  {
    kind: "refuse",
    question: "What's my sister's birthday?",
    expect: 'honest "I\'m not sure" — nothing in the corpus covers it'
  }
];

export interface DemoEnvOptions {
  readonly corpusDir: string;
  /** A throwaway home dir; every `~/.muse/*` default redirects here. */
  readonly home: string;
}

/**
 * The env overrides that isolate the demo from the user's real
 * `~/.muse`. Overriding HOME (and Windows' USERPROFILE) is the single
 * lever that redirects EVERY default `~/.muse/*` path — notes index,
 * tasks, reminders, episodes — into a throwaway dir, so the demo can
 * never read or write the user's real tasks/reminders/notes. The notes
 * dir is then pointed explicitly at the bundled sample corpus.
 */
export function buildDemoEnv(base: NodeJS.ProcessEnv, opts: DemoEnvOptions): NodeJS.ProcessEnv {
  return {
    ...base,
    HOME: opts.home,
    USERPROFILE: opts.home,
    MUSE_NOTES_DIR: opts.corpusDir,
    MUSE_NOTES_INDEX_FILE: join(opts.home, ".muse", "notes-index.json"),
    MUSE_LOCAL_ONLY: "true"
  };
}

export type DemoAskRunner = (question: string, env: NodeJS.ProcessEnv) => void | Promise<void>;

const defaultAskRunner: DemoAskRunner = (question, env) => {
  const entry = process.argv[1];
  if (!entry) {
    throw new Error("muse demo: cannot resolve the CLI entrypoint to run `muse ask`");
  }
  // Inject every sample note (corpus is tiny) so a relevant note can
  // never be ranked out of the top-K — a false refusal on a question
  // the demo corpus DOES answer would misrepresent the edge.
  spawnSync(process.execPath, [entry, "ask", question, "--top", String(DEMO_CORPUS_SIZE)], {
    stdio: "inherit",
    env
  });
};

export function registerDemoCommand(
  program: Command,
  io: ProgramIO,
  deps: { readonly askRunner?: DemoAskRunner; readonly corpusDir?: string } = {}
): void {
  const askRunner = deps.askRunner ?? defaultAskRunner;
  program
    .command("demo")
    .description("Try Muse on a bundled sample corpus — cited answer + honest refusal, zero setup")
    .action(async () => {
      const corpusDir = deps.corpusDir ?? resolveDemoCorpusDir();
      const home = join(tmpdir(), "muse-demo-home");
      const env = buildDemoEnv(process.env, { corpusDir, home });

      io.stdout("Muse demo — answering from a bundled sample corpus.\n");
      io.stdout("Running only on your machine; nothing leaves. (No setup, no real notes touched.)\n\n");

      for (const q of DEMO_QUESTIONS) {
        const label = q.kind === "answerable" ? "Answerable" : "Should refuse";
        io.stdout(`── ${label} ──\n❓ ${q.question}\n`);
        await askRunner(q.question, env);
        io.stdout("\n");
      }

      io.stdout("That's the edge: a cited answer when your notes cover it, an honest \"I'm not sure\" when they don't.\n");
      io.stdout("Point it at your own notes with `muse ingest` / `muse notes ingest`, then `muse ask`.\n");
    });
}
