# 001 — API default port conflict

## Why

Both `apps/api` (Muse REST + chat) and `apps/web` (Next.js) default to
port 3000. On the dev box where the web is up, `muse remind list` /
`muse tasks list` / etc. hit the web's 404 instead of the API and
fail. Iter shipped a one-line error hint (1e1af3f); the underlying
port collision is still there.

## Scope

Pick one of:
- (a) Switch `apps/api/src/index.ts` default `PORT` to e.g. `3030`.
  Update CLI defaultBaseUrl in `program-helpers.ts` to match. Update
  CLAUDE.md / docs.
- (b) Keep `3000` but make the CLI try `3030` as fallback when the
  first probe returns HTML.

(a) is simpler + less magical. Prefer it.

## Verify

- `pnpm check`, `pnpm lint`, `pnpm smoke:broad`, `pnpm smoke:live`.
- `node ./apps/cli/dist/index.js remind list` against a freshly-
  started `pnpm --filter @muse/api dev` succeeds.
- No remaining `:3000` hardcode in CLI / API beyond the env-override
  fallback chain.

## Status

open
