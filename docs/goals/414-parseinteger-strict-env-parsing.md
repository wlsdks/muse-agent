# 414 — `parseInteger` rejects lenient-garbage env values

## Why

Config-correctness/safety fix on a fresh axis (`@muse/autoconfigure`
env-parsers — never touched by the recent
scheduler/calendar/mcp/policy/cli cluster), broad blast radius:
`parseInteger` configures `MUSE_OLLAMA_NUM_CTX` (the Qwen context
window — the loop's own mandated provider path), cache size/TTL,
SLO cooldown/latency/min-samples/window, drift window, budget
warning percent.

The module's documented contract is explicit: "invalid input maps
to the fallback, so a typo'd MUSE_* var won't abort runtime boot",
and `parseBoolean` was previously hardened for exactly this ("a
typo'd value silently producing the wrong thing regardless of the
caller's fallback intent"). `parseInteger` violated that contract:
it used `Number.parseInt(value, 10)`, which is lenient — it reads
leading digits and ignores trailing garbage. Probed:

```
parseInteger("60x", 1000)  → 60      (should fall back to 1000)
parseInteger("16k", 8192)  → 16      (num_ctx=16 ⇒ every Qwen prompt truncated)
parseInteger("1e3", 10)    → 1       (not 1000)
parseInteger("3.9", 1)     → 3
parseInteger("10abc", 5)   → 10
```

A typo'd `MUSE_PROACTIVE_TICK_MS=60x` or `MUSE_OLLAMA_NUM_CTX=16k`
silently mis-configured a timing-critical daemon / the model
context window instead of falling back to the safe default — the
exact silent-misconfig footgun `parseBoolean` was fixed for, left
in its integer sibling. Test coverage was 2 assertions (`"42"`,
`"bad"`); every garbage case was uncovered.

## Slice

- `packages/autoconfigure/src/env-parsers.ts` — `parseInteger`
  now requires the whole trimmed token to be a plain decimal
  integer (`/^[+-]?\d+$/`) before `Number(...)` + the existing
  `> 0` gate. Whitespace, leading zeros, and an explicit sign
  still parse; trailing garbage / hex / exponent / float now fall
  back, consistent with the module contract. Dropped the one
  forbidden `Goal 128 —` marker from the adjacent `parseBoolean`
  docstring in this file (rides inside the change; not a sweep).
- `packages/autoconfigure/test/autoconfigure.test.ts` — regression
  pinning the garbage set falls back (`60x`/`16k`/`10abc`/`3.9`/
  `1e3`/`0x10`) and that valid forms still parse
  (`"  5  "`/`"007"`/`"+12"`), with `-3`/`0` → fallback.

## Verify

- `@muse/autoconfigure` full suite 139/139 (was 138, +1); the
  garbage cases fail on the pre-fix code (`"60x"` → 60).
- `pnpm check` EXIT=0, every workspace green (autoconfigure 139,
  api 194, cli 717, …); tsc strict (autoconfigure) clean; `pnpm
  lint` 0/0; `pnpm guard:core` clean; byte-scan clean.
- Pure parser, no request/response (LLM) path — no `smoke:live`
  applies. autoconfigure drives the cross-package runtime
  assembly so the full `pnpm check` was the gate.

## Status

Done. A typo'd integer `MUSE_*` env var now falls back to its
safe default (the documented contract) instead of silently
truncating to a leading-digit prefix — most importantly
`MUSE_OLLAMA_NUM_CTX`, where the old behavior could shrink the
Qwen context window to a handful of tokens and break every
request without any error.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]`; this is a config-safety fix to an existing parser,
recorded honestly as a `fix(autoconfigure):` change with this
backlog row — not a false metric.

## Decisions

- Regex-gate to plain decimal integers rather than `Number()`
  alone: `Number("0x10")`/`Number("1e3")` are finite integers, so
  `Number`-only would silently accept hex/exponent env values —
  surprising and not what an operator means by an integer var.
  "Looks like a plain integer or fall back" is the least-
  surprising, contract-faithful rule.
- Left the sibling float parsers (`parsePositiveFloat`, …)
  unchanged: they `Number.parseFloat` + range-check, a separate
  (smaller) leniency with its own fallback semantics — bundling
  it would widen scope beyond the observed integer footgun.
