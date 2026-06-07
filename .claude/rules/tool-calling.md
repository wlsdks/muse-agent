# Tool-calling reliability — the local model must pick the RIGHT tool in ONE shot

Muse runs on a **local model (gemma4:12b default, reasoning/thinking off)**,
never an expensive cloud model. On a small local model every extra reasoning round is
slower AND less reliable — coherence degrades after 2–3 steps. So the
design goal is not "let the model think its way there"; it is **make
the FIRST tool call correct**. Every tool Muse exposes is designed so
the model selects it and fills its arguments in a single inference.

This is a first-class concern: a capability whose tool the local model
can't reliably call in one shot is not delivered, however good the
underlying code.

## The rules (apply to every `MuseTool` and MCP tool projection)

1. **Keep the exposed set small (≤ ~5–7 per turn).** Each extra tool
   raises the wrong-selection probability. Muse already has a
   relevance filter / `planForContext` — keep it tight; never dump the
   whole registry at the model. If a surface needs many tools, split
   by context instead of widening one prompt.

2. **Names are unambiguous and single-purpose.** `home_state`,
   `web_action`, `knowledge_search` — verb_noun, one job each. NEVER
   ship two tools the model could confuse (no `find` + `search`, no
   `remove` + `delete` for the same intent). Homonyms in
   names/descriptions are the #1 wrong-selection cause.

3. **Rich, constrained parameter schema.** Always declare `required`;
   never lean on optionals for mandatory data. Use explicit types,
   `enum` for fixed choices, `minimum`/`maximum`/`pattern` where they
   apply. Every property `description` carries a CONCRETE example —
   `"Target entity_id, e.g. 'lock.front_door'"`, not `"the entity"`.
   No abbreviated param names (`product_name`, not `pn`). "Invalid
   arguments" is the second-biggest failure mode and is fixed here.

4. **Each tool description says WHEN to use AND when NOT.** A one-line
   "use when … ; do not use for …" in the tool description prevents
   eager invocation (calling a tool on a greeting / when intent is
   absent) and sharpens selection. Pairs with the casual-prompt
   detector.

5. **One tool per response unless the task is genuinely multi-step.**
   Don't design flows that need the small model to chain 3+ calls;
   prefer one tool that does the whole job, or split across turns.

6. **Local-model specifics.** The Ollama adapter uses Ollama's **native
   `tool_calls`** API (works for gemma4:12b and qwen alike — no hand-rolled
   text parsing); keep reasoning/think **off** (the adapter's default). Do NOT
   use ReAct / stopword-template prompting — a thinking-capable model (gemma4
   and Qwen both have a thinking mode) can emit the stopword inside its thoughts
   and break parsing, which is the other reason think stays off.

7. **Validate + repair deterministically, don't re-reason in a loop.**
   Parse tool args against the schema in code; on an invalid call,
   the deterministic layer repairs or re-prompts at most once. Never
   let the model burn rounds guessing the shape — the schema + parser
   are the contract.

## When you add a tool (the per-slice checklist)

- Distinct verb_noun name, no overlap with an existing tool.
- ≤ a few `required` params, each with an example-bearing description
  + the tightest type/enum/range that fits.
- A "use when / not when" line in the description.
- Correct risk classification (read / write / execute) — fail-close
  for state-changing actions per `outbound-safety.md`.
- **Verify the model actually SELECTS it**: a `smoke:live` (local
  model, gemma4:12b default) round-trip that asserts the tool was called with the right
  args — not a unit test of the handler alone. A handler that works
  but is never selected is not delivered. The lean, repeatable gate
  for this is `pnpm eval:tools` (a golden prompt→expected-tool dataset
  incl. negative no-tool cases and the confusable real-tool sets) —
  add a case there when you ship a tool, and run it (with
  `MUSE_EVAL_REPEAT` for stochastic confidence) after touching any
  tool name/description/schema.

## Sources

- [Tool Calling with Local LLMs: A Practical Evaluation (Docker)](https://www.docker.com/blog/local-llm-tool-calling-a-practical-evaluation/)
- [Function Calling — Qwen docs](https://qwen.readthedocs.io/en/latest/framework/function_call.html)
- [Best Local LLMs for Function Calling (InsiderLLM)](https://insiderllm.com/guides/function-calling-local-llms/)
- [Tool Calling Guide for Local LLMs (Unsloth)](https://unsloth.ai/docs/basics/tool-calling-guide-for-local-llms)
