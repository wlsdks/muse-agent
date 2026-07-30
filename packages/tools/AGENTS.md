# `@muse/tools` — tools a small local model must pick in ONE shot

Muse runs on a local model by default, where every extra reasoning round is slower *and* less
reliable. A tool the model cannot select correctly on the first try is not delivered, however
good the handler.

- **Keep the exposed set small.** The runtime caps it (`DEFAULT_TOOL_EXPOSURE_CEILING`); do not
  widen one prompt, split by context instead.
- **`verb_noun`, one job each.** Never ship two names the model could confuse — no `find` beside
  `search`, no `remove` beside `delete` for the same intent. Homonyms are the top wrong-selection
  cause.
- **Declare `required`, and give every property a CONCRETE example** — `"Target entity_id, e.g.
  'lock.front_door'"`, not `"the entity"`. No abbreviated names.
- **Say when NOT to use it** in the description. That is what stops a tool firing on a greeting.
- **Never pre-compute a timestamp into an argument.** Name time fields neutrally (`startsAt`, not
  `*Iso`) — an `Iso` suffix makes the model calculate a wrong value instead of letting
  deterministic code do it.

Prove the model actually SELECTS it: add a case to `pnpm eval:tools` and run it. A handler that
works but is never chosen is not delivered.

Full contract: [`.claude/rules/safety/tool-calling.md`](../../.claude/rules/safety/tool-calling.md).
Repository-wide brief: [`AGENTS.md`](../../AGENTS.md).
