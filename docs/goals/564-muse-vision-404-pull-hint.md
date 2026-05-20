# 564 — `muse vision` surfaces actionable `ollama pull <model>` hint on Ollama 404 (model-not-installed UX)

## Why

Step-8 redirect onto a fresh surface (`muse vision`) with a
fresh defect class: error-UX completeness. The recent polish
sweep covered comparator-determinism, persona CLI write surface,
calendar/scheduler validation parity, autoconfigure integer
overflow. This iteration improves the vision command's
failure path so a user whose model isn't installed gets an
actionable next-step instead of just the raw JSON body.

Pre-fix (`commands-vision.ts:152-156`):

```ts
if (!response.ok) {
  const body = await response.text().catch(() => "");
  io.stderr(`muse vision: Ollama ${response.status.toString()} — ${body.slice(0, 200)}\n`);
  process.exitCode = 1;
  return;
}
```

When Ollama is reachable but the requested model isn't pulled,
Ollama returns HTTP 404 with a body like:

```
{"error":"model 'llama3.2-vision:latest' not found, try pulling it first"}
```

The user sees:

```
muse vision: Ollama 404 — {"error":"model 'llama3.2-vision:latest' not found, try pulling it first"}
```

Technically correct — Ollama's own text says "try pulling it
first" — but the actionable command (`ollama pull
llama3.2-vision`) isn't there. The user has to know to strip
the `:latest` tag manually. Same fail-soft path the
`Ollama unreachable` branch (line 144-148) handles correctly
for the unreachable-at-all case: it prints `ollama pull
<base>` with the model id reduced to its base. The 404
branch was the asymmetry.

The fix mirrors the unreachable-branch's actionable hint
shape for the 404-specific case while keeping other statuses
(5xx, 400, etc.) on the generic message — those don't mean
"model missing", so adding the pull hint would be wrong.

## Slice

- `apps/cli/src/commands-vision.ts` — extracted a new pure
  helper `formatOllamaVisionFailure({status, body, model})`
  that returns the formatted stderr message. The action's
  `!response.ok` branch now calls it instead of inlining the
  formatting. Exported so the test can pin the 404-vs-other
  branching without driving a real Ollama instance.
- `apps/cli/test/program.test.ts` — added one focused
  `it(...)` covering: 404 with the `llama3.2-vision:latest`
  body surfaces `Pull it with: ollama pull llama3.2-vision`
  (base id, tag stripped); tag-less model id (`llava`)
  passes through as the pull target unchanged; 500 + 400
  keep the generic shape with NO pull hint (those don't
  mean model-missing).

## Verify

- New `it(...)` green; full `@muse/cli` suite green (1001
  passed, +1 vs baseline 1000, 0 failed); tsc strict
  EXIT=0.
- **Clean-mutation-proven** (Edit-based): collapsing
  `formatOllamaVisionFailure` to just the generic
  `muse vision: Ollama <status> — <body>` line (removing
  the 404 branch) makes the new test fail with
  `expected notInstalled to contain "Pull it with: ollama
  pull llama3.2-vision"` — the actionable hint is gone.
  Fix restored, suite back to all green.
- `pnpm check` EXIT=0, every workspace green (apps/api 244
  passed, apps/cli 1001 passed); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean; `git status` shows
  only the three intended files.
- Pure error-formatting helper — no LLM request-response
  wire path actually invoked (the helper formats a status/
  body/model triple deterministically; the real Ollama
  round-trip is the existing untrimmed path). `smoke:live`
  does not apply for this change (the change is on the
  failure-message branch, not the success path).

## Status

Done. The two failure surfaces in `muse vision` now both
emit the actionable `ollama pull <base>` command:

| Failure case | Pre-fix UX | Post-fix UX |
| --- | --- | --- |
| Ollama unreachable (network) | `ollama serve` + `ollama pull <base>` hint | unchanged (was already correct) |
| Ollama 404 (model not pulled) | raw body dump | `Pull it with: ollama pull <base>` |
| Ollama 5xx / 400 / other | raw body dump | unchanged (correct — not a missing model) |

No CAPABILITIES line / no OUTWARD-TARGETS flip: an
error-UX hardening on an existing P0 sensory-input surface,
recorded honestly with this backlog row — not a false
metric.

## Decisions

- Extracted `formatOllamaVisionFailure` as an exported pure
  helper rather than inlining the 404 branch. Reason: the
  pure helper is directly unit-testable without driving a
  real Ollama instance or capturing process stderr. Same
  testability widening pattern goals 539/540/547/548 used.
- 404 is the SPECIFIC trigger for the pull hint. Reason:
  Ollama returns 404 ONLY for "model not found"; every
  other status indicates a different failure (5xx server,
  400 bad request, etc.). Adding the pull hint
  unconditionally would be wrong (a 500 from the Ollama
  daemon isn't a missing-model problem). The test pins
  this by asserting `not.toContain("Pull it with")` on
  500 and 400.
- The model base is computed with `model.split(":")[0]`
  matching the unreachable-branch (line 146) byte-for-
  byte. Reason: consistency across the two failure
  paths; if a future iteration changes the base-id
  derivation, both paths track together.
- The raw body still appears in the output (parenthesised
  `Ollama response: …`). Reason: operators debugging
  weird Ollama versions / corrupted bodies need the
  underlying text. Stripping it would lose evidence.
- Did NOT change the unreachable-branch behaviour — it
  was already correct (surfaces `ollama serve` + `ollama
  pull <base>`). One asymmetry per iteration.
- Step-8 sub-defect-class check: error-UX completeness is
  distinct from comparator-determinism (551/555/556),
  paired-function-parity (557/558/560/562/563),
  trim-symmetry (559), and integer-overflow (561). Fresh
  defect class this turn.
