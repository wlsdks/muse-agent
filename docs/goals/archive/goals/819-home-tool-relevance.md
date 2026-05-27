# 819 — fix: home tools surface for natural prompts (one-shot tool selection)

## Why

The human's #1 priority: the local model must pick the right tool in
ONE shot, and `tool-calling.md` rule 1 says exposing too many tools
hurts that — so the `DefaultToolFilter` (which narrows the catalog per
prompt by domain keywords) is load-bearing. The home tools
(`home_state` / `home_entities` / `home_action`) were tagged
`domain: "system"`, whose heuristics are config/setting/version — so a
home prompt could only match the tools' OWN keywords, and those use
word-boundary matching: `"lock"` does NOT match "is the front door
**locked**?" and `"light"` does NOT match "turn on the **lights**".
Result: natural home requests dropped the home tools entirely — the
exact one-shot-selection failure the human flagged.

## Slice

- `@muse/agent-core` tool-filter.ts — add a `home` entry to
  `DEFAULT_DOMAIN_KEYWORDS` (light/lights/door/lock/locked/unlock/
  unlocked/garage/thermostat/sensor/device(s) + Korean 조명/불/문/잠금/
  온도/센서).
- `@muse/mcp` smart-home-tool.ts — retag `home_state` / `home_entities`
  / `home_action` `domain: "system"` → `"home"` so they match the new
  heuristic domain.

## Verify

- `@muse/autoconfigure` home-tool-relevance.test.ts (new, 4): the REAL
  home tools run through the REAL `DefaultToolFilter` — "is the front
  door locked?" surfaces `home_state`; "turn on the living room lights"
  surfaces `home_action`; "what smart-home devices do I have?" surfaces
  `home_entities`; an unrelated prompt ("what is 2+2?", an economics
  article) surfaces NONE (the exposed set stays small).
- **Mutation-proven**: removing the `home` domain keywords → the
  natural-prompt cases fail (the tools drop); restore → 4/4. Full
  `pnpm check` EXIT 0, `pnpm lint` 0/0. The exposed catalog rides the
  model request → live SELECTION wants `smoke:live`; Ollama down →
  deferred (the deterministic filter behaviour is the verified claim).

## Decisions

- **A real `home` domain, not patched keywords** — gives all home
  tools uniform natural-prompt coverage via the heuristic path, the
  same architecture as calendar/tasks/notes/messaging; inflected forms
  (lights/locked/unlocked) are explicit keywords since the matcher is
  word-boundary, not substring.
- No bullet flip — tool-calling reliability fix (natural home selection).
  CAPABILITIES line under P20 / tool-calling.
