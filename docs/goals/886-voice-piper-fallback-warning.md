# Goal 886 — setup status warns when `MUSE_VOICE_TTS=piper` silently falls back to paid OpenAI

## Outward change

`muse setup --json` / `GET /api/setup/status` (the `muse doctor`
surface) now flags a specific zero-cost footgun: a user who sets
`MUSE_VOICE_TTS=piper` (local, free speech) but forgets
`MUSE_PIPER_VOICE` gets **silently** downgraded to paid OpenAI TTS
when an OpenAI key is present. The voice section previously reported
only the *resolved* backend (`openai-tts`) with no hint that the
user's explicit local choice didn't take effect. It now carries a
`nextStep`: *"MUSE_VOICE_TTS=piper needs MUSE_PIPER_VOICE … without
it TTS fell back to openai-tts. Set MUSE_PIPER_VOICE for local,
zero-cost speech."*

## Why this, now

Muse's hard constraint is zero-cost / local-first. The most
expensive silent failure on the voice axis is exactly this: the user
opts into free local Piper, mistypes the config, and unknowingly
streams every reply through a billed cloud API. `buildVoiceRegistry`
already does the `piper && MUSE_PIPER_VOICE` fallback correctly; the
gap was purely diagnostic — `muse doctor` showed the effect without
the cause. A real, verifiable correctness/UX gap on a fresh surface
(voice config diagnostics) directly serving the cost mandate.

## How

Extracted the inline voice-section logic from
`collectSetupStatusJson` into a pure, env-injected
`resolveVoiceStatus(env)` (mirrors `buildVoiceRegistry`'s resolution
so the report matches what actually runs). It adds a second
`nextStep` branch: when `MUSE_VOICE_TTS=piper` but `MUSE_PIPER_VOICE`
is unset, explain the fallback and how to fix it. The
both-backends-none hint is unchanged. The async snapshot now just
calls the helper.

## Verification

`@muse/autoconfigure` `setup-status.test.ts`: four direct
`resolveVoiceStatus` cases — piper-without-voice-file +
OpenAI-key → `ttsBackend: openai-tts` with the `MUSE_PIPER_VOICE`
fallback warning; piper WITH voice file → `piper`, no warning;
nothing configured → `info` + full setup hint; OpenAI-key-only →
both OpenAI backends, no warning. Mutation-proven: dropping the
piper-fallback branch fails the warning case. Pure refactor of the
existing inline logic otherwise (snapshot shape unchanged — CLI/API
consumers untouched). `@muse/autoconfigure` 266 green, `pnpm check`
exit 0, `pnpm lint` 0/0. Config-diagnostics path, not the LLM path →
no smoke:live (Ollama down regardless).

## Decisions

- Extracted to a pure function rather than adding the branch inline:
  the inline logic sat inside an async, FS-bound function that can't
  be unit-tested without faking the filesystem and global env;
  pulling it out is the minimal way to test the new warning
  deterministically (and matches the sibling
  `readWebSearchEnvSnapshot` / `readActuatorReadiness` pattern).
