# Loop journal — competitor-parity (openclaw + hermes → Muse gap-filling)

Theme: study /Users/jinan/ai/openclaw (TS, MIT) + /Users/jinan/ai/hermes-agent (Python, MIT/Apache),
find what Muse LACKS, reimplement the pattern (attributed, no verbatim copy), in BIG chunks per fire.
Tier1 (local commit, no push). Worktree: /tmp/muse-competitor-parity. Slug: competitor-parity.

## Candidate gaps (seed — each fire VERIFIES the gap is real before building; Muse may already have it)
- ◦ Plugin SDK / third-party extension package contract (openclaw plugin-sdk, plugin-package-contract) — Muse has `skills` but not a versioned plugin package system. VERIFY vs packages/skills first.
- ◦ Web-content extraction (openclaw web-content-core) — page → clean readable markdown. Muse has `browser`; check if clean-extraction exists.
- ◦ Context compression sophistication (hermes context_compressor.py / context_engine.py) — vs Muse auto-compaction + context-engineering. Measure the delta.
- ◦ Model catalog with capabilities (openclaw model-catalog-core) — vs Muse `model`. Check if a queryable capability catalog exists.
- ◦ A2A / ACP interop depth (openclaw acp-core, hermes acp_adapter) — Muse has `a2a`; compare contract coverage.

## Fires
