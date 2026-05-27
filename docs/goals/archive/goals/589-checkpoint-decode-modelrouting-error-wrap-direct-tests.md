# 589 — `decodeCheckpointMessages` wraps `JSON.parse` failures as `ModelRoutingError` instead of leaking `SyntaxError`; first direct test file for `packages/agent-core/src/checkpoint.ts`

## Why

`packages/agent-core/src/checkpoint.ts` owns the codec the
`AgentRuntime` uses to persist a run's message history at each
phase boundary so a crashed/replayed run can be reconstructed.
`decodeCheckpointMessages` is the symmetric reader — load a
persisted state and decode the base64 / pipe envelope back into
`ModelMessage[]`.

The decoder's contract (matching the encoder it pairs with and
the surrounding error surface) is "any malformed checkpoint
throws `ModelRoutingError`." Two specific failure paths were
caught: an unsupported version envelope, and a payload whose
JSON shape failed `isModelMessage` validation. But a THIRD path
leaked:

```ts
const parsed = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as unknown;
```

`Buffer.from(_, "base64")` is intentionally lenient — it
silently drops chars outside the base64 alphabet rather than
erroring. So a corrupt payload like `"v1|user|notreallybase64$$"`
yields garbled UTF-8 bytes that `JSON.parse` rejects with a
`SyntaxError`. The decode call site sits inside `Array.map`,
which has no try/catch, so the `SyntaxError` propagates out of
`decodeCheckpointMessages` as the wrong error type.

Concrete trace (before fix):

```
SyntaxError: Unexpected token '�', "��ky�eɶ�{�" is not valid JSON
```

— bubbling past callers that catch `ModelRoutingError` to do
fallback / cleanup. The leak makes a corrupt checkpoint either
crash the run with a vague stack OR silently retry without
restoring state, both worse than the explicit reject the
contract documents.

Also: `checkpoint.ts` (75 LOC, 3 exported functions) had no
direct test file. The only existing test was a single
round-trip assertion inside `test/agent-runtime.test.ts`. Edge
cases — version mismatch, role-mismatch between envelope and
payload, non-object JSON primitives (number/string/array/null),
shape-rejection cases — were uncovered, so a future refactor
that subtly broke the decode contract could ship green.

Step-8 redirect: the prior 4 commits sat in the boolean-spelling
sweep (587 model) and then the calendar create/update symmetry
(588). This iteration moves to `packages/agent-core` (last
touched in goal 572 for `buildRoutineHint` strict-parse) and a
distinct defect class: error-type leak through the malformed-
input boundary on a JSON persistence codec.

## Slice

- `packages/agent-core/src/checkpoint.ts` — wrap the `JSON.parse`
  call site in a `try { ... } catch { throw new ModelRoutingError
  ("Invalid checkpoint message payload") }`. A short WHY comment
  explains the Node base64 leniency that requires the catch
  (non-derivable from the code itself).
- `packages/agent-core/test/checkpoint.test.ts` — **new direct
  test file**. 10 tests across two describes:
  - "round-trip contract" (4 tests): every supported role
    round-trips byte-for-byte, empty array round-trips, the
    full `createAgentCheckpointState` shape is losslessly
    JSON-serializable, and the default-null `metadata` /
    `output` fields are pinned;
  - "every malformed shape throws ModelRoutingError, never a
    leaky SyntaxError or TypeError" (6 tests): unsupported
    version envelope, missing-role / missing-payload segments,
    non-parseable JSON in the payload (the load-bearing
    defect this goal fixes), payload that parses to a JSON
    primitive (number/string/array/null), payload object
    missing required fields or with wrong types, and
    envelope/payload role disagreement.

## Verify

