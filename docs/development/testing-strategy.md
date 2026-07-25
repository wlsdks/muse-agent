# Testing strategy (TypeScript 7, reviewed 2026-07-17)

This is Muse's supported testing decision, not a library wish list. The goal is
fast evidence in the edit loop and high-confidence evidence at the merge gate.
Choose the cheapest technique that can expose the actual failure mode; do not
use test count, coverage percentage, or a fashionable tool as a proxy for value.

## Decision

| Need | Supported technique | Tool |
| --- | --- | --- |
| Exact pure behavior, policy, reducer, parser example | deterministic example test | Vitest |
| Large input space or invariant at an untrusted boundary | property-based test with reproducible seed and shrinking | fast-check + `@fast-check/vitest` |
| Provider/client wire contract with an injected seam | input-sensitive fake; assert method, URL, headers, body, timeout, abort | Vitest |
| React markup only | server/static render | Vitest + `renderToStaticMarkup` |
| React focus, keyboard, hooks, or DOM interaction | component in a real browser | Vitest Browser Mode + Playwright + `vitest-browser-react` |
| Critical user journey across built assets/API | black-box E2E | Playwright Test |
| PostgreSQL semantics or migrations | disposable real PostgreSQL | Testcontainers |
| Small dependency-free `.mjs` script | built-in runner | `node:test` |
| Stochastic agent behavior | terminal-state eval, deterministic scorer, strict `pass^k` | Muse eval harness |

The agent layer has additional requirements that runner choice cannot solve:
isolated trials, terminal world-state grading, narrow trace invariants,
reliability repeats, injected failures, adversarial safety, and local
trace-to-golden-case review. The research and Muse adoption decisions are in
[`ai-agent-testing-strategy.md`](ai-agent-testing-strategy.md).

## Risk-based minimum gate matrix

The technique table chooses a tool. This matrix decides the **minimum evidence
depth** for a change. Apply every touched row; when rows overlap, use the
highest-risk evaluator and live/preflight rule while retaining each
platform-specific gate. The role and write boundaries come from
[`harness/core/team-roles.md` §1.5](../../harness/core/team-roles.md).

| Change surface | Deterministic base | Required real platform | Failure, corruption, and rollback | Controlled-live / preflight | Independent evaluator and PASS rule |
| --- | --- | --- | --- | --- | --- |
| Pure deterministic code | Named examples for exact behavior and no collateral mutation; add seeded property tests only for a genuine large-space invariant or untrusted boundary. Run the affected typecheck/lint and `test:changed`. | None unless the code consumes a platform contract hidden by a fake. | Exercise invalid, empty, boundary, cancellation, and retry inputs that the contract admits; mutation-RED the guarded branch. | Not required. A live result cannot replace the deterministic contract. | Fresh evaluator re-runs the named acceptance checks from the diff; every criterion must pass. |
| UI / browser interaction | Static markup/contract tests plus reducer or API tests below the view. | Real Chromium Browser Mode for focus, keyboard, effects, visibility, responsive layout, and DOM events; Playwright E2E for a critical built-assets/API journey. | Observe loading, empty, validation, error, cancel, retry, and stale-state behavior; prove no unrelated state mutation. Visual snapshots alone are insufficient. | Use an isolated local build/profile and controlled fixture. A real user profile/account, upload, download, clipboard, or external effect requires its own approval and higher-risk row. | Fresh evaluator operates the isolated browser from acceptance criteria and measured observations; Node/static green cannot substitute for the browser gate. |
| Persistent store / schema / migration | Exact serialization and query examples plus seeded round-trip/invariant properties at JSON/schema boundaries. | Real file-store path and disposable PostgreSQL/Testcontainers when PostgreSQL semantics, migration, locking, JSONB, or ordering matter. | Corrupt/truncated/version-skewed state, partial write, restart, concurrent access, backup, restore, and rollback; assert owner data and unrelated rows remain byte-stable. | Run upgrade/restore/rollback preflight only on a disposable database or temporary HOME copy; never on owner state. | Fresh Sol/high evaluator reproduces round-trip, corruption, and rollback from a clean fixture. In-memory green cannot substitute for a required backend. |
| Permission / approval / outbound send | Exact allow/deny tests bind action, effect, recipient, account, freshness, and one-shot consumption; property/adversarial tests cover unknown and attacker-controlled inputs. | Exercise the real guard/hook/approval chokepoint in an isolated fixture. Browser/computer surfaces also inherit the UI row. | Denial, stale/replayed approval, recipient ambiguity, cancellation, timeout, retry, and partial failure must create no send, grant widening, or collateral mutation. | Draft/preflight or a fake/local sink only. Never perform an unapproved real third-party send; lack of controlled-live proof remains `unverified`, not PASS. | Fresh Sol/high evaluator checks deny paths and authority separation; security/credential final gates use fresh Sol/xhigh. |
| Release / publication | Validate manifest/schema, HEAD, creation time, input hash/provenance, version, and required-check inventory deterministically. | Fresh checkout reruns the full impacted build/test matrix, including Chromium and PostgreSQL gates when touched. | Reproduce stale/tampered artifact refusal, upgrade/downgrade or install rollback, failed pre-push/preflight, and recovery without moving an immutable tag. | Fresh release preflight and rollback artifact are mandatory. Evaluator PASS is not permission to push, tag, publish, or release. | Fresh Sol/xhigh evaluator must reproduce the gate. Local unit green, an old artifact, or a skipped live/preflight check cannot establish release-ready. |

