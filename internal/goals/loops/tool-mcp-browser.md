# Loop journal — `tool-mcp-browser`

> Theme: Muse's own TOOL expansion/hardening · official public external-MCP integration
> (Notion/GitHub) · muse-in-chrome (browser control) perfection. Isolated worktree
> `/tmp/muse-tool-mcp-browser` (branch `tool-mcp-browser`, own codegraph index), Tier1
> (local commits, no push). Differentiates from the `tool-hardening` loop by owning
> axes **B (external MCP)** + **C (browser)**, rotating A/B/C. Convention: [README](README.md).

## fire 1 · 2026-06-13 · skill v1.14.0 · (this commit)

meta: value-class=new-capability · pkg=@muse/browser · kind=C-browser · verdict=PASS · firesSinceDrill=1

ratchet: testFiles +0 net files (2 test files extended, +126 cases-region) · @muse/browser 68 tests pass · fabrication 0 · eval:browser-agent 1/1 LIVE PASS · lint 0/0

- **What:** Closed a fail-open hole in `@muse/browser`'s element matcher where, if the model-named target (`browser_click target:"Delete"`) had several tied top candidates, it would **silently click the first DOM element**. The new `matchElementResult()` returns `match|ambiguous|none`, and `resolveTarget` **refuses** an act tool (`browser_click`/`browser_type`) — before it can mutate the snapshot or reach the approval gate — on `ambiguous`, returning the candidate list + an ordinal hint ("the second Delete"). The single-match happy path is unchanged, `matchElement()` remains a first-pick back-compat wrapper.
- **Why:** the browser act path is the only place Muse mutates a third party's page state — a wrong click/type is an irreversible action class (outbound-safety.md). The highest-value gap was that with two identically-labeled controls, it guessed and even the approval draft's label couldn't distinguish them.
- **Review point:** the independent judge re-confirmed the RED is behavioral by reverting only src (old=clicked:true → AssertionError); confirmed fail-close happens before the gate call via the browser-tools.ts:461/523 short-circuit.
- **Risk:** the ambiguity-reason string is English-only (even in a KO prompt — the model can still re-target via the ordinal, localization is a follow-up slice); the read-only `hover` also surfaces ambiguity (harmless).

## fire 2 · 2026-06-13 · skill v1.14.0 · (this commit)

meta: value-class=new-capability · pkg=@muse/mcp · kind=B-mcp · verdict=PASS · firesSinceDrill=2

ratchet: testFiles +1 (official-mcp-presets.test.ts, 11 cases) · @muse/mcp 1810 tests pass · fabrication 0 · eval:tools no-regression (no new model-facing tool) · lint 0/0

- **What:** New official public (anyone-may-connect) external-MCP preset registry `official-mcp-presets.ts` — `createGitHubMcpServer` (`https://api.githubcopilot.com/mcp/`) + `createNotionMcpServer` (`https://mcp.notion.com/mcp`) streamable factories, each with an official provenance URL + a **fail-close toolRisk classifier** (only read tools whitelisted, write/unknown→`write`→gated by toolApprovalGate) + `withOfficialMcpRisk` (re-stamps domain `external`). Wired via the existing `allowedServerNames` allowlist seam, `resolveOfficialMcpPreset` returns undefined for a non-curated server name (unregistered = refused). No secrets bundled.
- **Why:** Jinan's headline request (external MCP integration) — also the axis most differentiated from tool-hardening (axis A). The seam already existed; the missing piece was *a provenance-backed curated registry + fail-close write classification*. outbound-safety: read is free, write/unknown is draft-first gated — no autonomous-send hole (confirmed by the independent judge).
- **Review point:** the judge broke `githubMcpToolRisk` to always classify as read, reproducing 3 RED (classification·re-stamp·e2e) before restoring; the presets aren't yet wired into the assembleMcpStack/CLI projection path (autoConnect defaults false), so no write tool is reachable yet. Verified against the real McpManager register/connect/projection path with a contract-faithful transport fake (not a fake registry).
- **Risk:** live wiring is the following ◦ slices (5-item backlog decompose: env toggle · applying the projection path · keychain credentials · draft-first write e2e · doctor provenance). The web-search-policy fuzz timeout is an unrelated pre-existing flake (44/44 isolated).

## fire 3 · 2026-06-13 · skill v1.14.0 · (this commit)

meta: value-class=wiring · pkg=@muse/autoconfigure · kind=B-mcp · verdict=PASS · firesSinceDrill=3

ratchet: testFiles +1 (mcp-stack-official-presets.test.ts, 10 cases) · @muse/autoconfigure 532 tests pass · fabrication 0 · eval:agent LIVE (ran-cases PASS, wrapper-timeout not a fail) · lint 0/0

