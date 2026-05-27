# 623 — `muse doctor --local`'s mcp.json check now classifies the `servers` field shape — a misshapen `{servers: {…}}` or `{servers: null}` fails loudly instead of silently reporting "ok with 0 servers"

## Why

`apps/cli/src/commands-doctor.ts:runLocalDoctor` is the
operator-facing JARVIS health check — runs offline, reads
`~/.muse/mcp.json`, reports per-check status (ok / warn / fail).
The previous `mcp.json` check:

```ts
const parsed = JSON.parse(raw) as { servers?: unknown };
const servers = Array.isArray(parsed.servers) ? parsed.servers.length : 0;
checks.push({ detail: `${servers.toString()} server(s) registered`, name: "mcp.json", status: "ok" });
```

Reports `status: "ok"` whenever `JSON.parse` succeeds, regardless
of whether the `servers` field is sensibly shaped. Three real
misconfigurations end up silently labeled "ok with 0 servers":

1. **Missing `servers` key** (the user wrote
   `{"otherSetting": "x"}` and forgot the registry). Doctor says
   `0 server(s) registered, status=ok` — but MCP has no servers.
2. **Object instead of array** (`{"servers": {"foo": "bar"}}` —
   a common YAML→JSON conversion mistake). Doctor says
   `0 server(s) registered, status=ok` — but MCP would fail at
   load time with a cryptic "servers is not iterable."
3. **Null `servers`** (`{"servers": null}`). Same false-ok.

The doctor is supposed to catch these BEFORE the user hits a
mid-conversation crash. The unconditional `status: "ok"` did the
opposite: it gave operators a false-clean health check.

Step-8 redirect: not boolean-spelling (622), not test-additions
(621), not graceful-recovery (620), not blank-keyword (619), not
caps (618), not atomic-write (617), not file-mode (616). Defect
class is "diagnostic-status classification for malformed config
shape" — fresh in the recent window.

## Slice