Evidence is conjunctive, not a score. A lower row's green tests cannot replace a
required real-browser, real-backend, corruption, controlled-live, provenance,
rollback, or fresh-evaluator gate. `skipped`, unavailable hardware/provider, and
missing credentials are `unverified`; they do not become PASS and do not block
unrelated ready work in another lane.

Keep Vitest as the primary runner. It is Vite-native, understands ESM/TS/JSX
without using the TypeScript compiler API, supplies mature mocks/fake timers,
and supports projects, browser mode, sharding, and V8 coverage. Replacing it
with Jest, Node's runner, or uvu would add migration and transform cost without
closing a Muse defect. `node:test` remains the right small tool for standalone
installer scripts.

## TypeScript 7 compatibility

Muse builds and type-checks the project graph with the TS7 native compiler.
Vitest transforms test code with Vite/Oxc; it does not require the `typescript`
compiler API. The `typescript` module therefore stays on the TS6 compatibility
package for typescript-eslint/knip, alongside the TS7 `tsc` executable. A test
library is acceptable only if its public types pass `pnpm typecheck:fast` under
this split. Playwright tests are transformed, not type-checked, so the TS7 build
must remain a separate required gate.

## Technique rules

### 1. Assert behavior at the narrowest stable boundary

- Name the regression or invariant the test protects.
- Assert returned values, persisted state, emitted protocol data, accessibility
  role/name, or terminal world state. Avoid private fields and exact internal
  call sequences unless ordering is itself the contract.
- One exact example is better than a broad assertion such as "defined",
  "non-empty", or "did not throw" when a precise value is knowable.
- For failure paths, assert no partial or unrelated mutation.

### 2. Make new tests capable of becoming red

Before trusting a new regression test, reproduce the defect or temporarily
break the guarded branch and confirm the new test fails. Restore the source and
confirm green. This mutation-RED check prevents vacuous fakes and assertions.
Do not add a mutation framework to every run: full mutation testing would be
too slow for this repository; use focused mutation on safety, persistence,
routing, and state-transition seams.

### 3. Use property tests only for genuine invariants

Good targets are untrusted JSON/parser boundaries, serialization round trips,
message-pair integrity, fail-close guards, redaction, URL/path normalization,
and deterministic reducers. Keep precise examples for named edge cases. A
property must be deterministic on replay, surface its seed/counterexample, and
have a bounded run count; never write ad-hoc `Math.random()` fuzz loops.

### 4. Use the real platform where simulation hides the bug

Static React rendering stays fast and useful for markup. It cannot prove focus,
keyboard behavior, effects, visibility, or real DOM event semantics. Put those
tests in `*.browser.test.tsx` and run `pnpm --filter @muse/web test:browser`.
Browser Mode uses Playwright/CDP and accessible locators; do not fake a click by
calling a component callback directly when user interaction is the behavior.
Keep a small number of E2E journeys for routing, built assets, and API/browser
integration rather than duplicating every component test at E2E level.

### 5. Pick the right double

