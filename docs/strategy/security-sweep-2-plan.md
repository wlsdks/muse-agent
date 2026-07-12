# Security sweep 2 — findings & remediation plan

2026-07-12. Second fable5-driven security investigation (5 deep scouts on surfaces
the first sweep did not cover), each finding independently verified by trace +
live repro. 13 findings. This is the **plan** — not all fixed yet; the P0 items
are recommended for immediate remediation.

Sweep 1 (already fixed + Opus-gated) closed: CLI-embedding egress bypass,
zero-width marker-escape bypass, `browsing` marker omission, un-annotated MCP
tool fail-open. This sweep goes deeper.

## Priority summary

| P | Finding | Surface | Sev | Verified | Effort |
|---|---|---|---|---|---|
| **P0** | #1 Reverify grounding judge reads poisoned evidence RAW | grounding | **HIGH** | ✅ traced | S (TS, 1 line + test) |
| **P0** | #2 Model `env.PATH` overrides command resolution → guard bypass | runner | **HIGH** | ✅ rustc repro | S–M (TS+Rust) |
| **P1** | #3 API auth fail-OPEN: `MUSE_REQUIRE_AUTH=true` + no JWT secret = no auth | api | MED (HIGH if 0.0.0.0) | ✅ traced | S (fail-close at boot) |
| **P1** | #4 High-value credentials (API keys, bot tokens) stored PLAINTEXT | auth | MED | ✅ traced | M (encrypt-at-rest) |
| **P1** | #5 Feed loader has no SSRF guard + `file://` local read | web | MED | ✅ traced | S (route through assertPublicHttpUrl) |
| **P1** | #13 Zip-bomb DoS via `.docx`/`.pptx` (unbounded `inflateRawSync`) | parsing | MED-HIGH | ✅ live repro | S (`maxOutputLength` + size cap) |
| **P2** | #6 Missed code-exec env vars (JAVA_TOOL_OPTIONS, PYTHONHOME, …) | runner | MED | ✅ traced | S (extend allowlist) |
| **P2** | #7 Timeout kill ignores process tree → orphans + runner wedge | runner | MED | ✅ rustc repro | M (killpg/setsid) |
| **P2** | #8 `resolvesByOverlap` accepts forged citation on ONE shared token | grounding | MED | ✅ traced | S (require ≥2 / ratio) |
| **P2** | #9 TOFU channel pairing: first stranger claims the public bot | auth | MED (design) | ✅ traced | M (one-time pairing code) |
| **P3** | #10 `/api/multi-agent/*` routes lack per-route auth guard | api | LOW | ✅ traced | S (add guard) |
| **P3** | #11 DNS-rebinding TOCTOU on fetch/MCP (industry-wide) | web | LOW | ✅ traced | L (pinning resolver) |
| **P3** | #12 `adoptChannelOwner` misleading comment (no real TOCTOU) | auth | INFO | ✅ traced | XS (fix comment) |

## P0 — fix immediately (both undermine a CORE security property)

### #1 — Grounding reverify judge reads attacker-controlled evidence unsanitized
`packages/agent-core/src/recall-verdict.ts:336` builds the judge's evidence as
`matches.map((m) => m.text).join("\n")` — **raw**. The answer-*generation* path
sanitizes the same source text (`escapeSystemPromptMarkers(neutralizeInjectionSpans(text))`,
`packages/recall/src/context-blocks.ts:49`), but the grounding *verifier* — the
maker≠judge gate whose whole job is to catch fabrication — does not. So a prompt
injection embedded in a poisoned retrieved source (an ingested note, a feed
headline, a page title, a `--with-tools` web/MCP result, or a pasted/synced note
with no ingest-provenance `trusted:false` tag) coerces the local judge to "YES",
upgrading a weak / low-coverage / value-drifted answer to a **grounded** verdict
— the "I'm not sure" warning is suppressed and receipts render. This is the exact
asymmetry class of sweep-1's marker-escape fix (generator defended, verifier not),
and it attacks fabrication=0 — Muse's release gate.
**Fix:** `evidence = matches.map(m => escapeSystemPromptMarkers(neutralizeInjectionSpans(m.text))).join("\n")` + a delimiter/spotlighting fence in `buildGroundingReverifyPrompt`. Regression: an injection-bearing evidence case asserting the judge still returns the correct verdict (calibrated fault-injection drill per `agent-testing.md`). **Effort S, TS-only, low false-positive risk.**

