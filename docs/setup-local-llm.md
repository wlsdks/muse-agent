# Local LLM setup

Muse is provider-neutral — it talks to any LLM through a Muse-owned
adapter. The easiest way to run Muse without paying for cloud API
calls is to point it at a local open-source model via **Ollama**.

This document covers two paths:

- **Low-spec** — a 4–6 GB RAM laptop, quick chat, basic reminders. ~1 GB model.
- **High-spec** — an 8+ GB RAM laptop / Apple-Silicon Mac, JARVIS daily-driver. ~5 GB model.

Neither path requires an API key. Neither sends your data to anyone.

## 30-second quickstart

```bash
# 1. install Ollama (one of these)
brew install ollama                                     # macOS
curl -fsSL https://ollama.com/install.sh | sh           # Linux
#   Windows: download from https://ollama.com/download

# 2. start the daemon (skip on Windows — the installer starts it)
ollama serve &

# 3. pull a model — pick low or high spec
ollama pull qwen2.5:1.5b-instruct      # low-spec, ~1 GB
ollama pull qwen2.5:7b-instruct        # high-spec, ~5 GB  (recommended)

# 4. tell Muse to use it
muse setup local

# 5. talk
export MUSE_MODEL=ollama/qwen2.5:7b-instruct
muse chat "안녕"
```

`muse setup local` probes Ollama, picks the highest-tier preset you
already pulled, and writes `defaultModel` into `~/.config/muse/config.json`.
Pass `--check` to dry-run without writing.

## Tiers

| Tier | Model | Size on disk | Min RAM | Strengths | Weaknesses |
| --- | --- | --- | --- | --- | --- |
| **low** | `qwen2.5:1.5b-instruct` | 1.0 GB | 4 GB | fits 4 GB laptops, **snappy** (90 ms first-token on M3 Pro), Korean OK | tool calling fragile; long reasoning fails |
| **mid** | `qwen2.5:3b` | 2.0 GB | 6 GB | useful JARVIS surface | Korean weaker than 7B |
| **high** | `qwen2.5:7b-instruct` | 4.7 GB | 8 GB | stable tool-calling, strong Korean | model load takes ~2 s on first request; ~27 tok/s feels "OK" not "snappy" |

**Measured on M3 Pro / 36 GB RAM, Ollama 0.21.1** (run
`node scripts/dogfood-local-llm.mjs <tag>` to reproduce):

| Model | Cold-start | Warm first-token | Tok/s (raw) | Muse `/api/chat` | Tier |
| --- | --- | --- | --- | --- | --- |
| qwen2.5:1.5b-instruct | 274 ms | **90 ms** | 91 | 3.0 s | **JARVIS-fit** |
| qwen2.5:7b-instruct | 1.9 s | 201 ms | 27 | 12.5 s | usable |
| gemma4:26b (too big) | 22 s | 11 s | 36 | 22 s | needs more hardware |

The `/api/chat` figure is wall-clock from request to response and
includes Muse's agent pipeline (system prompt, tool registry,
user-memory hook). 7B's 12 s round-trip vs 1.5B's 3 s for the same
"1+1?" prompt shows the agent overhead scales with model tok/s —
fine for daily JARVIS use, but if you want **chat-only snappiness on
a heavy model** drop `/api/chat` and call the model directly through
the `OllamaProvider`.

All three are **Apache 2.0** — free for any use including commercial.

Apple-Silicon (M-series) Macs use Metal acceleration automatically.
Intel Macs and Linux/Windows CPUs work too, just 3–5× slower.

## What "Local" gets you

| Concern | Cloud LLM (Gemini / GPT / Claude) | Local LLM (Ollama + Qwen) |
| --- | --- | --- |
| API key | required | none |
| Per-token cost | $0.001–$0.03 per turn | $0 |
| Offline | no | yes |
| Privacy | data sent to provider | data never leaves your machine |
| Quality (general chat) | ★★★★★ | ★★★★ (7B), ★★★ (1.5B) |
| Quality (deep coding) | ★★★★★ | ★★★ — use cloud for hard tasks |
| First-token latency | 200–800 ms | 100–500 ms after model load |

JARVIS-class daily work (calendar, notes, tasks, reminders, short
chat, memory extraction, proactive notice synthesis) sits in the
upper-left of that table. Local 7B handles all of it.

