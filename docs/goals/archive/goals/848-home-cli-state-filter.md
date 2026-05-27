## 848 — feat: `muse home entities --state` — "what's left on?" from the terminal

## Why

831 gave the AGENT a `state` filter on `home_entities` ("what lights
are on / is anything unlocked"), but the `muse home entities` CLI had
only `--domain` — a terminal user had to eyeball the full entity list
to spot what's left on. Same CLI-parity pattern as 833 (calendar free),
843 (inbox ★), 845 (weather --days).

## Slice

`apps/cli` commands-home.ts — `muse home entities` gained `--state
<value>` (case-insensitive): combines with `--domain`, so `muse home
entities --domain light --state on` answers "what lights are on?" and
`--state unlocked` answers "is anything unlocked?". Omitting `--state`
is the prior list-everything behaviour. The empty-result message names
the domain + state that matched nothing.

## Verify

`apps/cli` commands-home.test.ts (+3, 10 total), the REAL
`listHomeAssistantStates` over an injected `/api/states` fetch:
- `--state ON` returns only the `on` light (case-insensitive), not the
  off light or the lock;
- without `--state`, every entity is listed (unchanged);
- `--state unlocked` → "No entities found … state 'unlocked'" when the
  only lock is locked.
- The existing 7 home tests stay green. **Mutation-proven**: dropping
  the `state` filter (return all) breaks both `--state` tests.
  `apps/cli` 133/133, `pnpm check` EXIT 0 (0 non-voice failures), `pnpm
  lint` 0/0. CLI read + display, no LLM request/response path → no
  smoke:live.

## Decisions

- **Client-side filter over the fetched list** (same as 831's tool) —
  HA's `/api/states` returns everything; an exact case-insensitive
  state match is precise, zero extra round-trips, and reuses the
  retry-hardened `listHomeAssistantStates`.
- Mirrors the agent's `home_entities` state filter on the terminal —
  the CLI-parity pattern this session has used for calendar/inbox/
  weather. CAPABILITIES line under the CLI smart-home surface (no
  bullet flip).
