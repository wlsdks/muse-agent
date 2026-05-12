# Local LLM setup

Muse is provider-neutral — it talks to any LLM through a Muse-owned
adapter. The easiest way to run Muse without paying for cloud API
calls is to point it at a local open-source model via **Ollama**.

This document covers four tiers, smallest to largest:

- **Low** — 4 GB RAM laptop, chat-only. ~1.0 GB model.
- **Mid** — 8+ GB RAM, balanced JARVIS surface. ~2.7 GB model.
- **High** *(recommended)* — 12+ GB RAM, stable tool calling. ~6.6 GB model.
- **Power** — 32+ GB RAM (M-Pro / M-Max), agentic-coding tier. ~17 GB model.

No tier requires an API key. None of them send your data to anyone.

## 30-second quickstart

```bash
# 1. install Ollama (one of these)
brew install ollama                                     # macOS
curl -fsSL https://ollama.com/install.sh | sh           # Linux
#   Windows: download from https://ollama.com/download

# 2. start the daemon (skip on Windows — the installer starts it)
ollama serve &

# 3. pull a model — pick a tier
ollama pull qwen3.5:0.8b               # low, ~1 GB
ollama pull qwen3.5:2b                 # mid, ~2.7 GB
ollama pull qwen3.5:9b                 # high, ~6.6 GB  (recommended)
ollama pull qwen3.6:27b                # power, ~17 GB  (agentic coding)

# 4. tell Muse to use it
muse setup local

# 5. talk
muse chat "안녕"
```

`muse setup local` probes Ollama, picks the highest-tier preset you
already pulled, and writes `defaultModel` into `~/.config/muse/config.json`.
Pass `--check` to dry-run without writing.

## Tiers

| Tier | Model | Size on disk | Min RAM | Strengths | Weaknesses |
| --- | --- | --- | --- | --- | --- |
| **low** | `qwen3.5:0.8b` | 1.0 GB | 4 GB | fits 4 GB laptops; truly snappy | tool calling unreliable; basic chat only |
| **mid** | `qwen3.5:2b` | 2.7 GB | 8 GB | balanced JARVIS surface, good Korean | tool calling occasionally hesitates |
| **high** | `qwen3.5:9b` | 6.6 GB | 12 GB | **recommended daily-driver** — stable tool calling, strong Korean, Apr 2026 release | needs Apple-Silicon or 16 GB+ x86 |
| **power** | `qwen3.6:27b` | 17 GB | 32 GB | open-weight agentic-coding tier (Apr 2026), best 27 B coding model | M-Pro 32 GB+ or workstation only |

`qwen2.5` (Sep 2024) and `qwen3` (Aug 2025) still work — pass them
with `--model ollama/<tag>` — but Qwen 3.5 (Feb–Apr 2026) is the
default. It has tighter tool calling and noticeably better multilingual
performance than the 2.5 line at the same parameter count.

**Measured on M3 Pro / 36 GB RAM, Ollama 0.21.1** (run
`node scripts/dogfood-local-llm.mjs <tag>` to reproduce). Numbers
below are from Qwen 2.5 (still recorded as historical baseline);
re-run for Qwen 3.5 on your hardware:

| Model | Cold-start | Warm first-token | Tok/s (raw) | Muse `/api/chat` | Tier |
| --- | --- | --- | --- | --- | --- |
| qwen2.5:1.5b-instruct | 274 ms | **90 ms** | 91 | 3.0 s | **JARVIS-fit** |
| qwen2.5:7b-instruct | 1.9 s | 201 ms | 27 | 12.5 s | usable |
| gemma4:26b (too big) | 22 s | 11 s | 36 | 22 s | needs more hardware |

The `/api/chat` figure is wall-clock from request to response and
includes Muse's agent pipeline (system prompt, tool registry,
user-memory hook). 7B's 12 s round-trip vs 1.5B's 3 s for the same
"1+1?" prompt is **almost entirely tool-registry prefill** — the
small model spends time considering ~30 tool definitions even for
a trivial question.

Use `muse chat --no-tools` (or `metadata.maxTools=0` in the API) to
skip the tool registry for a single turn:

| Layer | qwen2.5:7b on M3 Pro |
| --- | --- |
| `provider.generate` no tools | **500 ms** |
| `provider.generate` with full tool list | 22 s |
| `agentRuntime.run` (default) | 10 s |
| `agentRuntime.run` with `maxTools:0` | **670 ms** |
| HTTP `/api/chat` end-to-end | 12 s |