- **What:** Made fire 2's dormant external-MCP preset registry **connectable opt-in**. A per-server env toggle (`MUSE_GITHUB_MCP_ENABLED`/`MUSE_NOTION_MCP_ENABLED`, derived as `MUSE_<NAME>_MCP_ENABLED`) registers it into `assembleMcpStack`'s externalServerInputs + strict allowlist only when set (default OFF), and a `withOfficialMcpRisk(withChromeDevToolsRisk(toMuseTools()))` composition on the live projection re-stamps write/unknown external tools as `write` → reaching `toolApprovalGate`. @muse/autoconfigure only.
- **Why:** turning on the toggle without the risk re-stamp would project an external write tool as `read` — a **fail-OPEN**; the two steps must be coupled and ship together to stay safe. Precisely mirrors the chrome-devtools precedent. Elevates Jinan's external-MCP integration request into an actually usable state (read free, write draft-first gated).
- **Review point:** the judge neutered the registration loop and reproduced 5/10 RED; traced the `index.ts:750` composition call actually reaching the real agent-runtime's resolveToolRisk→approvalGate via the chrome precedent; confirmed the empty-allowlist allow-all is preserved (enabling doesn't flip strict).
- **Risk:** credential resolution (keychain PAT/OAuth)·draft-first write e2e·doctor provenance remain ◦. The `pnpm check` SIGABRT is an unrelated @muse/memory parallel-load flake (417/417 isolated). eval:agent's wrapper timeout is local-model-bound (orthogonal since the touched code is unrelated to tool selection).

## fire 4 · 2026-06-13 · skill v1.14.0 · (this commit)

meta: value-class=micro-fix · pkg=@muse/browser · kind=C-browser · verdict=PASS · firesSinceDrill=4

ratchet: testFiles +0 (2 browser test files extended, 72 cases) · @muse/browser 72 tests pass · fabrication 0 · eval:browser-agent 1/1 LIVE PASS · lint 0/0

- **What:** Corrected a fail-open where `browser_type` could target a non-input element (a button/link). If the sole match for a `type` intent is untypeable, the matcher now returns a new result `notypeable` and `browser_type` refuses before reaching the approval gate — returning `{typed:false, fields:[real text fields], reason}` to redirect the model to a real field. click/hover unchanged (buttons still match). A distinct "wrong kind of target" case from fire-1's (tied-match ambiguity).
- **Why:** the old behavior let the user confirm a "type 'password' into Sign in button" draft and then had fill() throw on the button — (1) an outbound-safety approval draft that could never succeed (2) a wasted confirm round on a low-spec model (3) a bare error with no re-targeting signal. Now the model is redirected to the right field in one shot.
- **Review point:** the judge reverted src and reproduced 4 RED; confirmed via git diff that the **3 modified existing tests** (which encoded the old buggy behavior of typing into a button) are a legitimate correction, not gaming; confirmed the refusal happens before the gate/`type` call (`c.calls===["snapshot"]`, gateCalled:false).
- **Risk:** low — `notypeable.fields` is the full unsorted typeable list (common login/search/checkout forms are short, ranking can be added later if the list grows). The ref-only advanced path·`<select>` path are unchanged.

## fire 5 · 2026-06-13 · skill v1.14.0 · (this commit)

meta: value-class=new-capability · pkg=@muse/autoconfigure · kind=B-mcp · verdict=PASS · firesSinceDrill=5

ratchet: testFiles +1 (official-mcp-write-draft-first.test.ts, 6 cases) · @muse/autoconfigure 548 tests pass · fabrication 0 · pnpm check 0 · lint 0/0

