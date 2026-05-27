# 427 — `MUSE_*` path overrides expand a leading `~`

## Why

Config-correctness fix on a fresh axis (`@muse/autoconfigure`
`provider-paths.ts` — the single shared resolver chokepoint that
decides WHERE every piece of Muse's personal state lives:
tasks / reminders / objectives / credentials / messaging creds /
notes dir / calendar / episodes / inbox cursors / … ~28
resolvers). High blast radius.

`resolveDotMusePath` returned a non-empty env override **verbatim**.
A `MUSE_*` path override very commonly carries a leading `~`
(the docs themselves show `~/.muse/...`), but **nothing expands
it** in the contexts Muse is deployed: Node never expands `~`;
systemd `Environment=`, Docker `-e`, `.env` files, and quoted
shell assignments (`MUSE_TASKS_FILE="~/x.json"`) all pass the
literal `~`. Probed (built dist):

```
resolveTasksFile({MUSE_TASKS_FILE:"~/muse-x.json"})  → "~/muse-x.json"   (literal!)
```

Consequence: the user's tasks / reminders / **credentials** land
under a bogus `./~/` directory in the process CWD instead of
their home — silent data scatter, creds in an unexpected world
location, and no round-trip with the default `~/.muse/...` path.

## Slice

- `packages/autoconfigure/src/provider-paths.ts` — add
  `expandLeadingTilde` and apply it to the override inside the
  shared `resolveDotMusePath`, so the single fix corrects **all**
  resolvers at once. Rules: `~` → `homedir()`; `~/…` (and the
  Windows `~\…`) → `join(homedir(), …)`; a `~` not at the start
  and `~otheruser` are left literal (unambiguous current-user
  forms only — the standard safe subset). Default branch
  unchanged (it is already absolute).
- `packages/autoconfigure/test/autoconfigure.test.ts` — extend
  the existing dot-muse-resolver test: `~/x` / `~/notes/t` /
  `~` expand to the home dir; `/data/~bk/…` and `~bob/…` stay
  literal. Fails on the pre-fix code (`~/muse-x.json` returned
  verbatim).

## Verify

- `@muse/autoconfigure` resolver test passes with the tilde
  cases; full `@muse/autoconfigure` suite green (8 files / 139);
  tsc strict clean.
- `pnpm check` EXIT=0, every workspace green (autoconfigure 139,
  api 194, cli 731, …); `pnpm lint` 0/0; `pnpm guard:core`
  clean; byte-scan clean.
- Pure deterministic path resolver verified with fixtures + a
  probe; not a model request/response path — no `smoke:live`
  applies. autoconfigure drives the cross-package runtime
  assembly so the full `pnpm check` was the gate.

## Status

Done. A `MUSE_*_FILE` / `MUSE_*_DIR` override that starts with
`~` now resolves to the user's home directory across every
personal-state resolver, instead of silently writing state into
a literal `./~/` folder. One shared-chokepoint fix corrects all
~28 resolvers consistently.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]`; a config-correctness fix to an existing shared
helper, recorded honestly as a `fix(autoconfigure):` change with
this backlog row — not a false metric.

## Decisions

- Fixed at the shared `resolveDotMusePath` chokepoint (not
  per-resolver): one change, all paths consistent, zero drift —
  the same single-source rationale as goals 413/415.
- Only the unambiguous current-user forms (`~`, `~/`, `~\`)
  expand; `~otheruser` (POSIX other-home) and a mid-path `~` are
  left literal — expanding those is ambiguous/rare and would be
  speculative over-reach beyond the observed footgun.