The `--no-tools` fast path makes 7B feel **15× snappier** for casual
chat, at the cost of losing calendar / tasks / notes access for that
turn. Pair it with normal `muse chat` (tools enabled) when you
actually need them:

```bash
muse chat --no-tools "정리해줘: ..."    # snappy, no tools
muse chat "오늘 일정 뭐야?"             # full agent, calendar tool fires
```

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
muse config set defaultModel ollama/qwen3.5:9b

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

## Voice mode (optional)

Muse's voice loop (Whisper STT → local LLM → Piper TTS) needs two
extra binaries plus their model files. Probe what's installed:

```bash
muse setup voice
```

Sample first-run output:

```
Muse voice toolchain:
  [todo] whisper-cpp binary — not on PATH
         → macOS: brew install whisper-cpp
  [todo] whisper ggml model — ~/.muse/whisper-models/ggml-base.en.bin not found
         → mkdir -p ~/.muse/whisper-models && curl -L -o … ggml-base.en.bin
  [todo] piper binary — not on PATH
         → pipx install piper-tts
  [todo] piper voice (.onnx) — ~/.muse/piper-voices/*.onnx not found
         → curl -LO … en_US-lessac-medium.onnx
```

The four steps are:

1. **`whisper-cpp` binary** — local STT.
   `brew install whisper-cpp` (macOS) or build from
   github.com/ggerganov/whisper.cpp.
2. **ggml model** — pick a size by language. English-only `base.en`
   is ~150 MB; multilingual `base` adds Korean / Japanese / etc.
3. **`piper` binary** — local TTS. `pipx install piper-tts` works on
   every OS; rhasspy/piper releases are statically-linked
   alternatives.
4. **Piper voice** — `.onnx` voice file + paired `.json` config from
   huggingface.co/rhasspy/piper-voices/. Lessac (English) and KSS
   (Korean) are common picks.

Override paths with env: `MUSE_WHISPER_CPP_PATH`,
`MUSE_WHISPER_CPP_MODEL_PATH`, `MUSE_PIPER_PATH`, `MUSE_PIPER_VOICE_PATH`.
The voice provider tests pass with mocked runners (no binaries) so
the integration shape is verified even when the toolchain is missing.

## Troubleshooting

**`Ollama daemon not reachable`** — `ollama serve &` not running. On
macOS Homebrew install: `brew services start ollama`. On Linux the
installer should add a systemd unit.

**`Model 'qwen3.5:9b' not pulled`** — exactly what it says.
Run the `ollama pull` line above and retry.

**Slow first response, fast afterwards** — Ollama loads the model into
RAM on first use; subsequent calls reuse the loaded model. The first
call after `ollama serve` startup will take 3–10 seconds for a 9B
model; subsequent calls return tokens in <500 ms.

**Out-of-memory crash** — drop to the next-smaller tier
(`qwen3.5:9b` → `qwen3.5:2b` → `qwen3.5:0.8b`).
Available RAM ≠ installed RAM; close browsers / VSCode first.

## Model licenses

Models have their own licenses; Muse doesn't redistribute weights, but
you should know what you're running before commercial use.

| Model family | License | Commercial use |
| --- | --- | --- |
| **Qwen 3.5** (0.8B / 2B / 4B / 9B / 27B) | Apache 2.0 | yes |
| Qwen 3.5 **35B / 122B** | Qwen License | commercial requires registration |
| **Qwen 3.6** (27B open weights, Apr 2026) | Apache 2.0 | yes |
| Qwen 3.6 **Plus** (cloud-only) | Alibaba Cloud terms | API pay-as-you-go |
| Qwen 2.5 (legacy) | Apache 2.0 except 3B/72B | yes (most sizes) |
| Llama 3.x | Llama Community License | yes if MAU < 700M |
| Gemma 2 | Gemma Terms + Prohibited Use Policy | yes with restrictions |
| Phi-3 | MIT | yes |
| Mistral 7B Instruct | Apache 2.0 | yes |

For a personal JARVIS on your laptop, all of these are fine. Check
the license if you plan to deploy Muse as a service for paying users.

## Verification

To prove the integration works end-to-end on your machine:

```bash
node scripts/dogfood-local-llm.mjs qwen3.5:9b
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
