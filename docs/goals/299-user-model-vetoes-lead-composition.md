# 299 — a hard user veto could be silently truncated out of the prompt

## Why

`composeUserModelSnapshot` (`@muse/memory`) renders the typed
user-memory (preferences / schedule / **vetoes** / goals) into the
one-line `key=value; …` snapshot injected into the system prompt
every turn — it's how a personal JARVIS "knows your
preferences and the things you've told it never to do." It
composed in the order **preferences → schedule → vetoes →
goals**, then `maxChars` (default 1 000) right-truncates the
combined string with a `… [N slots elided]` tail.

Vetoes are **hard safety/trust constraints** — allergies
("no eggs"), boundaries ("never email my boss"). Because they
were composed third, a chatty extractor producing many long
preference/schedule slots could push the composed string past
`maxChars` *before the veto block was reached*, so the veto was
**silently right-truncated out of the prompt** — and the elided
marker doesn't say which kind was dropped, so neither the agent
nor the user gets any signal the "never do X" constraint is no
longer in context. A preference being elided is a soft
personalisation loss; a veto being elided is a safety regression.

## Scope

`packages/memory/src/user-model-slots.ts` —
`composeUserModelSnapshot`:

- Compose the **veto** block first, then preferences, schedule,
  goals. The `maxChars` right-truncation now drops soft slots
  (goals → schedule → preferences from the tail) before it can
  ever reach a veto. The per-kind `elided` accounting is
  order-independent (sum of per-kind overflow), unchanged. One
  short WHY comment + the doc example record that vetoes lead
  because they're safety constraints.

Behaviour: for any model that fits within `maxChars` the snapshot
contains the **identical set** of slots (a `key=value;` list is
order-insensitive for the model), only reordered veto-first; only
the over-budget case changes — and in the safe direction.

## Verify

- `pnpm --filter @muse/memory test` — 150 pass (was 149; +1).
  New regression: 8 long preferences (`maxPerKind:100`) plus one
  `veto.food.no-eggs`, `maxChars:120` → the snapshot still
  `contains` the veto and `slots elided` while staying ≤ 120
  (pre-fix the veto, composed third, was the part truncated
  away). The existing per-kind formatting / clamp / maxPerKind /
  maxChars tests stay green (all single-kind or substring
  assertions — none asserted cross-kind order).
- `pnpm check` — every workspace green (memory 150, apps/cli 563,
  apps/api 160, all packages). `pnpm lint` — exit 0.
- No real-LLM request/response path touched — this is a
  deterministic reorder of an order-insensitive `key=value;`
  snapshot-composition string (no provider / transport /
  serialization change). A live Qwen run can't reproduce the
  budget-overflow truncation on demand, so the deterministic
  regression is the rigorous verification — same stance as the
  prompt-context composition goals 277 / 285.

## Status

done — user vetoes are composed first, so a chatty preference
set can no longer silently push a hard safety constraint out of
the prompt under the char cap. Within-budget snapshots carry the
same information; only the over-budget case changed, and toward
keeping safety constraints.
