# CodeGraph — code intelligence over a semantic knowledge graph

CodeGraph builds a semantic knowledge graph of the codebase for faster,
smarter code exploration. This is the CodeGraph project's official
guidance, adopted here.

## If `.codegraph/` exists in the project

**Answer directly with CodeGraph — don't delegate exploration to a
file-reading sub-agent or a grep/read loop.** CodeGraph *is* the
pre-built search index; re-deriving its answers with grep + Read repeats
work it already did and costs more for the same result. For "how does X
work?", architecture, trace, or where-is-X questions, answer in a handful
of CodeGraph calls and stop — typically with **zero file reads**. The
returned source is complete and authoritative: treat it as already read
and do not re-open those files. Reach for raw Read/Grep only to confirm a
specific detail CodeGraph didn't cover.

### Tool selection by intent

| Tool | Use for |
|------|---------|
| `codegraph_context` | Map a task / feature / area first — composes search + node + callers + callees in one call |
| `codegraph_trace` | "How does X reach Y" — the call path, each hop's body inline (follows dynamic-dispatch hops grep can't) |
| `codegraph_explore` | Survey several related symbols' source in ONE budget-capped call |
| `codegraph_search` | Find a symbol by name |
| `codegraph_callers` / `codegraph_callees` | Walk call flow one hop at a time |
| `codegraph_impact` | Check what's affected before editing |
| `codegraph_node` | Get a single symbol's source / signature |

A direct CodeGraph answer is a handful of calls; a grep/read exploration
is dozens.

### The grep guard — a binary trigger (this is the rule that keeps slipping)

The "prefer CodeGraph" rule above is easy to nod at and then break in the
moment. So make it mechanical. **Before you type `Grep` / `grep` / `rg`
or open a file with `Read` *to find something*, answer one question:**

> Am I searching for a **NAME** (a function / class / type / const /
> method / interface identifier) or for **LITERAL TEXT** (a log string,
> an env-var name, a comment, a JSON key, a config value)?

- **NAME → `codegraph_search "<name>"` FIRST. Always. No exceptions.**
  It returns kind + location + signature in one sub-ms call. Need the
  body too? `codegraph_node` / `codegraph_explore` — not `Read`.
- **LITERAL TEXT → grep is correct.** That is the *only* thing grep wins
  at here.

Smell test: **if your search query is an identifier you'd autocomplete
in an IDE, it belonged in `codegraph_search`.** `selectFireablePatterns`,
`resolvePatternsFiredFile`, `mergeSkillsIntoUmbrella`, "where is helper
X exported" — all NAMES, all `codegraph_search`. `PROACTIVE_POLL_MS`'s
*value*, an env-var string, a Korean doc line — LITERAL, grep is fine.

`Read` is for a file you are about to **edit** (or one CodeGraph couldn't
fully surface), never for discovering where a symbol lives.

## If `.codegraph/` does NOT exist

At the start of a session, ask the user if they'd like to initialize
CodeGraph:

> "I notice this project doesn't have CodeGraph initialized. Would you
> like me to run `codegraph init -i` to build a code knowledge graph?"

## Index lag

The index lags writes by ~1s through the file watcher. When a CodeGraph
response opens with a staleness banner ("⚠️ Some files referenced below
were edited since the last index sync…"), Read those specific files for
accurate content — files NOT in the banner are fresh and CodeGraph is
authoritative for them.
