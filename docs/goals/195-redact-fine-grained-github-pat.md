# 195 — redact the fine-grained GitHub PAT shape

## Why

`redactSecretsInText` (@muse/shared) is the credential-scrub
chokepoint: it runs pre-delivery on proactive notices, on the
user-memory store (goal 182), and anywhere a secret could
round-trip back out via Telegram / Slack / a log line. Its
GitHub pattern is:

```
{ name: "github-pat", regex: /gh[pousr]_[A-Za-z0-9_]{30,}/gu }
```

That matches the **classic** tokens (`ghp_`, `gho_`, `ghu_`,
`ghs_`, `ghr_`) but **cannot** match GitHub's **fine-grained
PAT**, whose format is `github_pat_<22>_<59>`. `github_pat_`
does not start with `gh` + one of `p/o/u/s/r` + `_`
("github" → `g`,`i`,…), so a fine-grained token passes through
**unredacted**.

Fine-grained PATs are now GitHub's default, recommended token
format. For a git/GitHub-heavy personal agent (this repo also
ships Google-OAuth + git setup flows), a `github_pat_…` very
plausibly lands in a task title, note, or proactive notice —
and would round-trip back out in clear text. A missed
credential is the worst failure mode for this function (its
own doc comment: "a false negative on a real credential" is
the thing to avoid).

## Scope

- `packages/shared/src/index.ts`: add one pattern,
  `/\bgithub_pat_[A-Za-z0-9_]{30,}\b/gu`, reusing the
  `github-pat` family name so the operator-visible
  `[redacted-github-pat]` marker is identical for classic and
  fine-grained (same secret kind). Placed adjacent to the
  classic pattern. `{30,}` (the body is ~82 chars) catches it
  without being brittle on GitHub's exact segment lengths;
  `\b` anchors avoid matching the bare `github_pat_` prefix in
  prose.
- `packages/shared/test/shared.test.ts`: new case — a
  fine-grained token is redacted, the classic shape still
  works (no regression), and the bare `github_pat_` prefix in
  a sentence is NOT a false positive. Prefix split via
  `github_pat${"_"}` so the source has no contiguous literal
  for GitHub push-protection (same trick the Stripe/GitLab
  tests use).

## Verify

- `pnpm --filter @muse/shared test` — 8 pass (1 new).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Pure deterministic string function — no model invoked, no
  smoke:live needed.

## Status

done — both classic and fine-grained GitHub PATs are now
scrubbed by the shared redaction chokepoint, closing a
common false-negative for a GitHub-heavy personal agent.
