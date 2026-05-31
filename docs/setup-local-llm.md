---
title: 로컬 LLM 설치 가이드 (Local LLM setup)
audience: [사용자, 개발자]
purpose: 클라우드 비용 없이 로컬 오픈소스 모델(Ollama)로 Muse를 띄우는 방법
updated: 2026-05-30
related: [README.md, SYSTEM-MAP.md]
---

# Local LLM setup

Muse is provider-neutral — it talks to any LLM through a Muse-owned
adapter. The easiest way to run Muse without paying for cloud API
calls is to point it at a local open-source model via **Ollama**.

> 처음이라면 모델을 띄운 뒤 `muse onboard`를 실행하세요 — 노트 폴더
> 지정 → 자료 인입 → 첫 질문까지 한 단계씩 이끌어 **비공개·출처 인용
> 첫 답변**까지 데려다줍니다. 기능 전체 지도는 [SYSTEM-MAP](SYSTEM-MAP.md).

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
ollama pull qwen3.5:2b-q4_K_M          # low,  ~1.9 GB, 159 ms first-token (recommended)
ollama pull qwen2.5:7b-instruct        # mid,  4.7 GB, proven baseline
ollama pull qwen3.5:9b-q4_K_M          # high, 6.6 GB, best reply quality
ollama pull qwen3.6:27b                # power, 17 GB, agentic coding

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
| **low** | `qwen3.5:2b-q4_K_M` | 1.9 GB | 6 GB | **recommended daily-driver** — Apr 2026 Qwen 3.5, 159 ms first-token via `OllamaProvider` (think:false auto) | thinking model (Muse handles automatically) |
| **mid** | `qwen2.5:7b-instruct` | 4.7 GB | 8 GB | proven baseline, 201 ms first-token, 27 tok/s | older (Sep 2024) |
| **high** | `qwen3.5:9b-q4_K_M` | 6.6 GB | 12 GB | best reply quality at moderate cost, Apr 2026 Qwen 3.5 | needs ≥ 12 GB RAM |
| **power** | `qwen3.6:27b` | 17 GB | 32 GB | open-weight agentic-coding tier (Apr 2026), best 27 B coding model | M-Pro 32 GB+ or workstation only |

**Why low + mid stay on Qwen 2.5 even though Qwen 3.5 is newer:** the
3.5 family carries multimodal-Omni preprocessing overhead even for
plain-text prompts. Dogfood measurements on this machine:

| Model | Quant | Warm first-token | Verdict |
| --- | --- | --- | --- |
| qwen3.5:2b-q4_K_M (via Muse OllamaProvider) | Q4_K_M | **159 ms** | **JARVIS-fit** ← new default |
| qwen2.5:7b-instruct | Q4_K_M | **201 ms** | JARVIS-fit |
| qwen2.5:1.5b-instruct | Q4_K_M | **90 ms** | JARVIS-fit (legacy) |
| qwen3.5:0.8b (Q8-only) | Q8 | hard to use (no Q4 build) | skip |
| qwen3.5:2b (Q8 default, /v1 endpoint) | Q8 | 134 s | reasoning-on artifact — Muse routes via /api/chat + think:false |
| qwen3.5:2b-q4_K_M | Q4_K_M | 39 s | borderline |

Qwen 3.5:9 B stays as the "high" tier because at that size reply
quality matters more than first-token latency, and the multimodal
overhead amortises better. When Alibaba publishes a non-Omni
3.5 / 4 build, we'll re-test and likely promote it.

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

## Web search (optional — SearXNG self-hosted)

Local models (Qwen / Llama / etc.) don't have a server-side
`web_search` tool the way Gemini / Anthropic / OpenAI do. Muse's
`muse.search` MCP tool fills the gap with **two backends, picked
in order**:

1. **SearXNG** (preferred when `MUSE_SEARXNG_URL` is set) — JSON
   API over a self-hosted aggregator. Hits 200+ upstream engines
   (Google, Brave, Bing, Wikipedia, StackOverflow, arXiv, …),
   cross-validates results across them, and returns
   `{ title, url, content }`. No API key, no rate limit beyond
   what your instance enforces. AGPL-licensed.
2. **DuckDuckGo HTML scrape** (default, zero-config) — works out
   of the box but brittle (DDG can change markup) and rate-limited.

For a JARVIS-class agent on a 2B local model, search quality
bounds answer quality, so SearXNG is the recommended path.

### Verified install (Docker Desktop / Rancher Desktop, ~2 min):

```bash
# 1. Settings (enables JSON format — required by muse.search).
mkdir -p ~/.muse/searxng
cat > ~/.muse/searxng/settings.yml <<'YAML'
use_default_settings: true
server:
  secret_key: "muse-searxng-local-only-not-secret"
  limiter: false
  image_proxy: false
search:
  formats:
    - html
    - json
YAML

# 2. Run (foreground stops with Ctrl-C; -d for background).
docker run -d --rm --name muse-searxng \
  -p 8888:8080 \
  -v ~/.muse/searxng:/etc/searxng:rw \
  -e BASE_URL=http://localhost:8888/ \
  searxng/searxng:latest

# 3. Smoke (should return JSON with `results` array).
curl -s "http://localhost:8888/search?q=test&format=json" | head -c 200
```

### Wire it into Muse:

```bash
export MUSE_LOOPBACK_MCP_ENABLED=true
export MUSE_SEARXNG_URL=http://localhost:8888
# Optional CSV — restricts to specific upstream engines.
# export MUSE_SEARXNG_ENGINES=google,brave,duckduckgo
```

`muse.search` will now route queries to SearXNG and fall back to
DDG only if SearXNG fails (HTTP error, malformed JSON, zero
hits). Result payloads include a `backend: "searxng" | "duckduckgo"`
field so you can see which path responded.

### Stop / restart:

```bash
docker stop muse-searxng    # graceful stop (--rm removes the container)
docker logs muse-searxng    # if you started it without -d, just Ctrl-C
```

## Voice mode (optional)

Muse's voice loop (Whisper STT → local LLM → Piper TTS) needs two
extra binaries plus their model files. Probe what's installed:

```bash
muse setup voice
```

### Verified install (M3 Pro, ~5 min, zero recurring cost):

```bash
# 1. binaries
brew install whisper-cpp pipx
pipx install piper-tts

# 2. model files
mkdir -p ~/.muse/whisper-models ~/.muse/piper-voices

# Whisper base.en — 140 MB, English STT (multilingual `base` adds Korean / Japanese / ...)
curl -L -o ~/.muse/whisper-models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin

# Piper lessac medium — 63 MB, US English TTS (KSS for Korean voice)
cd ~/.muse/piper-voices
curl -LO https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx
curl -LO https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json

# 3. verify — all four checks should be [ok]
muse setup voice
```

Measured roundtrip on this machine after the install above:

  | Stage | Command | Time |
  | --- | --- | --- |
  | TTS  | `echo "Hello Stark..." \| piper --model ...` | ~200 ms (Metal-accelerated) |
  | STT  | `whisper-cli -f greeting.wav -m ggml-base.en.bin` | **525 ms total** |
  | Roundtrip | piper → whisper-cli | < 1 s |

Whisper-cpp's Metal backend (Apple-Silicon GPU) is what makes 525 ms
end-to-end possible. Linux/Windows users on CPU should expect
3–5× slower; the install path is identical.

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
