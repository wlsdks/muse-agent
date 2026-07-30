# CodeGraph — the grep guard

The codegraph MCP server ships its own tool-selection guidance and injects it
alongside the tools, so this file does not repeat it. If the server is not
connected the tools do not exist and none of this applies.

What follows is the part that is specific to this repository, and the part that
keeps slipping in practice.

## The binary trigger

"Prefer CodeGraph" is easy to agree with and then break in the moment, so make it
mechanical. **Before typing `Grep` / `grep` / `rg`, or opening a file with `Read`
*to find something*, answer one question:**

> Am I searching for a **NAME** (a function / class / type / const / method /
> interface identifier) or for **LITERAL TEXT** (a log string, an env-var name, a
> comment, a JSON key, a config value)?

- **NAME → `codegraph_search "<name>"` first. No exceptions.** It returns kind,
  location and signature in one sub-millisecond call. Need the body too?
  `codegraph_node` / `codegraph_explore` — not `Read`.
- **LITERAL TEXT → grep is correct.** That is the one thing grep wins at here.

Smell test: **if the query is an identifier you would autocomplete in an IDE, it
belonged in `codegraph_search`.** `selectFireablePatterns`,
`resolvePatternsFiredFile`, `mergeSkillsIntoUmbrella`, "where is helper X
exported" — all names. `PROACTIVE_POLL_MS`'s *value*, an env-var string, a quoted
UI string — literal, grep is fine.

`Read` is for a file you are about to **edit**, or one CodeGraph could not fully
surface. Never for discovering where a symbol lives.

## Index lag

The index lags writes by about a second through the file watcher. When a response
opens with a staleness banner, `Read` those specific files — files not in the
banner are fresh and CodeGraph is authoritative for them.

## When `.codegraph/` is absent

Not every worktree has an index (it is per-checkout, and a fresh `/tmp` worktree
will not have one). Then every rule above is inert and grep is the only option —
say so rather than reporting a symbol as missing. Offer `codegraph init -i`.
