# muse CLI

The `muse` command-line surface (`@muse/cli`, published as the `muse` bin). It runs
`packages/agent-core` locally in-process or connects to a remote `@muse/api` server over SSE —
same runtime, same guard/approval contracts either way, per `../../.claude/rules/engineering/cli-product.md`.

## Public surface

`apps/cli/src/command-groups.ts` defines the command families shown in `muse help`:

- **Chat & ask** — `chat`, `ask`, `recall`, `find`, `search`, `summarize`.
- **Memory & knowledge** (personal data) — `remember`, `memory`, `forget`, `notes`, `episode`,
  `learned`, `contacts`, `skills`, `persona`, `reflections`, `pattern`, `user`.
- **Planning & time** (continuity) — `today`, `continue`, `thread`, `work`, `week`, `calendar`,
  `remind`, `tasks`, `followup`, `commitments`, `checkins`.
- **Setup & status** (admin) — `onboard`, `setup`, `status`, `doctor`, `config`, `auth`,
  `privacy`, `trust`, `models`, `tui`, `export`, `import`, `maintenance`.
- **Automation & agents** (proactive) — `proactive`, `autonomy`, `daemon`, `scheduler`, `job`,
  `orchestrate`, `agents`, `swarm`, `objectives`, `playbook`, `propose`, `approval`, `approvals`,
  `actions`, `session`, `watch-folder`, `webhook`, `routine`, `board`.
- **Connections** — `mcp`, `messaging`, `inbox`, `email`, `feeds`, `web-action`, `home`, `voice`,
  `listen`.
- **Documents & analysis** — `read`, `show`, `browsing`, `demo`, `csv`.
- **Reports & history** — `brief`, `recap`, `history`, `runs`, `resume`, `open`, `glance`.
- **Diagnostics** (admin) — `metrics`, `telemetry`, `traces`.

Run `muse help` for the live, grouped listing; `muse <command> --help` for one command's flags.

### Development

```bash
pnpm --filter @muse/cli dev -- <command>   # tsx src/index.ts, no build step
pnpm --filter @muse/cli build               # tsc -b, produces the ./dist bin
```

## Depends on

`@muse/cli` depends on nearly every domain package in the monorepo (agent-core, attunement,
autoconfigure, browser, calendar, domain-tools, fs, macos, mascot, mcp, mcp-shared, memory,
messaging, model, multi-agent, policy, proactivity, prompts, recall, runtime-state, auth,
scheduler, shared, skills, stores, tools, voice, windows) — it is the local-execution surface
that assembles the whole runtime, per `../../.claude/rules/engineering/cli-product.md`.

## Rules that bind this package

- Local mode runs `packages/agent-core` in-process; remote mode connects to `@muse/api` over
  SSE; both share the same guard semantics — never fork agent behavior between the two, per
  `../../.claude/rules/engineering/cli-product.md`.
- Risky local execution goes through `crates/runner` as a child process, never inline.
- Credentials use the OS keychain or the encrypted auth store, never plaintext
  (`credential-store.ts`), per `../../.claude/rules/engineering/cli-product.md` and
  `../../.claude/rules/engineering/commits.md`.
- A new command ships with a unit test for its parser plus a smoke test for its run path, per
  `../../.claude/rules/engineering/cli-product.md`.

## Tests

`pnpm --filter @muse/cli test`