- `apps/cli/src/commands-doctor.ts`:
  - New exported helper `classifyMcpServersField(parsed: unknown)`
    that returns `{ status: "ok" | "warn" | "fail", detail: string }`
    based on the actual shape:
    - Non-object root → `fail` ("mcp.json root must be a JSON object").
    - `servers` absent → `warn` ("no `servers` key").
    - `servers` not an array → `fail` ("must be an array, got
      <typeof>").
    - `servers` empty array → `warn` ("0 server(s) registered").
    - `servers` non-empty array → `ok` ("N server(s) registered").
  - `runLocalDoctor`'s mcp.json branch now calls the helper:
    `checks.push({ name: "mcp.json", ...classifyMcpServersField(parsed) });`
  - Helper placed next to `resolveMuseEnvPath` — same shape (pure
    sync, no I/O, exported for direct test coverage).
- `apps/cli/src/commands-doctor.test.ts`:
  - New `classifyMcpServersField` describe with five tests,
    one per shape class:
    - Non-empty array → ok.
    - Empty array → warn.
    - Missing key → warn (different message).
    - Wrong-shape `servers` (object / null / string / number /
      boolean) → fail (each reports its typeof).
    - Non-object root (null / array / string / number) → fail.

## Verify

- `@muse/cli` suite green (1057 passed, +5 vs baseline 1052, 0
  failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the helper
  body to the pre-fix shape `Array.isArray(obj.servers) ?
  obj.servers.length : 0` with hardcoded `status: "ok"` makes
  4 of 5 new tests fail:
  - Missing-key test fails (status=ok vs expected warn).
  - Wrong-shape tests fail (status=ok vs expected fail).
  - Non-object root tests fail with `TypeError: Cannot read
    properties of null (reading 'servers')` (the pre-fix
    `obj as { servers?: unknown }` cast doesn't help against
    a literal `null` parsed value — the helper crashes
    instead of classifying).
  Restoring the fix → all 5 tests green.
- `pnpm check` EXIT=0 (apps/api 261 passed, apps/cli 1062
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean on both touched files;
  `git status` shows only the two intended files plus this
  goal doc.
- No LLM request-response wire path touched; `smoke:live` does
  not apply. The doctor command runs purely against local fs +
  Ollama / SearXNG probes.

## Status

Done. The `muse doctor --local` mcp.json check now reports
honestly across every shape an operator might land:

| `mcp.json` contents              | Before                       | After                       |
| -------------------------------- | ---------------------------- | --------------------------- |
| `{"servers": [{...}]}` (valid)   | `ok` ("N registered")        | unchanged                   |
| `{"servers": []}` (empty array)  | `ok` ("0 registered")        | **`warn`** ("0 registered") |
| `{}` (no `servers` key)          | **`ok`** ("0 registered")    | `warn` ("no `servers` key") |
| `{"servers": {"foo":"bar"}}`     | **`ok`** ("0 registered")    | `fail` ("must be array")    |
| `{"servers": null}`              | **`ok`** ("0 registered")    | `fail` ("got null")         |
| `{"servers": "stringy"}`         | **`ok`** ("0 registered")    | `fail` ("got string")       |
| `null` (JSON root not object)    | **`ok`** ("0 registered")    | `fail` ("root must be object") |
| `[]` (JSON root is array)        | **`ok`** ("0 registered")    | `fail` ("root must be object") |
| Invalid JSON (parse fails)       | `fail` ("not valid JSON")    | unchanged                   |
| File absent (ENOENT)             | `warn` ("no mcp.json")       | unchanged                   |

The "empty array → warn" change is a minor honesty bump: an
explicit empty `servers` array is "well-formed but no
servers" — semantically the same as missing `mcp.json`, which
already reports `warn`.

No CAPABILITIES line / no OUTWARD-TARGETS flip: a diagnostic-
quality `fix:` on the local doctor surface, recorded honestly
with this backlog row — not a false metric.

## Decisions

- **Five distinct status outputs**, not just "ok vs fail." The
  status axis is `ok | warn | fail` — using all three lets the
  doctor distinguish "fine," "fixable nudge," "broken." A
  binary classification would lose the "0 servers in a valid
  empty array" → warn distinction.
- **Helper exported, pure-sync, no I/O.** Same shape as the
  existing `resolveMuseEnvPath` / `embedModelCheck` /
  `parseNotesIndexEmbedModel` siblings in the file — all pure
  helpers that the test file exercises directly without
  spinning up the doctor's fs+fetch surface. Keeps the
  testable surface separate from the I/O orchestration.
- **`isRecord(parsed)` first**, then `servers` key check. The
  pre-fix `obj as { servers?: unknown }` cast did NOT defend
  against `parsed === null` (the cast lies about the type;
  `null.servers` throws TypeError at runtime). The
  `isRecord` guard catches this BEFORE the property access.
- **`got ${typeof}`** in the wrong-shape message so the
  operator sees WHY the validator rejected (e.g. "got string"
  vs "got number"). A bare "must be an array" wouldn't tell
  them whether they had `"servers": "..."` or
  `"servers": 42`.
- **`got null` (not `got object`)** for the null case —
  `typeof null === "object"` would be misleading. Special-
  cased so the message points at the actual value the user
  typed.
- **Test all 5 status classes explicitly.** A combined
  "wrong shape gives fail" test would miss a regression that
  classifies object-vs-string differently. One assertion per
  primitive type pins the contract.
- **Mutation choice.** Reverted the helper body to the
  pre-fix `length || 0` + hardcoded `status: "ok"` shape —
  exactly what a maintainer "simplifying back to the original
  unconditional ok" would write. The mutation test catches
  it with 4 of 5 tests failing (one passes — the non-empty
  array case — which is the only path the pre-fix
  accidentally got right).

## Remaining risks

- **Per-server shape** (each entry has the expected
  name/transportType/config keys) isn't validated by the
  doctor. A malformed individual server entry would still
  count toward the "N registered" total but break at MCP
  load time. The doctor is intentionally lightweight here —
  full validation is `@muse/mcp`'s job at runtime. Out of
  scope.
- **Other JSON files the doctor reads** (`user-memory.json`,
  `tasks.json`, `notes-index.json`) have the same
  "JSON.parse succeeds → status ok" risk. Spot-checks in
  follow-up iters — the mcp.json case was the most
  user-visible because empty mcp.json is the second-most
  likely misconfiguration (after no-file).
- **The doctor doesn't watch mcp.json for changes**. A user
  who fixes their mcp.json after running doctor still has to
  re-run to see the green status. Pre-existing behavior;
  separate iter if a real consumer surfaces the case.