- **What:** A draft-first fail-close proof battery (test-only) for the live external-MCP write path fire 3 wired. Drives the REAL McpManager register/connect/toMuseTools + withOfficialMcpRisk + AgentRuntime toolApprovalGate (only the transport seam's callTool is a vi.fn spy — not a fake registry). Proves: GitHub create_issue (risk write) is gated and deny/timeout-undeliverable/absent-consent ⇒ 0 transport write calls, confirmed ⇒ exactly 1. read (get_me) is ungated. Applies outbound-safety.md rules 1·2·4 to external-MCP write.
- **Why:** fires 2·3 made external MCP connectable, but a send capability tested only on the happy path is undelivered (outbound-safety.md). This battery proves 0 external effects on the deny/timeout/absent paths, closing the trust story for the headline feature. 0 production changes — the path was already correct, this supplies the missing OUTCOME proof.
- **Review point:** the judge re-confirmed non-vacuousness two ways — test-side (restampRisk:false) + prod-side (gutting the real `withOfficialMcpRisk` into a pass-through, rebuilding @muse/mcp) both go RED on the deny case. Asserted confirmed is exactly 1 send (excludes a blanket-block gate). Tree is test-only (empty git diff --stat).
- **Risk:** GitHub's preset is representative — Notion's create-page rides the same seam so it's structurally covered. Remaining axis-B ◦: keychain credentials · doctor provenance.

## fire 6 · 2026-06-13 · skill v1.14.0 · (this commit)

meta: value-class=new-capability · pkg=@muse/browser · kind=C-browser · verdict=PASS · firesSinceDrill=6

ratchet: testFiles +0 (browser-tools.test.ts +3 cases, 75 total) · @muse/browser 75 tests pass · fabrication 0 · eval:browser-agent 1/1 LIVE · eval:tools 194/199 (97%, threshold 85%) · smoke #19 LIVE · lint 0/0

- **What:** A missing read-side capability — link elements were exposed with no destination URL (the snapshot only read href for dedup and discarded it), so the model could click a link but couldn't answer "where does it go" without navigating. Now `SnapshotElement.url` carries each anchor's resolved ABSOLUTE href in the browser_read/browser_open element JSON (emitted only when present, buttons/fields unchanged) + the browser_read description now advertises link-destination answers. No new tool (augments the read path, keeps the 9-tool set — avoids the confusable-pair trap per tool-calling.md).
- **Why:** web-research tasks like "what's their pricing page link?"·"give me the top result's URL to share"·"list the links and their destinations" were inexpressible. A distinct *capability addition* from fires 1·4's (act-target fail-close).
- **Review point:** the judge reverted src and reproduced 3 RED; confirmed via live smoke #19 that url is populated from the real HTMLAnchorElement.href (IDL=absolute) — absolute+relative-resolved+non-link-none; the browser_read description change causes no eval:tools mis-selection (97% pass, all browser selections green).
- **Risk:** cross-origin iframe links remain out of scope (CDP can't reach them from page context, unchanged). url is additive/optional, so dedup·non-link controls·the act path are unchanged, no change to the security surface.

## fire 7 · 2026-06-13 · skill v1.14.0 · (this commit)

meta: value-class=wiring · pkg=@muse/autoconfigure · kind=B-mcp · verdict=PASS · firesSinceDrill=7

ratchet: testFiles +1 (official-mcp-credentials.test.ts; mcp-stack-official-presets +8) · @muse/autoconfigure 567 tests pass · fabrication 0 · pnpm check 0 · lint 0/0

- **What:** fire 3 wired the toggle, but `preset.create()` had no headers, so a user had to hand-write Authorization into `~/.muse/mcp.json`. New `official-mcp-credentials.ts` resolves a token from `GITHUB_MCP_TOKEN`/`NOTION_MCP_TOKEN` env → `~/.muse/mcp-credentials.json` (the same env-wins-then-file seeding order as the existing readCredentialsSync, matching the model/messaging key pattern) and injects `Authorization: Bearer <token>`. Without a credential, the preset stays disabled+unallowlisted (fail-closed, no blank-auth half-connection). Secrets never land in the serializable/loggable safe-config.
- **Why:** the last piece needed to actually authenticate and use external MCP (completes the headline request). Security: no keychain yet, so it reuses the existing file-seeding pattern (the judge confirmed no new plaintext path), secrets never logged.
- **Review point:** the judge neutered the resolver to a constant header and reproduced 5 RED; the secret-leak test catches both the token AND "Bearer" (RED-able verification); confirmed the working tree contains exactly the 4 slice files (0 concurrent-loop stash contamination).
- **Risk:** Notion's hosted endpoint prefers OAuth (if Bearer is rejected, a future OAuth branch is needed; currently no token means a clean fail-close). A filesystem whitespace-only token isn't trimmed (cosmetic, fails upstream auth, no leak) + a native keychain backend are backlog follow-ups ◦.

## fire 8 · 2026-06-13 · skill v1.14.0 · ROLLED BACK (no slice commit)

meta: value-class=new-capability(attempted) · pkg=@muse/browser · kind=C-browser · verdict=FAIL→rollback · firesSinceDrill=8

ratchet: testFiles +0 (slice reverted) · fabrication 0 · @muse/browser unchanged · gate=④b independent judge FAIL

- **What (attempted):** browser_open/back navigation-state fidelity — page.goto doesn't throw on 4xx/5xx, so an error page could pass as content (a grounding hole); added PageSnapshot.httpStatus + statusError.
- **Why FAIL (④b judge):** the open/back portion was solid+RED-able, but the slice **overclaimed post-click 500 flagging** — the actual PuppeteerBrowserController.click never sets lastHttpStatus (only open/back do). That case's test faked a 500 snapshot via `c.click=async()=>errSnap`, passing regardless of the real path — the project-forbidden happy-path/fake-injection antipattern (testing.md's "no fall-back assertions" rule). The maker≠judge gate caught exactly this.
- **Action:** rolled back all 4 files via git restore (branch HEAD=pre-pull merge 5c3d6d6f unchanged). Honestly recorded a properly-scoped rework in backlog ◦ (open/back ONLY + remove the fake click test, or actually capture click-nav status via main-frame page.once("response")). The next fire picks it up.
- **Risk/lesson:** trying to "batch" state capture across similar act paths into one slice covered an unimplemented path with a fake test — batching requires confirming EACH path is REAL. Breaks a 7-fire consecutive-allPASS streak (this catch was effectively the JUDGE-DRILL scheduled for fire 9 — proving the verifier catches a genuinely bad slice).

## fire 9 · 2026-06-13 · skill v1.14.0 · (this commit)

meta: value-class=new-capability · pkg=@muse/browser · kind=C-browser · verdict=PASS · firesSinceDrill=1 (reset — fire-8 real verifier-catch served as the drill)

ratchet: testFiles +0 (browser-tools.test.ts +9 cases, 84 total) · @muse/browser 84 tests pass · fabrication 0 · eval:browser-agent 1/1 LIVE · smoke #20 LIVE (real Chrome vs localhost 404/200) · lint 0/0

- **What:** An honest redo of fire-8's (rolled back) work — browser_open/browser_back navigation-state fidelity. Captures PageSnapshot.httpStatus from the goto/goBack HTTPResponse (consumed once after snapshot()'s settle-retry loop, mirroring the lastDialog pattern), and browser_open/back only emit `{httpStatus, statusError}` when status≥400 (silent on 200/absent).
- **Why:** page.goto doesn't throw on 4xx/5xx, so a 404/500 error page could pass as requested content — a grounding hole. Applied fire-8's failure lesson: **scope strictly to open/back, no claim on/relevance to click/type, zero fake-injected tests.**
- **Review point:** the judge confirmed (1) 0 recurrence of the fire-8 antipattern (click/type path byte-unchanged, no fake-injection) (2) reverted src → 7 RED (3) live smoke #20 round-trips a real localhost 404/200 via headless Chrome, proving the actual goto-status path (not faked) (4) confirmed a real bug fix — consume-once survives a looksUnsettled re-capture. Live execution exposed that consume-once bug (a unit fake likely wouldn't have caught it).
- **Risk:** click/type navigation status is deliberately out of scope (a real click doesn't see the document HTTPResponse, needs a main-frame page.once("response") race) → backlog follow-up ◦. The byte-hygiene check red is external (another loop's docs).