### #2 — Model-supplied `env.PATH` overrides command resolution
`packages/tools/src/runner.ts:327` (`isUnsafeEnvKey` = `LD_/DYLD_` + `UNSAFE_ENV_EXACT`)
lets `PATH` through, and `crates/runner/src/main.rs:222` sets a sane PATH then
`:228` re-applies `request.env` (model-controlled) which overrides it. The runner
forces bare command names, so PATH is the ONLY resolution path — a
guard-passing name (`git`, `true`, `ls`) executes `/tmp/evil/git`. This **fully
defeats the command-name dangerous-command guard** we just hardened (it inspects
the string, not the resolved binary). Verified by a real rustc build.
**Fix:** add `PATH` to `UNSAFE_ENV_EXACT` on BOTH layers (strip model PATH; the
runner's own PATH resolves normal commands), OR make the `request.env` loop never
override the runner-set PATH. Regression: assert a model `env.PATH` does not
change resolution. **Effort S–M (touches Rust — cargo test + clippy).**

## P1 — fix soon (real, network/exposure or contract-violating)

- **#3 API auth fail-open.** `apps/api/src/server.ts:195` gates the whole auth
  preHandler on `if (authService)`; `authService` is undefined with no
  `MUSE_AUTH_JWT_SECRET`. So `MUSE_REQUIRE_AUTH=true` with no secret runs the
  entire API unauthenticated with no error — a silent violation of the operator's
  explicit hardening request (and CLAUDE.md fail-close). Under `HOST=0.0.0.0` this
  is full unauth network exposure. **Fix:** refuse to boot when `requireAuth` is
  true but `authService` is undefined (`runtime-assembly.ts:534` seam). Effort S.
- **#4 Plaintext high-value credentials.** Provider API keys (`~/.muse/models.json`,
  `setup-model.ts:268`), channel bot tokens (`messaging.json`,
  `credential-store.ts:83`), MCP PATs (`mcp-credentials.json`) are stored plaintext
  (0o600) — while lower-value stores already use `encrypted-file.ts`, and
  `cli-product.md`/`architecture.md` mandate keychain-or-encrypted for credentials.
  **Fix:** route these through `encrypted-file.ts` (or a keychain write path). Effort M.
- **#5 Feed loader SSRF + `file://`.** `apps/cli/src/commands-feeds.ts:72`
  `loadFeedBody` fetches with `redirect:"follow"` and no pre/post host check
  (unlike `fetch-readable-url.ts`), and `:73` allows `file://` → arbitrary local
  read. A trusted feed can `302 → 169.254.169.254/…` (metadata). CLI-only (not
  model-exposed) caps it at MED. **Fix:** route the http(s) branch through
  `assertPublicHttpUrl` before AND after redirect; drop/path-gate `file://`. Effort S.
- **#13 Zip-bomb DoS in the OOXML reader.** `packages/recall/src/document-reader.ts:169`
  decompresses `.docx`/`.pptx` parts with `inflateRawSync(compressed)` and **no
  `maxOutputLength`**, with no pre-parse file-size cap; a ~500 KB crafted `.docx`
  drove 2.1 GB RSS + 3 min CPU against the real `docxToText` (a 20 MB bomb → OOM).
  Reached by `muse read <file>`, `muse ask --file`, and the directory walk.
  **Fix:** `inflateRawSync(compressed, { maxOutputLength: ~25–50MB })`, a
  compSize→uncompressedSize ratio sanity check, and an input-buffer size cap in
  `commands-read.ts` before `extractDocumentText` (also cap the PDF path). Effort S.

## P2 — schedule

- **#6** Extend the runner env allowlist: `JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`,
  `JDK_JAVA_OPTIONS`, `PYTHONHOME`, `NODE_PATH`, `CLASSPATH`, `GEM_HOME`, `GEM_PATH`,
  `LESSOPEN` — each an interpreter-startup code-injection path. Effort S (paired with #2).
- **#7** Runner timeout kill: spawn in its own session + `killpg`, and bound the
  drain-join so a pipe-holding backgrounded grandchild can't wedge the runner
  (verified: `sh -c "sleep 300 &"` wedges + orphans). Effort M (Rust).
- **#8** `resolvesByOverlap` (`recall-citations.ts:86`) accepts a forged free-text
  citation on ONE shared content token. Tighten to ≥2 tokens or a coverage ratio.
  Partially defended on ask (coverage floor) and unreachable on chat (notes-only).
  Effort S.
- **#9** Replace TOFU bot pairing with a one-time pairing code shown in the web
  console (already a tracked TODO). Effort M.

## P3 — backlog / accept

- **#10** Add per-route `requireAuthenticated` to `/api/multi-agent/*` for
  defense-in-depth (currently covered only by the global preHandler). Effort S.
- **#11** DNS-rebinding TOCTOU on fetch/MCP — industry-wide; needs a custom
  resolver/agent that pins the vetted IP. Effort L. Accept-for-now (loopback bind
  + post-redirect re-check mitigate).
- **#12** Fix the misleading "first-writer wins on re-read" comment in
  `channel-owner-store.ts:36` (no real TOCTOU — sequential processing). Effort XS.

## Confirmed DEFENDED (no action) — recorded so we don't re-scout

Filesystem path confinement (realpath + deny-list + `O_NOFOLLOW`), seatbelt SBPL
escaping, id→filename sanitizers, `allowNetwork` never model-parsed, timeout /
`maxOutputBytes` clamped, JWT (HS256 pinned, `timingSafeEqual`, `exp` enforced,
rotation bounded), scrypt password hashing, keychain read (`execFile`, no shell),
tokens never echoed, encoded-IP SSRF (WHATWG canonicalization blocks decimal/hex/
octal/IPv6-mapped), `web_action` manual-redirect, RSS XXE (fast-xml-parser skips
`&`-bearing DOCTYPE entities + maxEntityCount/Size + streamed body cap), MCP remote
post-resolution private-host check, CORS (no `*`+credentials), the outbound
approval / consent / veto seams, the citation gate's `ungrounded` demotion +
per-claim ISSUP on the primary path, the ICS parser (linear, anchored regexes),
injection-pattern regexes (bounded quantifiers), `mergeModelKeysFromFile`
(allowlist projection — no prototype pollution), and the user/model grep-regex
`(a+)+` catastrophic-backtracking guards.
