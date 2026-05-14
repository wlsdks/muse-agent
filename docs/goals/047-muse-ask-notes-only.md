# 047 — muse ask --notes-only (revive deferred 018)

## Why

Disable web_search + filter tool registry to notes + memory tools
only, when --notes-only is set.

## Scope

- Flag handler in commands-ask.ts.
- Tool registry filter.
- smoke:live: model does NOT call muse.search when --notes-only is set.

## Verify

- cli +1 test + live verify.

## Status

done — `muse ask --notes-only` clamps grounding to local notes +
memory only. Two enforcements:

1. **Native web_search disabled** on every provider path —
   `webSearchPolicy: { enabled: false, maxUses: 0 }` flows through
   `request.metadata` to adapter-anthropic / adapter-openai /
   adapter-gemini so the upstream API never sees the native
   `web_search` tool.
2. **Agent runtime tool allowlist** — when combined with
   `--with-tools`, the agent runtime sees
   `metadata.allowedToolNames: ["muse.notes", "muse.notes-multi",
   "muse.context"]`, blocking `muse.search` / `muse.fetch` /
   `muse.url` and every other surface.

cli +1 unit test asserts the allowlist shape (positive + negative
guards against the web/search/fetch names that would betray the
goal if they leaked back in).
