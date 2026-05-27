# Goal 931 — `muse today --brief` prose surfaces feed headlines live on qwen3:8b

## Outward change

`muse today --brief` renders the briefing as a 2–3 sentence prose
summary via the local model: `renderBrief` builds
`Briefing JSON:\n${JSON.stringify(briefing, …)}` and sends it to the
model. The briefing now carries a `headlines` section (merged
client-side from the local feeds store, like the weather line). The
structured (`--json` / default) path was already offline-verified;
the **prose path** was tagged `[UNVERIFIED-LIVE]` because Ollama was
down and the loop could never confirm the headlines actually reach the
model's rendered brief.

With Ollama restored, a real `muse today --brief` run on qwen3:8b — HOME
isolated to a temp dir (so tasks/events/reminders are empty and the
headline is the only ambient content) and a seeded `MUSE_FEEDS_FILE`
carrying one distinctive headline ("Seoul subway adds late-night quokka
express line", published 1h ago) — produces a prose brief that names
the headline ("Seoul's subway is adding a late-night quokka express
line — check the details"), reproduced across runs. The headline
demonstrably rides the JSON dump into the live model output.

## Why this, now

The /goal session targets LIVE VERIFICATION DEBT. This was the last
real-capability `[UNVERIFIED-LIVE]` line (the only other occurrence is
the rule definition in the file header). Clearing it with the real
local-Qwen run is the contract-priority work now that Ollama is back.

## Decisions

- **Isolated HOME, not the user's store.** The check sets
  `HOME=<tempdir>` + a seeded `MUSE_FEEDS_FILE` so it exercises the real
  CLI path without reading or mutating the user's `~/.muse`, and so the
  headline is the brief's only content (a deterministic-enough live
  assertion despite stochastic prose).
- **No code change.** The prose path already dumped the full briefing
  (incl. headlines) to the model; this slice is pure live verification +
  recording. No request/response code path changed, so the existing
  `smoke:live` 22/0/1 stands.

## Check

`HOME=<tmp> MUSE_MODEL=ollama/qwen3:8b MUSE_FEEDS_FILE=<seeded> muse
today --brief` → the prose brief contains the seeded headline
("quokka express line"), across repeated runs. `pnpm lint` 0/0.
