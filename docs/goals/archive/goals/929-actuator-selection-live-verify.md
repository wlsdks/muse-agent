# Goal 929 — actuator/perception tools are live-selectable on qwen3:8b (clears the [UNVERIFIED-LIVE] selection debt)

## Outward change

The real actuator + perception tools — `web_action`, `home_action`,
`search_email`, `weather`, `knowledge_search` — were each shipped with
their CAPABILITIES line tagged `[UNVERIFIED-LIVE]` because Ollama was
down and the loop could never confirm the local model actually SELECTS
them in one shot (tool-calling.md: a tool the model never picks is not
delivered). With Ollama restored (qwen3:8b + nomic-embed-text pulled,
`smoke:live` 22/0/1 green), `eval:tools` gains an `actuator-tools
(confusable set)` scenario that exposes all five together and asserts
the model discriminates between them on representative prompts.

Live result (qwen3:8b, temperature 0), 6/7 actuator cases pass; overall
`eval:tools` 31/32 (97%), threshold 85% — PASSED:

- ✅ "Reserve a table … on the booking page" → `web_action`
- ✅ "Activate the bedtime scene" → `home_action(scene.turn_on)`
- ✅ "Run my good night routine" → `home_action(script.turn_on)`
- ✅ "Find the email from the bank about my statement" → `search_email` (not knowledge_search)
- ✅ "Any news about the Mars mission from the feeds I follow?" → `knowledge_search` (not web/search_email)
- ✅ "Will it rain on Saturday?" → `weather(when=Saturday)`
- ❌ "Post a comment on the forum thread …" → NO tool selected

So the selection tags on the five proven capabilities (CAPABILITIES
lines for search_email / weather-`when` / home_action scenes /
knowledge_search news) are dropped with the live evidence recorded.

## Why this, now

The /goal session is biased toward LIVE VERIFICATION DEBT: clearing
`[UNVERIFIED-LIVE]` tags with a real local-Qwen check is the
contract-priority work the moment Ollama is back. `eval:tools` is the
lean, repeatable gate tool-calling.md mandates for exactly this — the
confusable real-tool set, run straight against the model.

## Decisions

- **Built tool definitions with stub deps.** `eval:tools` reads only
  `t.definition` (name/description/inputSchema); `execute` (which the
  deps feed) is never called, so the factories are instantiated with
  minimal stubs. This keeps the gate free of providers/credentials.
- **`web_action` stays `[UNVERIFIED-LIVE]` (PARTIAL).** "Reserve …"
  selects it, but "Post a comment …" selects NO tool — the
  post/comment intent is a genuine selection gap, not an environment
  skip. Its tag is kept with the finding recorded; the fix
  (description/example teaching the comment/post intent) is a future
  slice, re-checked by the same `eval:tools` case.

## Check

`MUSE_EVAL_MODEL=qwen3:8b pnpm eval:tools` — actuator-tools scenario
6/7, overall 31/32 (97%) ≥ 85% threshold, exit 0. `pnpm lint` 0/0.
No request/response code path changed (eval script + docs only), so
the existing green `smoke:live` (22/0/1) stands.
