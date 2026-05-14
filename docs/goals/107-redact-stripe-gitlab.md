# 107 — `redactSecretsInText` covers Stripe + GitLab tokens

## Why

`redactSecretsInText` (goal 086) scrubs high-confidence credential
shapes from text before it hits the proactive-notice delivery
loop, the messaging providers (Telegram / Slack / Discord / LINE),
and any other surface that round-trips user-written content to
the outside world. The existing patterns covered the most common
LLM + cloud keys (OpenAI / Anthropic / GitHub / AWS / Google /
Slack / JWT) but not two shapes a personal JARVIS will routinely
see in a developer's task / note text:

- **Stripe secret keys**: `sk_live_…` and `sk_test_…`, plus the
  restricted-access `rk_live_…` / `rk_test_…` variants. Live
  Stripe keys are direct financial exposure — leaking one into a
  Slack DM is materially worse than leaking an OpenAI key.
- **GitLab personal access tokens**: `glpat-…`. The modern shape
  is the one GitLab UI hands out today.

## Scope

- `packages/shared/src/index.ts` `SECRET_PATTERNS` gains:
  - `stripe-secret`: `(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{24,}`.
    Underscore separator so no collision with OpenAI's `sk-`.
  - `gitlab-pat`: `glpat-[A-Za-z0-9_-]{20,}` with word boundaries.
- Stripe **publishable** keys (`pk_live_…` / `pk_test_…`) are
  intentionally NOT redacted — Stripe embeds them in client-side
  code by design, and replacing them in a customer-facing
  config-dump message would break copy-paste help.

## Verify

- New `packages/shared/test/shared.test.ts` cases:
  - `sk_live_<24>` / `sk_test_<24>` / `rk_live_<24>` → redacted.
  - `pk_live_<24>` stays visible.
  - `glpat-<20>` → redacted.
  - `glpat-ok` (too short for a real token) stays as-is.
- `pnpm --filter @muse/shared test` — 7 tests pass.
- `pnpm check` exit 0; `pnpm lint` exit 0.
- No real-LLM path touched (`redactSecretsInText` is pure).

## Status

done — proactive notices + messaging-out scrub Stripe secrets and
GitLab PATs the same way they already scrubbed OpenAI / Anthropic /
GitHub keys.