## Hybrid: local default + cloud for hard work

Muse routes per-request. Set the local model as the default and
override per call when you need cloud reasoning:

```bash
# default = local
muse config set defaultModel ollama/qwen2.5:7b-instruct

# one-off cloud call when you need it
muse chat --model gemini/gemini-2.5-pro "Plan the Q3 migration."
```

Add cloud keys to `~/.muse/.env` (or your shell) so the override works
without re-typing the key each time.

## Alternative runtimes

Anything that exposes an OpenAI-compatible `/v1/chat/completions`
endpoint works with Muse. Common alternatives:

| Runtime | Install | Muse env |
| --- | --- | --- |
| **Ollama** *(recommended)* | `brew install ollama` | `MUSE_MODEL=ollama/<tag>` |
| **LM Studio** | download app from lmstudio.ai | `MUSE_MODEL_BASE_URL=http://localhost:1234/v1`, `MUSE_MODEL=lmstudio/<id>` |
| **Llamafile** | single executable, no install | `MUSE_MODEL_BASE_URL=http://localhost:8080/v1` |
| **vLLM / TGI / mlc-llm** | per-runtime docs | `MUSE_MODEL_BASE_URL=<endpoint>` |

The `muse setup local` wizard only knows about Ollama today; the
others work but you wire them through env vars.

## Troubleshooting

**`Ollama daemon not reachable`** — `ollama serve &` not running. On
macOS Homebrew install: `brew services start ollama`. On Linux the
installer should add a systemd unit.

**`Model 'qwen2.5:7b-instruct' not pulled`** — exactly what it says.
Run the `ollama pull` line above and retry.

**Slow first response, fast afterwards** — Ollama loads the model into
RAM on first use; subsequent calls reuse the loaded model. The first
call after `ollama serve` startup will take 3–10 seconds for a 7B
model; subsequent calls return tokens in <500 ms.

**Out-of-memory crash** — drop to the next-smaller tier
(`qwen2.5:7b-instruct` → `qwen2.5:3b` → `qwen2.5:1.5b-instruct`).
Available RAM ≠ installed RAM; close browsers / VSCode first.

## Model licenses

Models have their own licenses; Muse doesn't redistribute weights, but
you should know what you're running before commercial use.

| Model family | License | Commercial use |
| --- | --- | --- |
| **Qwen 2.5** (0.5B / 1.5B / 7B / 14B / 32B) | Apache 2.0 | yes |
| Qwen 2.5 **3B** | Qwen Research License | non-commercial only |
| Qwen 2.5 **72B** | Qwen License | commercial requires registration |
| Llama 3.x | Llama Community License | yes if MAU < 700M |
| Gemma 2 | Gemma Terms + Prohibited Use Policy | yes with restrictions |
| Phi-3 | MIT | yes |
| Mistral 7B Instruct | Apache 2.0 | yes |

For a personal JARVIS on your laptop, all of these are fine. Check
the license if you plan to deploy Muse as a service for paying users.

## Verification

To prove the integration works end-to-end on your machine:

```bash
node scripts/dogfood-local-llm.mjs qwen2.5:7b-instruct
```

The script:

1. Probes Ollama directly, measures first-token latency + tokens/sec.
2. Boots Muse's `/api/chat` in-process and routes through `OllamaProvider`.
3. Asserts a Korean reply contains Hangul.
4. Prints a tier verdict (`JARVIS-fit` / `usable` / `needs more hardware`).

Sample output (M3 Pro, 7B):

```
VERDICT for qwen2.5:7b-instruct:
  coldStartMs: 1883
  firstTokenMs: 201
  koreanReplyOk: true
  museApiOk: true
  museRoundtripMs: 12484
  rawTokensPerSec: 26.9
  tier: usable
```

`firstTokenMs` is *warm* — the script runs a discarded warm-up call
first so the measurement reflects what you actually feel on the second
request and beyond. `coldStartMs` is reported separately for
transparency; it's the one-time tax Ollama pays to load the gguf
from disk into RAM (and stays loaded for `OLLAMA_KEEP_ALIVE`,
default 5 min).

If the verdict is `needs more hardware`, drop to the next-smaller
tier — the script reports actual numbers so the choice is data-driven,
not guessed.