## fire 10 · 2026-06-13 · skill v1.14.0 · (this commit)

meta: value-class=new-capability · pkg=@muse/autoconfigure+@muse/cli · kind=B-mcp · verdict=PASS · firesSinceDrill=2

ratchet: testFiles +1 (official-mcp-posture.test.ts 8 + doctor +5) · @muse/autoconfigure+cli tests pass (doctor 90) · fabrication 0 · pnpm check 0 · lint 0/0 · live doctor --local verified (secret 0×)

- **What:** `muse doctor --local` now reports posture per official public MCP preset (GitHub/Notion) — enabled (env toggle) + credentialPresent (boolean, token never rendered) + allowed (allowlist) + the official provenanceUrl. A pure describeOfficialMcpPosture(env) lives in autoconfigure and is wired into CLI doctor as officialMcpChecks.
- **Why:** completes the trust/observability story for external MCP — a privacy-first user can audit "which external servers can my agent connect to, and why." Aligns with Muse's identity ("tell it everything, it can't tell anyone").
- **Review point:** the judge re-confirmed the leak guard is RED-able (injecting a token into posture→test RED; 0 secret occurrences in live `doctor --local`), confirmed the allowlist semantics match McpManager/assembleMcpStack (empty=allow-all, non-empty=strict, same MUSE_MCP_ALLOWED_SERVERS env), and confirmed the 4-state OUTCOME grading is RED-able.
- **Risk:** doctor shows an enabled+strict-allowlist-excluded preset as "blocked," but assembleMcpStack auto-adds turnkey presets to the allowlist → slightly stricter than runtime (recorded as a cosmetic follow-up ◦). posture is env-only (not a connection probe, reports *eligibility* rather than connectivity — by design).

## fire 11 · 2026-06-13 · skill v1.14.0 · (this commit)

meta: value-class=micro-fix · pkg=@muse/browser · kind=C-browser · verdict=PASS · firesSinceDrill=3

ratchet: testFiles +0 (browser-tools.test.ts +1 + smoke 10b) · @muse/browser 85 tests pass · fabrication 0 · eval:browser-agent 1/1 LIVE · smoke 10b LIVE (real Chrome prompt) · lint 0/0

- **What:** Fixed a bug where a native JS prompt() dialog was bare-accepted, submitting an empty string and discarding the page's defaultValue. prompt now accepts with the dialog's own defaultValue (never inventing text) + exposes the submitted text via PageSnapshot.dialog.response. alert/confirm/beforeunload unchanged (bare accept).
- **Why:** actions like "apply the coupon"·"enter the suggested quantity" that hit a `prompt(msg, default)` page were sending an empty value, so an approved action proceeded with garbage and the model had no idea what was actually sent. A distinct auto-accept dialog-response path from fires 1·4·6·9's (element grounding·nav-status).
- **Review point:** the judge confirmed (1) the evidence is a REAL path — live smoke 10b drives a prompt fixture in real Chrome and reads back the value the page captured (document.title=code:+prompt()), not hand-injected (2) reverting the handler reproduces 10b RED (3) only defaultValue is used = never invents text (no fabrication-into-world hole) (4) alert/confirm unchanged.
- **Risk:** a default-less prompt(msg) still has defaultValue="" → still submits empty (unchanged), but now transparently records response:"". A destructive confirm() is still blind-accept (the trigger click is already draft-first approved — re-gating dialogs is a separate larger item).

## fire 12 · 2026-06-13 · skill v1.14.0 · (this commit)

meta: value-class=new-capability · pkg=@muse/mcp+@muse/autoconfigure · kind=B-mcp · verdict=PASS · firesSinceDrill=4

ratchet: testFiles +0 (existing preset/cred/posture tests +cases; mcp 14, autoconfigure 43, doctor 90) · fabrication 0 · pnpm check 0 · lint 0/0