- `@muse/agent-core` suite green (657 passed, +10 vs baseline
  647, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the `try {…}
  catch {…}` wrap to the bare `const parsed = JSON.parse(…)`
  makes the "non-parseable JSON" test fail with:

      AssertionError: expected error to be instance of
      ModelRoutingError
      + Received: SyntaxError { message: "Unexpected token '�',
      \"��ky�eɶ�{�\" is not valid JSON" }

  — exactly the leak the goal targets. The other 9 tests are
  unaffected by this mutation (they exercise other branches).
  Fix restored, suite back to all green.
- `pnpm check` EXIT=0 (apps/api 249 passed, apps/cli 1040
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; `git status` shows only the two intended
  files.
- No LLM request-response wire path touched; `smoke:live` does
  not apply (per `testing.md` / iteration-loop Step 9). The
  defended path is the checkpoint-store reader / replay path,
  not the model loop.

## Status

Done. The `decodeCheckpointMessages` contract is now uniformly
"any malformed input throws `ModelRoutingError`":

| Failure                                      | Before                              | After                              |
| -------------------------------------------- | ----------------------------------- | ---------------------------------- |
| Unsupported version (`v2\|…`)                | `ModelRoutingError`                 | unchanged                          |
| Missing role or payload segment              | `ModelRoutingError`                 | unchanged                          |
| Non-parseable JSON in payload                | **`SyntaxError` (leak)**            | `ModelRoutingError` (**fixed**)    |
| JSON primitive (number / string / array)     | `ModelRoutingError` via isModelMessage | unchanged                       |
| Object with missing / wrong-typed fields     | `ModelRoutingError` via isModelMessage | unchanged                       |
| Envelope role ≠ payload role                 | `ModelRoutingError`                 | unchanged                          |

Plus the codec is now under direct first-class test coverage,
not just an integration touchpoint in `agent-runtime.test.ts`.

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness /
test-coverage `fix:` on internal-run-state persistence,
recorded honestly with this backlog row — not a false metric.

## Decisions

- **Catch around `JSON.parse` only, not the whole block.** The
  `Buffer.from(_, "base64").toString("utf8")` chain doesn't
  throw — Node's base64 decoder is lenient. The only throw point
  is `JSON.parse`. Catching just that line keeps the error-
  funnel narrow: a future refactor that adds a throw elsewhere
  (e.g. tightening the base64 step) won't be silently
  swallowed by an over-broad catch.
- **Two distinct error messages.** "Unsupported checkpoint
  message encoding" for envelope-shape failures (version, missing
  segments) and "Invalid checkpoint message payload" for
  payload-content failures (now including the JSON-parse leak
  case). Same `ModelRoutingError` type, distinguishable by
  message — useful for operators reading logs.
- **Tests include a JSON-primitive case (number / string /
  array / null).** Strictly speaking the `isModelMessage` check
  already rejects these, so they would already throw before this
  fix. Including them pins the contract that *only* objects with
  `role` + `content` are accepted — if someone "simplifies"
  `isModelMessage` later in a way that admits primitives, those
  tests catch it. The pre-existing single-line integration test
  in `agent-runtime.test.ts` covered none of these branches.
- **Envelope-role / payload-role disagreement test.** The
  decoder enforces this via `parsed.role !== role`. Worth a
  pinned test because it's a load-bearing anti-tampering check:
  the envelope role is the load-bearing index for fast filtering
  ("give me only assistant turns"), so a payload that says
  "assistant" while the envelope says "user" is a tampering /
  corruption signal, not a leniency case.
- **New test file under `packages/agent-core/test/` (not next to
  source).** Matches the dominant convention in this package —
  most agent-core tests are in `test/` not `src/`, with a few
  exceptions (`citation-sanitiser.test.ts`, `model-invocation.test.ts`,
  `hook-registry.test.ts` are next to source). The `test/`
  directory is the larger pile and matches the import-pattern
  used by `test/agent-runtime.test.ts` (which already imports
  from `../src/checkpoint.js`).

## Remaining risks

- `encodeCheckpointMessages` has no defensive output. If a
  caller passes a `ModelMessage` whose `content` is somehow a
  non-string (TypeScript would catch it at boundary, but runtime
  injection could not), the encoder happily base64s the bad
  JSON and the decoder would reject it on round-trip. Probably
  fine — the type system is the first line of defense, and the
  decoder reject is the second.
- The base64 leniency that triggers this leak is Node-wide.
  Other parts of Muse that base64-decode caller-supplied
  payloads (`apps/cli/src/commands-vision.ts` has a `data:`
  URL parser, the auth bearer-token decoder) may have the same
  shape of leak. Worth a sweep, but each call site has its own
  error type and contract — not a single helper to fix.