- Prefer dependency injection for unit-level fetch, clock, filesystem, and model
  seams. The fake must inspect its inputs and fail on the wrong contract.
- Use MSW only when the HTTP boundary itself is under test or when the same Fetch
  handlers add value across browser and Node tests. Do not rewrite every injected
  fetch fake.
- Use fake timers or an injected clock for scheduling/keepalive tests. Do not
  sleep against wall time.
- Use Testcontainers when database-specific behavior matters. An in-memory fake
  cannot prove PostgreSQL migrations, locking, JSONB, or query ordering.

### 6. Treat flaky and slow tests as defects

Retries may collect evidence but must not turn a flaky test green by policy.
Eliminate wall-clock races, leaked HOME/process state, shared ports, and mutable
global state. Keep the default `forks` pool and file isolation unless a measured,
package-specific experiment proves another pool safe.

## Execution ladder

1. During editing: one named test or `pnpm test:changed --uncommitted`.
2. Before commit: affected build/typecheck, relevant repeated critical test,
   lint, then `pnpm check` once.
3. Pull request: Linux and Windows full checks plus the Linux Chromium component
   gate. Real PostgreSQL and broader E2E gates should remain separate jobs so
   failures are attributable.
4. Agent-facing behavior: deterministic code test, live selection/terminal-state
   eval, then strict repeated `pass^k`; a skipped live eval is not a pass.

`test:changed` is an inner-loop accelerator, not the merge proof. It resolves
related tests inside each changed package; a central shared package can affect
downstream packages, so the full workspace check remains required before merge.

## Measured performance decision

On the 12-core development machine, a representative 6,177-test group was
measured with Vitest 4.1.9:

| Configuration | Wall time |
| --- | ---: |
| Default workers, pnpm workspace concurrency 4 | 41.16s |
| Six Vitest workers per active package | 45.91s |
| Two Vitest workers per active package | 94.08s |

The evidence rejects a global worker cap on this machine. Vitest 4.1.10 ran the
same group in 45.56s, within the observed run-to-run/load range and with all
6,177 tests green. Keep package-local `forks`, isolation, and current pnpm
orchestration for now. A root `test.projects` migration is a separate benchmarked
change because project roots/CWD and shared setup must remain exact; do not mix it
with feature work.

The main speed strategy is therefore selective execution during edits, not a
weaker full gate. At the verified 2026-07-17 snapshot the full workspace ran
18,484 passing Vitest cases across 1,624 executed files.

## Adopt, evaluate, avoid

- Adopt now: Vitest 4.1.10, package-related edit loop, real-browser React
  interaction gate, focused fast-check invariants, Windows full gate.
- Evaluate in dedicated slices: downstream-aware changed-package PR selection,
  root Vitest projects, MSW for shared HTTP integration fixtures, V8 coverage
  baseline/ratchet, PostgreSQL Testcontainers CI, Playwright E2E sharding.
- Avoid: wholesale Jest/Node/uvu migration, global `threads` or VM pools,
  `isolate: false`, arbitrary worker caps, retry-as-green, giant snapshots,
  implementation-detail mocks, unseeded fuzzing, and full-suite runs per edit.

## Primary sources

- [TypeScript 7.0 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
- [Vitest features](https://v4.vitest.dev/guide/features)
- [Vitest parallelism](https://v4.vitest.dev/guide/parallelism)
- [Vitest performance](https://main.vitest.dev/guide/improving-performance)
- [Vitest Test Projects](https://main.vitest.dev/guide/projects)
- [Vitest Browser Mode](https://vitest.dev/guide/browser/)
- [Testing Library guiding principle](https://testing-library.com/docs/react-testing-library/intro/)
- [fast-check property testing](https://fast-check.dev/docs/introduction/what-is-property-based-testing/)
- [fast-check Vitest connector](https://fast-check.dev/docs/tutorials/setting-up-your-test-environment/property-based-testing-with-vitest/)
- [MSW](https://mswjs.io/)
- [Playwright TypeScript](https://playwright.dev/docs/test-typescript)
- [Playwright best practices](https://playwright.dev/docs/best-practices)
- [Testcontainers for Node.js](https://node.testcontainers.org/)
- [pnpm recursive execution](https://pnpm.io/cli/recursive)