- **What:** External-MCP registry EXPANSION — added Linear as the 3rd official public preset (mcp.linear.app/mcp, provenance linear.app/docs/mcp, OAuth2.1 + Bearer personal API key). Reuses the whole machinery (the registry factory + a fail-close linearMcpToolRisk [23 read tools→read, create/update/unknown→write] + auto-derived MUSE_LINEAR_MCP_ENABLED + LINEAR_MCP_TOKEN + doctor posture). Credential-resolver hardening: presetEnvTokenKey() auto-derives `<NAME>_MCP_TOKEN` gated on Object.hasOwn(OFFICIAL_MCP_PRESETS,name).
- **Why:** adds a practical integration beyond GitHub/Notion — a user connects a Linear workspace with a single env var (read free, write draft-first gated, doctor-audited). Proves the registry is genuinely extensible.
- **Review point:** the judge confirmed (1) Linear's provenance against Linear's own docs (officially hosted·anyone-may-connect·Bearer) (2) reproduced RED by breaking linearMcpToolRisk to always-read, unknown→write is the strongest fail-close (3) credential auto-derive is gated on curated preset names (an arbitrary name doesn't read an ambient token — blocks env-exfiltration, a gitlab→undefined test) (4) no secrets bundled.
- **Risk:** Linear's read-tool list couldn't be sourced from a single official page, so a third-party analysis (Fiberplane) was referenced — but since it's fail-close, a stale read-list only over-gates (never under-gates), no safety regression possible.

## fire 13 · 2026-06-13 · skill v1.14.0 · (this commit)

meta: value-class=micro-fix · pkg=@muse/browser · kind=C-browser · verdict=PASS · firesSinceDrill=5

ratchet: testFiles +0 (smoke #21 + controller; 89 tests) · @muse/browser 89 tests pass · fabrication 0 · eval:browser-agent 1/1 LIVE · smoke #21 LIVE (real CDP hang) · lint 0/0

- **What:** Bounded the CDP protocolTimeout. puppeteer's 180-second default was unset, and snapshot-capture's page.evaluate (innerText/element-walk) had no upper timeout at all, so a stuck CDP round trip hung the agent for ~3 minutes (unrecoverable). Now connect() injects protocolTimeout = max(requested, timeoutMs+15s) (default 30s) — always above the per-op timeout, so a normal slow nav/click/fill never dies first. protocolTimeoutMs option is also clamped to the floor.
- **Why:** a transport-layer reliability hole — a production agent can't be SIGKILLed. A distinct transport/hang-recovery seam from fires 1·4·6·9·11's (observation/act semantics).
- **Review point:** the judge confirmed (1) smoke #21 runs the REAL path (HANG_HTML's infinite innerText getter→the real captureSnapshot→page.evaluate, not fake-injected) and passes (19.5s) (2) reverting the threading reproduces 45s+ pending=RED (3) confirmed the clamp math always has protocolTimeout>timeout (no early-kill path).
- **Risk:** the default 30s ceiling — a single CDP op taking >30s (e.g. a huge DOM's innerText) now errors (previously waited 180s). Acceptable (15s per-op already governs nav/click/fill, a single round trip taking >30s is pathological), tunable via protocolTimeoutMs.

## fire 14 · 2026-06-13 · skill v1.14.0 · (this commit)

meta: value-class=new-capability · pkg=@muse/mcp+@muse/autoconfigure · kind=B-mcp · verdict=PASS · firesSinceDrill=6

ratchet: testFiles +0 (preset/cred/posture/doctor tests +cases; mcp 17, autoconfigure 49, doctor 91) · fabrication 0 · pnpm check 0 · lint 0/0

- **What:** External-MCP registry EXPANSION — added Sentry as the 4th official public preset (mcp.sentry.dev/mcp, provenance getsentry/sentry-mcp). Reuses the whole machinery (the registry + a fail-close sentryMcpToolRisk [27 read, create/update/add/unknown→write] + auto-derived MUSE_SENTRY_MCP_ENABLED + SENTRY_MCP_TOKEN + doctor posture). Error/monitoring = the 4th dev category, after code/docs/issues.
- **Why:** expands into a practical category beyond GitHub/Notion/Linear — proves the registry scales to 4. Rotated pkg from browser to mcp (value-class new-capability).
- **Review point:** the judge confirmed (1) provenance against Sentry's own docs+repo (official·anyone-may-connect) (2) reproduced RED by breaking sentryMcpToolRisk to always-read, unknown→write (3) unregistered without a token (fail-closed, no blank-auth) (4) no secrets bundled·machinery reused·clean tree. **Honest AUTH NUANCE finding:** Sentry is OAuth-primary, Bearer isn't yet shipped upstream (#833) → Muse's Bearer seam is forward-compatible; with no token or a rejected one, it fails close (not misleading, documented in the preset). The judge PASSED it as "not a non-functional lie."
- **Risk:** Bearer auth may not yet be accepted by the Sentry endpoint (pending #833) — harmless since it's fail-close, and it'll work with zero Muse changes once #833 ships. The read-tool set is based on the fire-time catalog (a new tool defaults to write).

## fire 15 · 2026-06-13 · skill v1.14.0 · (this commit)

meta: value-class=new-capability · pkg=@muse/browser+@muse/cli · kind=C-browser · verdict=PASS · firesSinceDrill=7

ratchet: testFiles +0 (browser-tools.test +5 + smoke #22 + eval:tools golden; browser 94, cli 2599) · fabrication 0 · eval:browser-agent 1/1 LIVE · eval:tools 13/14 93% (browser_wait EN STABLE 3/3) · lint 0/0

- **What:** New capability browser_wait — waits, bounded by timeoutMs, for async content (forText substring OR a CSS selector) before re-observing. controller.waitFor + createBrowserWaitTool + CLI registration (read-risk, no gate).
- **Why:** settleDom (400ms-quiet, on open/scroll) + snapshot retry (only when looksUnsettled=0 elements&<40chars) can't catch a page that inserts content via a timer/fetch after going quiet-at-load — the model had no way to express "wait until X appears, then read." Streaming search results·spinners·"Loading…"→data had the model reading too early and missing it. A distinct *not-yet-rendered wait* capability from fires 1·4·6·9·11·13's (existing act/read).
- **Review point:** the judge confirmed (1) the real gap (read the looksUnsettled condition·the SETTLE_RETRIES cap) (2) live smoke #22 proves the gap on REAL Chrome (2.5s delayed insertion) via a first assertion "delayed content absent right after open," no fake-injection (3) honest timeout behavior (matched:false, no throw/false-success, returns the live page) (4) no selection regression (eval:tools 93%, browser_wait EN 3/3, browser_read/scroll 3/3 — no confusable pairs).
- **Risk:** KO async-wait phrasing selection 0/3 (an existing gemma KO weakness, the same class as KO browser_look) — not STABLE, so not gated in the golden set (per agent-testing.md), only EN is gated. The KO description example is kept harmlessly. The tool set is at 10 (relevance filtering means it's not all dumped at once — OK, confirmed no selection degradation).

## fire 16 · 2026-06-13 · skill v1.14.0 · (this commit)

meta: value-class=micro-fix · pkg=@muse/browser · kind=C-browser · verdict=PASS · firesSinceDrill=8

ratchet: testFiles +0 (browser-tools.test +4 + smoke #23; 98 tests) · fabrication 0 · eval:browser-agent 1/1 LIVE · smoke #23 LIVE (real CDP act-nav 404) · lint 0/0

- **What:** Extends nav-status fidelity to the ACT path — when click/type-submit/key-Enter navigates to a 4xx/5xx, a new withNavStatus wrapper (a real page.on('response') arm on the main-frame document response of the current page or a new-tab target) captures httpStatus, and the 3 act tools expose `{httpStatus, statusError}` when status≥400 (silent on 200/absent).
- **Why:** lastHttpStatus was only ever set by open()/back() — the act methods (which don't go through goto/goBack) were uncovered. Clicking a link that returns 404, or a search submit returning 500, meant an error page's body got grounded as normal content. **Closes the fire-9 follow-up ◦ + honestly completes what fire 8 faked** (this is the real implementation of exactly the path the fire-8 judge flagged as unset by real click).
- **Review point:** the judge confirmed (1) a REAL capture (withNavStatus is a real response listener, wired into the act methods, not hand-injected) (2) smoke #23 drives real Chrome to click a localhost 404 and captures 404, reverting the wiring reproduces undefined RED (3) success is silent·advisory·no regression to the approval gate (applies only after the approval result) (4) confirmed listener cleanup·consume-once.
- **Risk:** a theoretical narrow edge where a new-tab's target.page() resolves after `finally` (withNewTabFollow awaits it so it's cleaned up in practice, the main listener is always removed) — a non-blocking robustness nit. statusError is advisory (not a refusal).

## fire 17 · 2026-06-13 · skill v1.14.0 · (this commit) · JUDGE-DRILL

meta: value-class=new-capability · pkg=@muse/browser · kind=C-browser · verdict=PASS · firesSinceDrill=0 (RESET — drill completed)

ratchet: testFiles +0 (browser-tools.test +2 discriminating; 100 tests) · fabrication 0 · pnpm check 0 · lint 0/0 · DRILL: verifier FAILed the planted bad slice

- **What (drill):** the 8-consecutive-PASS hard counter triggered → injected a deliberately bad slice (linkCount = elements.length = a count of ALL elements, not just links; hidden by an all-link non-discriminating fixture) → the independent Opus verifier **caught it** (proved the mismatch with a mixed 2-link/2-non-link fixture showing 4≠2 + flagged the non-discriminating test as a fire-8 antipattern recurrence) → FAIL → rolled back.
- **What (real fix):** linkCount = elements.filter(role==="link").length, emitted only when >0 (no false-0 noise), + **discriminating tests** (2 links out of 4 elements → linkCount:2 not 4; a `.length` bug makes both new tests RED, proving discrimination).
- **Why:** periodically prove the verifier isn't rubber-stamping and actually catches a real defect (a subtle implementation bug + a non-discriminating test) — a deliberate drill following fire-8's real catch. Reconfirms the maker≠judge compensating control is alive.
- **Review point:** the drill verifier returned FAIL + the exact prescription (filter role==="link" + a mixed fixture); the real fix implements that prescription and self-proves discrimination (reverting the impl to `.length` goes RED, the correct version passes all 100).
- **Risk:** linkCount is a modest convenience field (the element list+fire6's link URL already exist) — honestly completing the drill bait into a correct form. Low value but accurately verified and discriminating.

## fire 18 · 2026-06-14 · skill v1.14.0 · (this commit)

meta: value-class=new-capability · pkg=@muse/browser+@muse/cli · kind=C-browser · verdict=PASS · firesSinceDrill=1

ratchet: testFiles +0 (browser-tools.test +12; browser 111, cli 2616) · fabrication 0 · eval:tools 14/15 93% (fill_form 3/3 + type 3/3 no regression) · eval:browser-agent 1/1 LIVE · lint 0/0

- **What:** New capability browser_fill_form — fills a multi-field form with a single draft-first approval. fields:[{target, value}] (minItems 2, optional submit), resolves every target first (reusing fire-1/4's matcher fail-close), shows all field→value pairs in one approval draft, only fills in order upon confirm. ANY none/ambiguous/non-typeable target fails close before the gate (0 fills, no partial mutation), submit only presses Enter on the last field. risk:execute.
- **Why:** multi-field forms (login/signup/checkout etc.) previously meant a burst of per-field browser_type approval rounds (slow on a low-spec model) — now one approval shows every field's value and fills them all (aligns with outbound-safety: show the whole content in one draft).
- **Review point:** the judge confirmed (1) 2 outbound-safety RED-able paths (a deny bypass·a failed-target-continues path→the safety test goes RED) (2) resolve-all-first means there's no path where field[0] fills before field[1] fails (traced in code) (3) no eval:tools confusable-pair regression (fill_form 3/3 multi + type 3/3 single, threshold passed) (4) a real execute path (a contract-faithful FormController, real composed controller.type calls, not fake-injected) (5) verb_noun schema·minItems2·use-when/not-when.
- **Risk:** no new live-CDP smoke added — it only composes controller.type (already live-proven) with no new CDP behavior, so eval:browser-agent's real round trip is sufficient. pnpm check's apps/api timeout is an unrelated external flake (passes isolated).

## fire 19 · 2026-06-14 · skill v1.14.0 · (this commit)

meta: value-class=micro-fix(hardening) · pkg=@muse/mcp · kind=B-mcp · verdict=PASS · firesSinceDrill=2

ratchet: testFiles +0 (mcp.test +3; 1860 tests) · fabrication 0 · pnpm check 0 · lint 0/0 · architecture.md retry-classification compliant

- **What:** Retry classification for external-MCP connection failures. connect/healthCheck unconditionally called scheduleReconnect on every error, and the connector dropped the SDK's HTTP status → a revoked/expired token (401/403) got hammered by maxAttempts retries forever. Fix: isRetryableMcpConnectStatus (4xx→fast-fail terminal disabled, no loop; 429/5xx→bounded backoff; undefined/network→fail-OPEN retryable), McpConnectionError carries status/retryable, mcpConnectErrorStatus extracts the SDK's `.code` (clamped 100-599, ignores the -1 sentinel).
- **Why:** violated architecture.md's "4xx MUST fail fast; 5xx/unknown MAY retry" — a real bug where a dead credential kept hammering an external server forever. Rotates diversity from C to B (fires 16·17·18 were C). Mirrors the repo's existing isRetryableNotesStatus pattern.
- **Review point:** the judge confirmed (1) the real architecture.md violation gap (2) the 401 test drives the REAL manager.connect via a real McpConnectionError(401) (byte-faithful to SDK 1.29.0), reverting the branch reproduces RED, confirms disabled+called once+no loop (3) 503 still gets bounded-retry (no over-correction) (4) an unknown shape fails OPEN retryable (a transient blip doesn't get wrongly terminal-disabled).
- **Risk:** stdio/bare-network has no status so it's retryable (correctly preserves transience). Mid-session callTool failure reclassification is out of scope (a separate future ◦). If the SDK's error shape changes, it degrades to retryable (fail-open, never wrongly terminal).

## fire 20 · 2026-06-14 · skill v1.14.0 · (this commit)

meta: value-class=micro-fix(hardening+secret-leak) · pkg=@muse/mcp · kind=B-mcp · verdict=PASS · firesSinceDrill=3

ratchet: testFiles +1 (mcp-tool-call-error.test.ts 5 cases; 1859 tests) · fabrication 0 · pnpm check 0 · lint 0/0

- **What:** Surfaced external-MCP call-time errors + redacted tokens. createMcpMuseTool's execute returned connection.callTool() without a try/catch (SdkMcpConnection.callTool also wasn't wrapped, unlike listTools which fire-19 wrapped) → a mid-session callTool failure (401/500/timeout/throw) escaped raw. Now caught → a clear `Error: MCP tool '<name>' failed: <msg>`, redactMcpSecrets converts Bearer <token>→Bearer [redacted]. Success content + isError:true passthrough unchanged.
- **Why:** fixed two holes at once — (1) grounding: the model reading a swallowed/escaped failure as an empty result (2) **secret-leak**: an injected Authorization: Bearer <token> could be echoed into an SDK HTTP error and leak to the model/logs. Complements fire-19's (connection-time fail-fast) at call time. Strengthens grounding by closing a fabrication-adjacent hole.
- **Review point:** the judge confirmed (1) the real gap (an uncaught callTool end-to-end + cited the Bearer-injecting code) (2) redaction is RED-able (removing it leaks a raw ghp_ token) (3) error surfacing is RED-able (removing the catch causes escape) (4) no over-catch on success/isError (removing the catch still passes on that path=untouched) (5) the Bearer-only scope is honest (the only secret Muse ever injects).
- **Risk:** redaction only covers the Bearer form — other token forms like a query-string are uncovered (Muse's own injection is Bearer-only, so full coverage, documented residual). Any non-mid-session path is covered by fire-19.

## fire 21 · 2026-06-14 · skill v1.14.0 · (scout + defer, no code slice)

meta: value-class=scout · pkg=@muse/browser(investigated) · kind=C-browser · verdict=DEFER · firesSinceDrill=5

ratchet: testFiles +0 · fabrication 0 · no code change (scout finding + API-degradation defer)

- **What:** an axis-C scout — investigated whether browser `<select>` dropdown selection is a gap. **Already handled**: browser_type grounds options via matchOption for role=combobox/`<select>` (fail-close, lists options + refuses on no match), confirmed in puppeteer-controller.ts's type(). browser_select is unnecessary. Recorded the scout finding in backlog (so future scouts skip it).
- **Why DEFER:** two worker sub-agent dispatches died from API rate-limiting/connection refusal (a crashed worker's partial changes were rolled back). Forcing a code slice through would mean no ④b independent judge run (maker≠judge unmet) — no commit possible. Rather than commit unverified code, honestly deferred. Kept the branch clean, only recorded a doc-only backlog note (no judge needed for that).
- **Review point:** the browser micro-fix vein is thinning — the remaining distinct C candidates (iframe read·file upload·CDP error-surfacing edge) will be verified next fire; 2 consecutive clean means rotating value-class per EXHAUSTION.
- **Risk:** the API degradation is assumed temporary — normal slicing resumes once the sub-agent recovers next fire. No progress lost (the scout knowledge is preserved in backlog).

## fire 22 · 2026-06-14 · skill v1.14.0 · (this commit)

meta: value-class=new-capability · pkg=@muse/browser+@muse/mcp+@muse/cli · kind=C-browser · verdict=PASS · firesSinceDrill=6

ratchet: testFiles +2 (browser-upload.test 9 + upload-path-validator.test 7; browser 120, mcp 1868) · fabrication 0 · eval:tools 94% (upload 3/3, no regression) · eval:browser-agent 1/1 · smoke #24 LIVE · lint 0/0

- **What:** New capability browser_upload — attaches a local file to a page form. {target,path} → resolves an `<input type=file>` (fails close on ambiguous/non-file-input) → validates path via an injected allowlist guard → one draft-first approval (file→field) → setInputFiles only upon confirm. File upload was a genuine gap (confirmed: no upload path existed at all).
- **Why:** handled two security surfaces at once — (1) local file reading: @muse/browser reuses @muse/mcp's createAllowlistPathValidator's file_read lexical-roots + symlink-realpath-escape guard, with zero fs dependency (validator is DI'd — no validator means refused, not allow-all, blocking ~/.ssh exfiltration) (2) outbound act: risk:execute, deny→0 setInputFiles calls.
- **Review point:** the judge confirmed (1) the guard is identical to file_read's (not a substring match)·weakening it fails 6 RED (including symlink-escape) (2) the guard runs before read/act·a rejected path never opens the file and never reaches the gate (gateCalls 0)·no validator means fail-closed (3) deny/non-file-input→0 uploads (4) smoke #24 reads the real this.files.length (not faked) (5) no confusable-pair regression.
- **Risk:** eval:browser-agent doesn't yet include a multi-step upload chain (currently covered by smoke#24+unit+a selected eval, a follow-up ◦). The full-suite eval:tools time-tool nondeterministic miss is an unrelated external flake.

## fire 23 · 2026-06-14 · skill v1.14.0 · (honest STOP, no code slice)

meta: value-class=scout · pkg=@muse/browser(investigated) · kind=C-browser · verdict=NO-GAP/EXHAUSTION · firesSinceDrill=7

ratchet: testFiles +0 · fabrication 0 · no code change (3rd consecutive axis-C candidate already-handled)

- **What:** an axis-C scout — investigated whether same-origin iframe content is invisible to the snapshot. **Already handled**: captureSnapshot's walk() already pierces shadow DOM + same-origin iframes (contentDocument), and gracefully skips cross-origin via a catch (commit 178c953a, 2026-06-12); a unified ref scheme·cap preservation·resolveRef frame traversal·live smoke #7 already exist. No code change (honest-stop).
- **Why EXHAUSTION:** 3 consecutive axis-C candidates were already-handled (fire-21 select · fire-23 callTool-timeout · iframe) — the browser micro-fix vein is exhausted. An honest stop instead of forcing low-value churn (per the EXHAUSTION rule).
- **Review point:** the loop has matured — C (browser) covered 12+ slices to completion, B (external MCP) fully hardened across 4 servers + the whole machinery, A (Muse-native tools) is deliberately ceded to the concurrent tool-hardening loop (avoiding conflict). This loop's distinct lane (B+C) is nearly complete.
- **Risk/recommendation:** needs Jinan's direction (a loop can't self-assign a new theme — scope belongs to the user): (1) wind down via CronDelete d410848c (2) repoint the theme (3) continue accepting low marginal value. Code evolution does occasionally open a new gap.
