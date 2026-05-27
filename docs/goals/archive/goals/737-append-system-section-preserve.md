# 737 — fix: `appendSystemSection` re-apply no longer drops sibling context sections

## Why

`appendSystemSection` (packages/agent-core/src/runtime-helpers.ts) is
the shared primitive EVERY context transform uses to inject its block
into the first system message — active-context, inbox, episodic,
user-memory, prompt-layers, prompt-exemplars all land through it under
a `<!-- muse:{sectionId} -->` marker. Its documented contract is
"appends … replacing any earlier copy of the same section … so the
runtime can safely re-inject memory across multi-turn runs without
compounding stale content."

The replace path was wrong:

```ts
const withoutPrevious = message.content.split(marker)[0]?.trimEnd();
content: [withoutPrevious, content].filter(Boolean).join("\n\n")
```

`split(marker)[0]` keeps only the text BEFORE the marker, then appends
the fresh block at the end. So re-applying a section whose marker sits
*before* other sections **silently discards every section appended
after it**. Concretely, a threaded session that re-injects
`active-context` on a later turn would drop the `inbox-context` /
`episodic-recall` blocks that followed it — and if those transforms
returned nothing that turn (e.g. inbox empty), they were not re-added,
so the agent lost that context with no signal.

## Slice

Replace the `split(marker)[0]` truncation with `stripSystemSection`,
which removes ONLY the target marker's own block (from its marker up to
the next `<!-- muse:… -->` marker or end), preserving everything before
AND after, then appends the fresh copy. First-application (marker
absent) and single-section replace behave exactly as before.

## Verify

- `@muse/agent-core` system-memory-helpers.test.ts — new case: inject
  `active-context` then `inbox-context`, then re-apply `active-context`;
  assert the inbox section + body survive, the old active copy is gone,
  and each marker appears exactly once. The three pre-existing cases
  (prepend-when-no-system, append, single-section replace) still pass.
  **Mutation-proven** — restoring `split(marker)[0]` fails the new case.
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0 (standalone).
- Deterministic string assembly (the re-apply/replace path is not
  exercised by a live round-trip), so verification is the unit +
  mutation test, not `smoke:live`.

## Decisions

- **Strip the section's own block, don't truncate at its marker** — the
  marker grammar already delimits sections (the same grammar
  `prompt-budget.ts` parses), so the next-marker boundary is the
  correct end of a section. Preserving the suffix is what makes
  re-injection idempotent per the documented contract.
- **Re-applied section moves to the end** — acceptable and unchanged
  from prior behavior; only the data-loss of sibling sections is fixed.
