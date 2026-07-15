# TypeScript 7 Source-Quality Audit - 2026-07-16

## Purpose and decision record

This is the evidence ledger for the repository-wide source-quality program.
An entry is complete only when its production boundary was inspected, any
evidence-backed correction has focused verification, and residual risk is
explicit. Entries marked `No change` were reviewed without a high-confidence
defect and remain eligible for later seam re-audit.

TypeScript 7 remains the normal project-reference compiler. The `typescript`
package name remains the TypeScript 6 Compiler API compatibility alias for
tools that require that API. This avoids weakening `strict`, adding a normal
TS6 build fallback, or conflating compiler and tooling compatibility. The
official-source rationale and operational commands are maintained in
[`docs/development/typescript-7.md`](../development/typescript-7.md), including
the TypeScript 7 announcement and release-notes links.

## Platform and auxiliary package batch

| Area | Production boundary inspected | Result | Focused evidence |
| --- | --- | --- | --- |
| `@muse/windows` | PowerShell transport, base64 interpolation boundary, tool input enums, and read-output parsing | Storage and battery output now accept only finite, valid values; malformed drive rows are omitted so `NaN` or `Infinity` cannot enter tool JSON. | `pnpm --filter @muse/windows exec vitest run src/windows-app-read-tool.test.ts` - 8 passed; `pnpm --filter @muse/windows build` passed. |
| `@muse/agent-specs` | In-memory registry identity/eviction and Kysely upsert mapping | Registry capacity now requires a positive safe integer, preserving the invariant that a successfully saved spec remains retrievable unless a real eviction occurs. | `pnpm --filter @muse/agent-specs exec vitest run test/agent-specs.test.ts` - 16 passed; `pnpm --filter @muse/agent-specs build` passed. |
| `@muse/quarantine-eval` | Bounded handwritten JSON parser, duplicate-key reporting, schema/semantic validation, and scorecard output | No change. Raw input byte limit, nesting/member/value-node limits, invalid JSON handling, duplicate detection, and fail-close schema/semantic gates are present. | Source audit of `HandwrittenJsonParser` and `evaluateSyntheticQuarantineJson`; no changed behavior in this package. |
| `@muse/mascot` | Canonical pose data and SVG generation boundary | SVG options now require a nonempty known-frame sequence and finite positive duration/size values, preventing invalid generated markup after runtime type bypass. | `pnpm --filter @muse/mascot exec vitest run src/mascot.test.ts` - 9 passed; `pnpm --filter @muse/mascot build` passed. |

## Follow-up

- Continue the package/app ledger in dependency order. A source review is not a
  completion claim for callers or downstream registration paths.
- Re-audit changed seams after all package and application entries exist.
- Perform independent final review and the final requirement-by-requirement
  completion audit before closing the program.
