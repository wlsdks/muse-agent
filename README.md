# Muse
사용자에게 아이디어를 주고, 선택을 도와주는 영감형 AI Agent

## Development

Muse is being migrated as a TypeScript-first, model-agnostic agent platform.

Required target runtime:

- Node.js 24 LTS
- pnpm 10+

Current workspace commands:

```bash
pnpm install
pnpm build
pnpm test
```

Useful smoke checks:

```bash
node apps/cli/dist/index.js spec --json
```

Production persistence wiring:

- Pass a `Kysely<MuseDatabase>` handle to `createMuseRuntimeAssembly({ db })` or `createApiServerOptions({ db })`.
- With `db`, agent specs, run history, hook traces, runtime settings, MCP registry, scheduler state,
  and admin operations use Kysely-backed stores.
- Without `db`, the same API surface runs on in-memory stores for local development and tests.
