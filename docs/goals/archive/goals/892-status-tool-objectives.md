# Goal 892 — `muse.status` MCP tool surfaces objectives (agent-facing parallel to 891)

## Outward change

The agent-facing `muse.status` loopback MCP tool — what an external
agent calls to reason about "the user's current state" — now
includes a `objectives` section (active / escalated / done /
cancelled counts + the first escalated objective's spec as
`escalated_sample`). 891 fixed this for the human `muse status` CLI;
the agent surface had the identical omission, so an agent asked
"what is Muse watching for me / what needs attention?" could not see
standing objectives, including an escalated one demanding the user.

## Why this, now

Direct symmetric seam to 891 (flagged at the end of that tick): the
two status surfaces (CLI + MCP tool) read from the same dashboard
stores, and both omitted objectives. Fixing only the CLI would leave
the agent blind to the delegated-autonomy queue — and the canonical
summarisers in `personal-status-summary.ts` exist precisely so the
two surfaces never drift (its own docstring says so).

## How

- Added a **canonical** `summariseObjectivesRows` + `ObjectivesSummary`
  to `@muse/mcp/personal-status-summary.ts` (the module both surfaces
  import), exported from the package index. Logic mirrors the sibling
  followups summariser: user-scoped, buckets by status, surfaces the
  first escalated spec.
- `loopback-status.ts`: reads `objectives.json`
  (`readObjectives`, fail-soft `[]`, new `objectivesFile` option),
  summarises, and adds the `objectives` block to the snapshot;
  description updated to mention standing objectives.
- `apps/cli/src/commands-status.ts` (891): **deleted** its local
  `summariseObjectivesRows`/`ObjectivesSummary` and now imports the
  canonical one — eliminating the duplicate, so the two surfaces
  share one implementation (the exact divergence this module exists
  to prevent).

## Verification

`@muse/mcp` `mcp.test.ts` (`muse.status loopback server` dashboard
test): extended to seed an `objectives.json` with
active/escalated/done + a different-user objective; drives the real
`muse.status` snapshot tool and asserts
`{active:1, escalated:1, done:1, cancelled:0, total:3}` (other user
dropped) and `escalated_sample` = the escalated spec. Mutation-proven:
mis-bucketing escalated as active fails it. The CLI's 891 test stays
green consuming the canonical summariser; `program.test.ts` 230/230;
`pnpm lint` 0/0.

**Honest test state:** `pnpm check` is non-green only due to (a) the
documented voice-playback `/tmp` flake and (b) **pre-existing**
`DefaultMcpTransportConnector` stdio failures ("Connection closed" —
the spawned `node -e` MCP-SDK child can't resolve modules in this
sandbox). Both were confirmed present on clean HEAD with this slice's
changes `git stash`ed away, so neither is introduced by 892. No LLM
selection-path change → no smoke:live (Ollama down regardless).

## Decisions

- Promoted the summariser to the shared `@muse/mcp` module rather
  than copying it into the loopback tool: 891 had (acceptably) used a
  local CLI copy; this slice unifies both onto one canonical
  function, closing the divergence rather than widening it.
