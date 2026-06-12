# Muse dev backlog — the living ledger

> The ONE compounding artifact the dev loop reads FIRST. Resurrected after the
> docs reset deleted it (which forced every session to re-discover "what to build"
> with expensive scout subagents and throw the answer away). The `improve-muse`
> skill picks the top OPEN item here when `self-eval` is green; every fire appends
> the chosen slice + the candidates it rejected + the source, so a direction is
> researched ONCE, not re-paid each session. Keep it pruned: move shipped items to
> DONE, drop dead ones. This file is the antidote to the treadmill.
>
> Priority: ★ = do next · ◦ = ready · ⏳ = blocked (reason noted).
> Each item: **what** — why (source) — the smallest verifiable slice.

## Done — loop infrastructure (2026-06-12, 진안-directed)

- ✓→Done **loop-engineering contract + loop-creator skill** — distilled Addy
  Osmani's "Loop Engineering" into `harness/loop-engineering.md` (6 primitives →
  Muse seams · verifiable stopping condition `/goal` · 3 failure-mode guards:
  unattended-verification / comprehension-debt / cognitive-surrender) and a
  generative `.claude/skills/loop-creator/SKILL.md` that fills the checklist,
  generates a principle-compliant recurring loop prompt, and registers the cron
  itself (delegating scheduling to `/loop`). Replaces hand-written ad-hoc loop
  prompts. FOLLOW-UP: pre-verify the skill end-to-end (theme → generated prompt →
  registered cron → reported stop method) on a real theme before relying on it.

## ★ Open — chat-gate toolGrounded blanket bypass (PAUSED mid-design, 2026-06-12)

- ◦ **toolGrounded blanket bypass** — chat gate skipped on ANY tool call even
  when the tool returned nothing; narrow to non-empty groundingSources, keep
  number/email checks always-on. Spec (brainstorm + grill-hardened) at
  `docs/superpowers/specs/2026-06-12-chat-gate-toolgrounded-bypass-design.md`:
  surfaces tool grounding on the `tool-result` stream event (additive, shared
  helper) so BOTH chat-repl (run() result) and chat-ink (stream) are gated on
  one contract. Resume at writing-plans → TDD. (audit CLI #4)

## ★ Open — TOOL expansion & hardening (loop theme, 진안-directed 2026-06-12)

The loop's standing focus: EXPAND Muse's own tool surface + HARDEN the existing tools.
Every slice ships its eval/test and never weakens the grounding floor. Ranked:

EXPAND (new reach):
- ✓→Done **browser_look — describe the current browser page visually (local vision)** — browser_read
  returns DOM text + elements, so a VISUAL page (chart, graph, map, diagram, image, a rendered error
  dialog) was invisible to the model. New browser_look captures the page (controller.screenshotBase64,
  added to the BrowserController interface) and describes it with the local vision model (injected
  describeImage; the CLI binds it via the same screenVision holder as mac_screen_read — omitted when no
  model). Completes "vision everywhere": screen (mac_screen_read) · local image (file_read) · image URL
  (web_read) · browser page (browser_look). Sharpened browser_read with a not-when line (visual content
  → browser_look) so the model doesn't default to text-read. TDD 4 (well-formed, capture+describe+mime,
  question passthrough, vision-error); eval:tools browser scenario 9/9 STABLE 3/3 (browser_look vs
  browser_read on chart/graph prompts); eval:browser-agent 1/1 (act-path untouched); LIVE — a real
  Chrome page captured and described via gemma4, no error. browser 41, full eval:tools 138/139 (1
  known synthetic flake), check 0, lint 0.
- ✓→Done **web_read describes IMAGE URLs via local vision** — web_read read HTML and PDF URLs but
  rejected image content-types ("not a readable text page"), even though file_read reads LOCAL images
  via vision. Now an image/* response is read as bytes (10MB cap) and described by an injected
  describeImage callback (autoconfigure binds it from the assembly's gemma4 in buildLoopbackTools —
  @muse/mcp stays model-free); absent model ⇒ refused as before. HTML/PDF paths unchanged. Completes
  the symmetry: file_read (local text/pdf/docx/image) ↔ web_read (URL html/pdf/image). TDD 3 (image
  via injected vision + mime, refuse-without-vision, HTML still text); an existing non-readable test
  moved to application/zip so it still exercises that path; LIVE — a real image URL routed through
  web_read's vision path returned a description (no error). mcp 1648 + autoconfigure 505, check 0,
  lint 0, precheck:grounding pass^2.
- ✓→Done **file_read reads IMAGE files via local vision** — file_read classified .png/.jpg/etc. as
  "unsupported" even though Muse has local vision (describeImage, already used by mac_screen_read). Now
  an image FileKind (extension + magic-byte sniff: PNG/JPEG/GIF/WEBP) routes the bytes to an injected
  describeImage callback (the CLI binds it to the assembly's gemma4 via the same lazy holder as
  mac_screen_read; @muse/mcp stays model-free); absent callback ⇒ refused as before. imageMimeType
  derives the MIME from extension then magic. Magic-detected images win over a misleading extension.
  TDD 5 (classify/sniff/route-via-vision/refuse-without-vision/vision-error); eval:file-read image
  round-trip (routed + mime + refuse-without-vision); LIVE — a real Chrome-rendered receipt PNG read
  by gemma4 returned "CAFE MUSE / Latte x2 9,000 / Total 9,000 KRW". file_read is now read-any-file
  (text/pdf/docx/image). mcp 1645, full eval:tools 137/137, check 0, lint 0.
- ✓→Done **web_read reads PDF URLs (not just HTML)** — `isReadableContentType` rejected
  application/pdf, so "summarize this report.pdf link" failed with "not a readable text page". Now a
  PDF content-type response is read as bytes (10MB cap) and extracted via the same pdfjs already used
  by file_read (injectable `extractPdfText`, default lazy pdfjs); HTML still routes through the text
  extractor. One-step "summarize this PDF link" instead of download-then-read. TDD 2 (PDF via injected
  extractor, HTML still uses text path); LIVE — a real Chrome-generated PDF fetched through web_read's
  pdfjs path returns the body text. mcp 1640, check 0, lint 0.
- ✓→Done **web search wired into the default agent (muse.search)** — `muse.search` (web search, zero-config
  DuckDuckGo fallback, SearXNG when MUSE_SEARXNG_URL is set) existed + was tested but was ONLY reachable
  behind the opt-in MUSE_LOOPBACK_MCP_ENABLED flag, so by default the agent could not answer fresh-web
  questions. Added it to the always-on buildLoopbackTools bundle (MUSE_SEARCH_ENABLED opt-out), gave the
  tool KO+EN keywords + use-when/not-when + an example schema (it had none, so it ranked 0 under the diet
  cap). TDD 3 (bundle present / default-on / opt-out) + eval:tools web-search scenario 4/4 STABLE 3/3
  (muse.search vs knowledge_search vs web_read); LIVE: `muse ask --with-tools` searched the web and
  answered with puppeteer 25.1.0. autoconfigure 505, full eval:tools 135/135, check 0, lint 0.
- ✓→Done **browser: uncapped deterministic matching, capped display** — scan/match cap raised
  50→150 (BROWSER_MAX_ELEMENTS), model-facing display capped at 40 (BROWSER_DISPLAY_ELEMENTS) with a
  truncated/shownElements/totalElements + "showing N of M" hint (no silent caps). click/type/find
  resolve against the FULL set (matcher is code), so a target past #40 still acts. TDD 3 cases
  (display cap + true total + match-beyond-cap + small-page-not-truncated); smoke:browser long-page
  case (71st element reachable past the 40 display cap); eval:tools browser 7/7 ×3, eval:browser-agent
  3/3, check 0, lint 0.
- ✓→Done **browser: same-origin iframe piercing (observe + act)** — the snapshot walk now descends
  into same-origin iframe contentDocuments (like shadow roots; cross-origin throws → skipped), so
  embedded forms/checkout/widgets are visible. The act path went frame-aware: `locateRef` finds the
  puppeteer Frame holding a ref (main doc incl. shadow via pierce/, else a child frame) and
  click/type use `frame.locator` — so a click/type on an element INSIDE an iframe acts in its own
  frame, not the main one. smoke:browser gains a same-origin srcdoc-iframe case (button listed +
  clicked inside the frame, text flips Paid); eval:browser-agent 3/3 (act-path refactor no
  regression); browser unit 37, check 0, lint 0. Cross-origin iframes stay out (CDP needs per-frame
  contexts — honest scope).
- ✓→Done **file_read: .docx (Word) extraction** — `docx` FileKind + lazy mammoth (extractRawText,
  injectable like extractPdfText); routes by extension since a .docx is a zip (sniffs unsupported).
  Description gains the Word cue. TDD 4 cases (classify/resolve/route/description); eval:file-read
  generates a REAL .docx at runtime (self-contained minimal-zip writer via node:zlib crc32/deflate —
  no committed binary) → mammoth extracts → tool round-trip; eval:tools file scenario 6/6 STABLE 3/3
  (KO '계약서 워드 파일' → file_read), full 131/131; check 0, lint 0. Follow-up: .xlsx — see the ⏳ dep-decision blocker in HARDEN.
- ✓→Done **web_download — save a file from a URL to Downloads** — chose the URL-based design over
  browser-element download (no controller interface change, no live Chrome, fully deterministic
  verification). New `web_download` tool: SSRF-guarded (loopback/internal refused via the shared
  assertPublicHttpUrl), 50MB size cap, basename-only filename (`safeDownloadName` — no path escape).
  The write-side companion to file_read; file_read then reads/summarizes what was saved. Wired
  default-on under --with-tools next to file_read. TDD 9 (safeDownloadName 3 + tool 6: well-formed,
  download+write, SSRF refuse, non-http refuse, size cap no-write, filename sanitize); eval:tools
  web scenario 6/6 STABLE 3/3 (web_download vs web_read vs search vs knowledge_search); LIVE — a real
  http server's file fetched and written to disk with matching bytes. mcp 1638, full eval:tools
  137/137, check 0, lint 0.
- ◦ **mac: read Calendar.app / Notes.app / Reminders.app** — osascript readers in the mac family,
  read-risk, so "what's on my calendar today" works without a configured provider.

HARDEN (make existing tools more reliable):
- ✓→Done **regex_extract ReDoS guard** — the tool ran a model/untrusted-supplied regex with no
  backtracking protection; a nested-quantifier pattern like `(a+)+$` against just 50 chars hung the
  whole agent for ~90s (measured by the RED test). JS regex can't be timed out on the main thread,
  so added `hasNestedUnboundedQuantifier` (the safe-regex star-height heuristic, escape-aware proper
  paren matching) and reject the pattern BEFORE compile. Catches the common catastrophic class
  ((a+)+, (.*)*, ([a-z]+){2,}); overlapping-alternation ReDoS ((a|ab)+) is out of scope (still
  bounded by the 100k input cap) — documented honestly. TDD 5 (flags nested shapes, accepts ordinary
  patterns the model writes, escaped parens, tool rejects-not-hangs, normal extract still works);
  tools 242, byte-hygiene 30, check 0, lint 0.
- ✓→Done **muse.search snippet length cap** — result snippets were sanitized but not LENGTH-bounded, so a
  SearXNG/DDG engine returning a full paragraph × up to 10 rows blew the local 8B's context. Added a 280-char
  word-boundary cap (`capSnippet`) on both the DDG and SearXNG paths; titles/urls untouched. A search result is
  for TRIAGE (pick a URL to read), not the full text. TDD 1 (long snippet capped, short snippet + title intact);
  mcp 1629, byte-hygiene 30, check 0, lint 0.
- ✓→Done **web_read readability — strip nav/footer boilerplate** — extractReadableText dropped
  script/style/head but kept <nav> menus and <footer> (copyright/link farms), so a "summarize this
  URL" answer grounded on site chrome, not the article. Added nav|footer to the element-strip regex
  (HTML5 boilerplate by definition). TDD 1 (nav+footer dropped, article kept); live on a realistic
  article shape (nested footer>nav handled) — only the article body survives. mcp 1628, byte-hygiene
  30, check 0, lint 0.
- ✓→Done **browser_open scheme guard (no local-file read via file://)** — browser_open passed any
  URL straight to page.goto, so `file:///etc/passwd` (or chrome://, view-source:, javascript:, data:)
  would load+return arbitrary local files — a broader local read than file_read's allowlisted,
  symlink-guarded path, and a prompt-injection exfil vector. Now `normalizeBrowserUrl` accepts only
  http(s) (bare host → https; host:port preserved) and refuses every other scheme. TDD 4 cases;
  eval:browser-agent migrated to a loopback http server (was file://) and still 3/3; smoke unaffected
  (uses the controller directly). mcp/browser 37, check 0, lint 0.
- ✓→Done **command_injection pattern over-fired on legit loopback URLs** — dropped the bare `http`
  trigger so the pattern requires a command VERB (curl|wget|fetch) near an internal host. "open
  http://localhost:3000 in the browser" / "내 dev 서버 http://127.0.0.1:8080 열어줘" no longer trip the
  input guard (it was blocking the whole turn); curl/wget/fetch-toward-internal still fire. TDD 3
  false-positive + 3 true-positive cases; eval:browser-agent reverted off the [::1] workaround back
  to 127.0.0.1 and still 3/3 (proves the guard fix end-to-end); policy 129, byte-hygiene 30, check 0,
  lint 0, precheck:grounding pass^2.
- ✓→Done **file_read symlink-escape guard** — the absolute-path check was LEXICAL only: a file
  lexically inside the roots could be a symlink to /etc/passwd, and readFile followed it. Now
  realpath-verifies the target (and the roots — /tmp is itself a symlink on macOS) before reading;
  a link resolving outside the roots is refused, a realpath error refuses. Optional fsImpl.realpath
  (default node realpath; a fake fs with no symlinks is a no-op so existing tests are unchanged).
  TDD 3 cases (candidate-link escape, absolute-path-link escape, identity still reads) + eval:file-read
  REAL symlink round-trip (a link under Downloads → outside is refused, target content not returned);
  mcp 1627, check 0, lint 0.
- ⏳ **file_read .xlsx — BLOCKED on a dep decision (needs 진안)** — the maintained npm xlsx reader
  is exceljs (~21MB unpacked) and SheetJS `xlsx` on npm is the old CVE-flagged build. A 21MB dep or a
  fragile hand-rolled OOXML parser is too much to adopt autonomously; surface the choice. (.docx
  shipped via mammoth ~2MB, which was proportionate.)
- ◦ **per-tool not-when audit** — every built-in tool description gets a "use when … ; NOT when …"
  line; measure eager-invocation drop on eval:tools negative cases.
- ◦ **tool-arg grounding coverage** — extend `groundedArgs` (the deterministic anti-fabrication
  boundary) to every actuator that persists a model-named field; one eval:tool-arg-grounding case each.
- ✓→Done **content-sniff over extension** — file_read now classifies by CONTENT
  (`sniffFileKind`/`resolveFileKind`): `%PDF` magic always wins (a mislabeled `.txt`-that-is-a-PDF
  routes to the extractor), an extensionless download with text bytes reads (extension-only refused
  it), a NUL/binary blob is still refused. Extension stays the fast path; the sniff is the
  correction. Also fixed classifyFileKind's no-dot bug (`split('.').pop()` returned the whole name).
  TDD 10 cases (sniff + resolve + 2 tool integration); eval:file-read gains the no-ext + mislabeled
  real-file round-trips; mcp 1616, check 0, lint 0.
- ✓→Done **web_action URL vetting (SSRF guard)** — the existing assertPublicHttpUrl guard protected
  muse.web.read (READ) but NOT web_action (state-changing SUBMIT — the higher-risk tool was the
  unguarded path). Wired it in BEFORE the approval gate/any HTTP. Split the guard into a sync half
  (assertPublicHttpUrlSync: protocol + literal loopback/private/link-local IP + blocked host — always
  on, no DNS) and the async DNS-rebinding layer (opt-in via deps.lookup), so literal SSRF
  (127.0.0.1, 169.254.169.254 metadata, file://) is always blocked and the happy path needs no
  resolver. TDD 4 SSRF cases + injected-private-resolver (DNS-rebinding); web_action selection
  unaffected (eval:tools actuator scenario), mcp 1620, check 0, lint 0, precheck:grounding pass^2.

## Open — 2026-06-10 full-feature audit (3 reviewers; VERIFIED findings → fix queue)

FIXED already: actuator non-TTY fail-close (d7112db9) · hybrid-MMR scale bug · write-run cache
replay (this commit). Remaining, severity order:

- ✓→Done **Ink chat output gate** — finalizeGatedChatAnswer (the ONE shared post-stream pipeline:
  gate→reverify→citation strips→receipt) now runs on the Ink surface AND chat-repl was refactored
  onto it so the surfaces cannot drift again; groundingFor returns matches; render test pins that
  a fabricated answer is gated before display AND before history commit. (CLI audit #1, HIGH)
- ✓→Done **calendar↔reminder lifecycle link on EVERY surface** — helpers moved to
  @muse/mcp (event-reminder-link.ts), wired into the MCP update/delete executors (results carry
  remindersShifted/remindersRemoved) AND the API DELETE route; CLI re-exports. BONUS: a fired
  reminder rescheduled into the future resets to pending (audit CLI #3) while a still-past shift
  never instant-re-fires. 5/5 incl. loopback integration + no-partial-side-effect. (both audits, HIGH)
- ✓→Done (reminders) **Reminders store unserialized RMW → serialized via mutateReminders** — the
  daemon firing loop read the reminders once then wrote its in-memory copy per delivery, CLOBBERING a
  reminder a chat `add` wrote after the tick started (the reported daemon-vs-chat lost write). Added
  `mutateReminders(file, fn)` = read→fn→write under the cross-process `withFileLock`; converted EVERY
  RMW site (add, snooze, fire, delete in loopback-reminders + the firing loop's per-delivery write,
  which now re-reads current and marks fired by id, merging with concurrent adds). TDD 3 (two
  concurrent adds both persist, mutate returns+persists, serial sequence keeps all); mcp 1651, check
  0, lint 0. FOLLOW-UP: the TASKS store has the same shape — apply mutateTasks next.
- ✓→Done (tasks) **Tasks store unserialized RMW → serialized via mutateTasks** — same fix as
  reminders: `mutateTasks(file, fn)` = read→fn→write under the cross-process `withFileLock`;
  converted EVERY RMW site (add/complete/update/delete in loopback-tasks). mutate-tasks.test.ts
  proves two concurrent adds both persist (lost-update gone). mcp build + 1654 tests green, lint 0.
  (stores audit #2, tasks half — completes the reminders FOLLOW-UP)
- ◦ **Calendar store + credential store: corrupt file → silent full wipe** — adopt the sibling
  stores' quarantine-on-corrupt posture + atomic writes. (stores audit #3)
- ◦ **toolGrounded blanket bypass** — chat gate skipped on ANY tool call even when the tool returned
  nothing; narrow to non-empty groundingSources, keep number/email checks always-on. (CLI audit #4)
- ◦ **Chat-only users never get the embedder migration** — refreshStaleNotesIndexForChat doesn't
  treat legacy-model as stale → v2-moe queries ranked against v1 vectors (cross-model cosine noise
  above the 0.5 authoritative floor). Treat model mismatch as stale. (CLI audit #5)
- ◦ **ask error paths skip the run-log trace** (failed runs are exactly the error-analysis fuel) +
  Ctrl-C still runs the verdict pipeline and logs success:true. try/finally + success:false entries.
  (CLI audit #6/#7)
- ◦ smaller: correction-polarity regex unanchored ("NOT CONTRADICT"→contradict decay) ·
  enforceAnswerCitations whitespace rewrite on clean answers (breaks code-block quotes) ·
  casual-prompt 말해줘 over-match suppresses source blocks · dedup memoizes write results ·
  groundToolArguments partial-array reported as dropped · consented-action header override ·
  web_action URL vetting · encryption coverage (calendar credentials!). (audit LOW/MED tail)

## Open — refilled 2026-06-09 (gap-finding scout, clean autonomous slices)

## Open — frontier research pass 2026-06-10 (3 fresh tracks; full table → docs/strategy/frontier-research-2026-06.md)

KEY UNLOCK (first-hand verified): Ollama 0.30.6 native API exposes `logprobs`/`top_logprobs`
for gemma4 — token-level confidence is no longer blocked (`<|channel>` marker tokens must be
excluded when scoring).

- ✓→Done **F1 logprob instrumentation** (shipped, independent-evaluator PASS — see Done).
- ✓→measured **F2 BM25 promotion: NO DELTA** — bm25Scores + RRF already existed
  (knowledge-recall.ts, env `MUSE_RECALL_BM25`); A/B on the embedder-ab corpus AND a targeted
  exact-string identifier probe (ERR codes, license key, IP, model tag) both saturate 100%
  with bm25 on OR off — the default lexical-overlap arm already handles identifier tokens.
  Default stays off (no unverified win); revisit only if real-trace misses provide
  discriminating cases. Contextual chunk annotation (Anthropic slice 2) remains a candidate.
- ✓→Done **F3 KnowNo conformal tool selection (offline)** — `pnpm eval:conformal-tools`:
  MCQA top_logprobs + leave-one-out conformal at α=0.1 over the 14-case time family →
  coverage 13/14 (92.9% ≥ 90% target), wrong-but-confident 0, unnecessary clarifies 0
  (docs/benchmarks/RESULTS-conformal-tools.md). Runtime wiring (set>1 ⇒ clarify-directive)
  is the follow-up once a larger calibration set exists.
- ◦ **ACT-R base-level activation for recall ranking** — frequency×spacing activation over the
  existing access logs replaces the single recency half-life; positive+negative unit battery. (T2-1)
- ◦ **ACE deterministic playbook delta-merge** — replace the LLM-rewrite merge with itemized
  deterministic deltas + an anti-collapse invariant test (+10.6% AppWorld for the pattern). (T1-1)
- ◦ **Reflection-schedule guard** — one test enumerating retry/reflection call-sites, asserting
  each is verifier-backed (85.36% same-mistake repetition without one, arXiv 2510.18254). (T1-10)
- (queued behind fuel/prereqs: sleep-time compute · Mem0 UPDATE op · AWM workflow mining ·
  conformal factuality back-off · Bayesian-surprise digest ranking (SDT half SHIPPED — see Done))
- ✗ blocked, recorded: SEPs / DoLa / contrastive decoding (need hidden states / decode-time
  intervention; Ollama logprobs are observational only).

## Open — agent-performance levers (ranked research pass 2026-06-10)

Full ranked list + sources: [`docs/strategy/agent-performance-levers.md`](../strategy/agent-performance-levers.md).
Levers #1 (multilingual embedder, SHIPPED — KO hit@1 50%→100%), #3 (KV posture + prefix
ordering, SHIPPED) and #2's mechanism+measurement are in Done below. Next from the list:

- ◦ **Tool-exemplar production wiring — gated on real-trace failures** — the mechanism
  (`selectToolExemplars`/`renderToolExemplarSection`) + the eval:tools A/B arm shipped; the
  golden set is near-saturated, so the lift must be demonstrated on REAL failing prompts.
  When labeled traces accumulate misses, extract an exemplar bank from successful traces and
  wire injection into the runtime tool path; promote on a measured eval:tools + replay win.
- ◦ **Local reranker on recall top-8** (lever #4) — Ollama has no rerank API; yes/no-logit
  workaround, flag-gated, A/B on the embedder-ab corpus + grounding battery.
- ◦ **`format` constraint on the non-reverify judge paths** — reverify judge DONE (see Done);
  remaining: llmJudge (eval-harness), correction-polarity, preference-inference.
- ◦ **source-trust live battery** — the marker + trusted bit shipped (see Done); remaining: a
  live `--with-tools` battery asserting the external-provenance heading appears on a
  web-grounded answer and NOT on a notes-grounded one.
- ✗ rejected this refill: "expose `muse notes graph/links`" (ALREADY exist — the -rag split
  trap again); "desktop lazy index load" (FALSIFIED — no startup parse); "REPL query-embedding
  cache" (near-zero hit rate; the real latency lever was prefix reuse, now shipped).

## Open — grounding edge (the maintained floor → frontier)

- ◦ **(follow-up) SQuAD drift arm — STABILIZE before optimizing** — a fire (2026-06-09)
  TRIED the obvious sharpen (pick drift answers with NO lexical overlap so coverage fully
  fails) and it made Δ WORSE: +0.63 → +0.13 (gate-ON catch 5/8 → 1/8). Reverted. The real
  finding: the SQuAD drift catch is HIGH-VARIANCE — the gate-ON path runs verifyGroundingWithReverify
  (a stochastic gemma reverify), so a single-run Δ on 8 cases is not stable, and the lexical-coverage
  hypothesis does not dominate the catch. So the right next step is STABILITY first: run the SQuAD
  arm at MUSE_EVAL_REPEAT≥3 (pass^k) and/or grow to 20-30 cases to get a stable number, THEN optimize.
  (Rejected: the disjoint-drift sharpen, as an unverified — in fact negative — win.)
- ⏳→✓ **Source-trust segregation — DECIDED 2026-06-10 (option B, per the standing
  decide-and-do directive) and the core shipped** (see Done): tool-derived citations live on the
  VerifiedSource/response-filters path, so the provenance marker went THERE (the sources block
  heading now names itself external/tool-fetched), plus `trusted:false` on the ask path's tool
  evidence so `groundedOnUntrustedOnly` has real input. Remaining: the live battery (Open above).
  Original framing kept below for context:
  `KnowledgeMatch.trusted` provenance bit + the pure detector `groundedOnUntrustedOnly` (flags a
  grounded answer resting ONLY on untrusted sources), agent-core, 4 tests. REMAINING — RE-SCOPED
  2026-06-09 (a fire found the naive wiring target wrong): tool-output does NOT become a
  `KnowledgeMatch` — it produces `VerifiedSource` (tool-output-evidence.ts) consumed by the
  response-filters path, SEPARATE from the grounding evidence set (`KnowledgeMatch` today comes only
  from the user's own notes, i.e. always trusted). So `groundedOnUntrustedOnly` has no untrusted input
  in the CURRENT graph — it is a forward-looking guard. Correct sub-slices: (1) DECIDE the design —
  merge tool-output INTO the grounding set with `trusted:false` (architectural), OR mark trust on the
  VerifiedSource/response-filters path where tool-derived citations actually live; (2) surface a marker
  when a cited claim rests only on untrusted provenance; (3) a live battery. Start with (1)'s decision.
  Below is the original framing (kept for context):
  NAMED (see Done: grounded-not-true.test.ts locks that a false-but-source-supported answer
  is "grounded", while a fabricated citation is still caught). The user's OWN false note is
  unfixable by design ("it's yours"), but an UNTRUSTED source (hostile/allowlisted MCP
  tool-output, per architecture.md) being treated as ground-truth IS fixable. Slice: tag
  evidence provenance (user-note vs tool-output) through the recall→gate path and surface a
  distinct verdict/marker when a grounded answer rests ONLY on untrusted tool-output, so the
  user knows the citation is not their own data. Source-veracity is impossible on a fixed 12B;
  source-TRUST segregation is not. (tool-output-evidence.ts already treats tool output as
  untrusted — thread that signal into verifyGrounding's evidence set.)
- ◦ **(follow-up) measure --best-of's answered-rate lift on a drift-prone corpus** —
  the mechanism shipped (see Done 2026-06-10) but its LIVE adoption path never fired in 3
  adversarial attempts (gemma4 + the gate are robust enough that a natural first-draft
  verdict failure is rare on a clean corpus — itself a positive finding). When labeled
  `ungrounded` traces accumulate from real usage, replay those queries with --best-of 3
  and report the adoption rate; promote the flag to default-on only with that number.

## Open — dev-loop fuel & measurement (makes the loop compound)

- ◦ **(follow-up) outcome labels for the remaining cli.local surfaces** — `muse ask` now
  labels every trace (see Done 2026-06-10); still `grounded:null`: ask `--json` mode and
  `--image` (the verdict doesn't run there by design), and `muse chat --local` (the chat
  gate is the sync NUMBER-only check, a different verdict shape). Label chat-local when
  the error-analysis fuel from ask proves insufficient — don't build ahead of need.
- ⏳ **`error-analysis.mjs` — cluster `.muse/runs` failures into a ranked taxonomy**
  — the missing ANALYZE half. BLOCKED on the instrumentation above (no labels = no
  Pareto; clustering a passing-looking corpus with the same 8B is maker=judge theater).
  Defer until ~20-30 real labeled failures exist. Source: eval-driven-dev research
  (Husain/Yan; Google "every user report → permanent test case").
- ◦ **Split the eval scoreboard into TRAJECTORY vs FINAL-RESPONSE axes** (Google ADK:
  EXACT/IN_ORDER/ANY_ORDER match modes + separate final-response score) so a regression
  localizes to path-vs-answer. Pure refactor of `scripts/eval-harness.mjs`.
- ◦ **`hallucinations_v1`-style per-sentence groundedness** — finer than the answer-level
  gate: label each sentence supported/unsupported/contradictory so eval:self-improving
  reports WHICH sentence was un-groundable. Source: Google ADK eval criteria.

## Open — dev-loop hardening (from the 2026-06-08 will-it-work review)

- ◦ **Extend `groundedCases` to ALL battery corpora** — the `groundedCases` ratchet
  SHIPPED for the grounding corpus (see Done: a dropped case there now fails self-eval).
  Remaining: extend the count to the other golden sets (eval:tools, adversarial, plan-quality)
  whose cases live in their own files, so a dropped case in ANY battery regresses. Source: must-fix #3.
- ◦ **Backlog refill is the autonomy ceiling** — write-back records the provenance of
  the consumed item but does NOT mint net-new actionable work, so autonomy lasts ~the
  seed length (~7 fires) then degrades to gap-scout. The durable refill is error-analysis,
  which is BLOCKED on trace outcome-logging (the fuel accrues from Jinan USING Muse, not
  from dev fires). Not a single slice — a standing truth: when ★ OPEN runs low, a refill
  fire (gap-scout or a human direction) is itself the work. Source: review honest-ceiling.

## Open — agent core

## Blocked / deferred

- ⏳ **Grammar-constrained tool-call decoding** — INFEASIBLE on Ollama today: `format`
  (schema→grammar) and `tools` are NOT composable (Ollama #6002). Revisit when #6002
  lands or accept an inference-stack change. Existing `groundToolArguments` already
  covers the fabricated-value class.

## Rejected directions (do NOT re-derive these)

- ✗ **Chase general agentic leaderboards (SWE-bench Verified / τ²-bench / BFCL) as the
  "best" claim.** A fixed ~12B local model loses by construction (best open-weight
  SWE-bench ~80% on 200B+ MoE; BFCL 8-14B ~66% vs ~88% frontier). Own the architectural
  grounding-DELTA niche instead — the one claim a bigger model can't beat by swapping in.
  (2026-06-08 review, 3 adversarial critics concurred.)
- ✗ **Build the error-analysis analyzer before instrumenting outcome-logging.** No fuel
  (labels) exists yet; building the pipeline first is infrastructure for a flywheel with
  no gas. Instrument first (above), analyze later.

## Open — browser control (low-spec model drives Chrome; track started 2026-06-11)

- ✓→Done **ask --with-tools tool-set diet** — maxTools 10 default (MUSE_ASK_MAX_TOOLS, 0/off
  uncaps); relevance-sorted top-N. MEASURED side win: browse turn 93s → 42s (smaller tool
  schemas = less prompt eval). Found+fixed en route: 1-char CJK keyword containment ("비" ranked
  weather on 비밀번호 prompts → exact-only) and weather's calendar words (내일/주말) outranking
  reminders.add. Probes: browse→browser_open, recall→grounded cite, reminder plan→reminders.add
  first; eval:tools 125/125. Follow-up below.
- ✓→Done **muse.* loopback keywords** — recall family keyworded (notes×6, tasks.search,
  reminders.search/history, episode.search; calendar/tasks-CRUD/reminders-CRUD already had them
  in a different def position — the audit's "no keywords" claim was PARTIALLY wrong). Plan probes:
  노트→muse.notes.search 1st, 지난번 대화→episode.search 1st, 할일 검색→tasks.search 1st.
  Still bare (low-traffic tail, fine): context/messaging/followup/pattern/status/skills.
- ◦ **ask latency on the browser path** — ~90s/turn measured (10K-token prompt eval ≈ 40s × 2
  rounds on gemma4). Levers: prompt diet under --with-tools (skip notes blocks on clear
  browse intent?), KV prefix reuse across rounds, smaller tool list (above).
- ✓→Done **injection-pattern cross-span tightening** — the EN role_override family + 2 KO
  role_override + 1 KO extraction regexes used unbounded `.*`/`/s`, so three unrelated words from
  DIFFERENT sentences combined into a false hit (live repro: "disregard the noise … finally …
  assembly instructions" → role_override, with `all` matching the substring inside "fin**all**y").
  Bounded the inter-token spans to `.{0,50}` (EN) / `.{0,30}` (KO, denser script) and word-boundary-
  anchored `all`. TDD: 3 cross-span false-positive cases (EN + KO) + a true-positive-preserved case;
  all 127 policy tests green incl. the multilingual battery (true positives intact), agent-core
  guards 1622, byte-hygiene 30, precheck:grounding pass^2. Real injections keep trigger→target→noun
  within a clause, so detection is unchanged; only the cross-sentence false combinations are killed.

- ✓→Done **same-origin iframe piercing** — the snapshot walk descends into same-origin
  iframe `contentDocument` (like shadow roots); cross-origin throws on access and is
  honestly skipped. Ref resolution searches EVERY frame (`page.frames()`), so an
  iframe-embedded control is both visible AND clickable. Real-Chrome smoke (local http,
  same-origin iframe button): button appears in the snapshot + cross-frame click succeeds.
- ✓→Done **empirical real-web hardening (probe → fix → lock)** — a gap-probe of 7 real
  patterns on puppeteer-core 25.1.0 / Node 24 surfaced 3 bugs, all fixed + locked in
  smoke:browser (now 12 scenarios): ① a JS dialog (confirm/alert/prompt) BLOCKED the
  page → the next action hung to the timeout; now auto-accepted (the act was draft-first
  approved upstream) + reported in the snapshot `dialog` field. ② content inserted by
  setTimeout/fetch AFTER a click was missed (networkidle returns instantly with no
  network) → a MutationObserver-based `settleDom` waits for the DOM to go quiet (fast on
  static pages, capped). ③ disabled controls were listed (wasted clicks) → skipped in the
  walk. Verified: unit 36, smoke 12/12 exit 0, eval:browser-agent PASS.
- ✓→Done **new-tab following + autocomplete** (probe batch 2) — a target=_blank link /
  window.open popup spawned a tab the controller never followed (it kept observing the
  stale opener; window.open even hung 8s). Fix: arm a `targetcreated` listener BEFORE the
  click/submit (checking pages() after races and misses it) and adopt the new tab, within
  a 500ms window so a normal no-new-tab click isn't taxed (2943ms → 1446ms). Autocomplete
  (type → suggestion) already works via the DOM-stable settle. Locked: smoke 13 (new tab
  followed) + 14 (autocomplete observed); unit 36, eval:browser-agent PASS.
- ✓→Done **repeated-control targeting** (probe batch 3, click/select) — a per-row
  "Add to cart" / repeated "View" was DEDUPED to one entry, so the model could never
  target the 2nd (product lists, tables, search results — a huge real-web class). Fix:
  (a) dedup now collapses only TRULY redundant LINKS — same text AND same href (a
  responsive nav rendered twice); distinct buttons/actions are kept. (b) matcher gained
  ORDINAL targeting ("the second Add to cart", "2nd View", "last") that picks the Nth
  among equally-matched controls in DOM order — guarded so a literal label that starts
  with an ordinal word ("First name") is never mis-stripped (only applies when `rest`
  truly has >1 match). Custom (non-native) dropdowns + tabs already worked (settle).
  Locked: matcher unit +5, smoke 15 (repeated buttons distinct + ordinal→Banana), agent
  battery PASS.
- ✓→Done **browser_hover** (probe batch 4) — hover-triggered dropdown navs / tooltips were
  invisible (the submenu only renders on :hover/mouseover). New read-risk `browser_hover`
  tool grounds a target (the menu label) and moves the pointer over it, then re-observes —
  the pointer STAYS, so a nested submenu item stays clickable (moving to it keeps :hover).
  Also added `[aria-haspopup]` to the snapshot selector so explicit (possibly non-link)
  menu triggers are listed. Locked: unit +2, eval 10/10 STABLE 3/3 (hover→browser_hover,
  not click), smoke 16 (hover reveals Billing then clicks it), agent PASS. (Limit: a hover
  trigger that's a bare non-interactive `<div>` without aria-haspopup still isn't listed.)
- ✓→Done **form-control labels** (probe batch 5) — a radio/checkbox/labeled input was
  named by its `value`/`name` attr ("pro"), NOT its VISIBLE label ("Pro plan"), so the
  model — which refers to controls by their label — couldn't target them. Fix: a form
  control's name now resolves its accessible label (aria-labelledby → `<label for>` →
  wrapping `<label>`) before falling back to value/placeholder. Also added `[role=option]`
  / `[role=switch]` to the snapshot selector (custom listboxes/toggles with JS-delegated
  handlers, no inline onclick). Verified: radio→"Pro plan", input→"Email address",
  checkbox→"I agree to terms" all targetable + actionable; range sliders already settable
  via type/fill. Locked: smoke 17, unit 43, agent PASS.
- ✓→Done **browser_key** (probe batch 6) — no keyboard action meant a modal/dropdown with
  no visible close control could not be dismissed, and keyboard-driven UIs were unreachable.
  New read-risk `browser_key` tool presses Escape / Enter / Tab / arrows, then settles +
  re-observes (Enter wrapped in the new-tab follow). Verified: a modal opened by a button
  and closable only by Escape is dismissed; Tab fires its handler. Locked: smoke 18, eval
  11/11 STABLE 3/3 (Escape→browser_key, not click), unit 46, agent PASS.
- ✓→Done **multi-step agent reliability** (the frontier) — eval:browser-agent was a single
  1-2-step task; added a genuine multi-step scenario (open → search → CLICK the result →
  read the DETAIL page → answer the stock count that appears ONLY there). gemma4:12b carries
  the full chain STABLE 3/3 (terminal state = ended on the detail page; grounded answer = the
  "7 units" that's unreachable without clicking; fabricating or stopping at the results fails).
  Proves low-spec multi-step web autonomy is reliable, not just one-shot. The battery is now a
  scenarios[] array — add a scenario per new capability.
- ◦ **more real-web probes** — native file upload (`<input type=file>` → CDP uploadFile +
  path arg/tool), cross-origin iframe (per-frame contexts — scope honestly), drag-and-drop;
  and harder multi-step chains (3-4 clicks, a form fill across pages).
- ✓→Done **browser_scroll** — the snapshot only saw rendered DOM, so below-the-fold /
  lazy-loaded content (infinite feeds, long lists) was invisible. New read tool scrolls
  (down/up/top/bottom) + settles + re-observes. Unit (enum + reject-unknown + scrolls);
  eval 9/9 STABLE 3/3 (scroll EN+KO); real-Chrome smoke: a button lazy-appended on scroll
  is absent before and present after scroll('bottom'). Completes the observation-
  completeness trio with iframe + paging.
- ✓→Done **element paging past the 50 cap** — no more silent truncation. The controller
  collects up to BROWSER_ELEMENT_CEILING (200) so grounding matches the WHOLE set in code;
  every tool RESPONSE shows ≤BROWSER_MAX_ELEMENTS (50) and reports `total` +
  `hasMore`/`nextOffset`; `browser_read` gained an `offset` arg to page. Unit: 50-cap +
  total/nextOffset + offset-reads-the-rest; smoke: 61 elements returned (not capped at 50).
- ✓→Done **agent-level multi-step live battery** — `pnpm eval:browser-agent`: gemma4 drives
  open→type+submit on a local fixture shop (file://, no network) and answers from the rendered
  result; graded on TERMINAL STATE (the page records the query it actually received — a
  fabricated "I searched" cannot pass) + answer must carry the name+price that only render
  post-search. 3/3 STABLE. Built it the hard way: ① matcher bug — "search box" landed on the
  'Search' BUTTON (substring 60 > shared-words 35); type-intent now prefers ANY matching
  typeable element. ② harness initially omitted metadata.localMode → runtime hid the
  execute-risk type/click and gemma FABRICATED a result ("Wireless Mouse Pro $29.99") —
  recorded evidence that the gate-less raw model invents on tool failure; the ask path's
  verdict gate is the standing protection. ③ launchDetached probe window 10s→30s (a fresh
  profile's cold start exceeded 10s under load — "slow" misread as "missing").

## Done (recent — newest first)

- ✓ 2026-06-12 **file_read — "다운로드에 있는 PDF 요약해줘" 원샷** (tool-audit batch #4, the last):
  ONE read-risk tool, default under --with-tools. The model NAMES the file ("invoice pdf"); code
  grounds it — Downloads/Desktop/Documents walk (depth 3, no dotfiles), exact>prefix>contains>words
  ranking, newest-first ties; unmatched ⇒ recent-files list, never a guess; absolute path outside
  the roots ⇒ refused (muse.fs allowlist posture); >25MB refused; text capped 20K chars. PDF text
  via lazily-imported pdfjs-dist 6 (Apache-2.0; v6 dropped font-eval entirely). Proof: mcp 1606
  unit (10 new, TDD); NEW gate `pnpm eval:file-read` — headless Chrome GENERATES a real PDF →
  real pdfjs extraction → tool round-trip + fail-closed bounds, 6/6; eval:tools new file scenario
  5/5 STABLE 3/3 (spotlight/notes-recall/no-tool confusables); FULL eval:tools 130/130; LIVE e2e —
  a real contract PDF in ~/Downloads summarized with all three terms correct. Follow-ups: .docx/
  .hwp extraction · file kind by content-sniff not extension · file_read content into the
  grounding-evidence path with a [from FILE] cite.


- ✓ 2026-06-11 **mac_screen_read — "지금 화면에 뭐 떠있어?" 원샷** (tool-audit batch #2): screencapture →
  injected LOCAL vision callback (describeImage in agent-core: abstention-prompted free-text, fail-soft,
  never invents) → text; @muse/macos stays model-free (CLI binds gemma4 lazily via a holder ref since
  actuator tools build before the assembly). risk:read, behind MUSE_MACOS_ACTUATORS. mac_screenshot gained
  the not-when line (file vs describe). Proof: agent-core 1622 + macos 66 unit; eval:tools mac scenario
  28/28 STABLE 3/3 (2 new cases incl. the screenshot confusable); LIVE e2e described the real screen
  (Chrome+Example Domain+popup) accurately. ALSO from the audit: clipboard READ already existed
  (mac_app_read app='clipboard', eval-covered) — no duplicate tool built; live e2e returned pbcopy'd
  text verbatim.


- ✓ 2026-06-11 **browser: LIVE end-to-end — `muse ask`가 실제로 Chrome을 부린다** (4 commits):
  driving the REAL front door exposed a chain of four blockers, each fixed + verified live:
  ① injection input guard self-blocked every --with-tools ask (its own anti-injection guidance
  quotes attack strings; now scans USER messages only). ② browser_open/back were execute-risk →
  hidden without --actuators (now read; reads are free). ③ the ask prompt's "USING ONLY the
  notes" lock beat the armed tools (forked under --with-tools). ④ num_ctx 8192 vs 32K-budget
  mismatch → prompt truncated to done_reason:length, EMPTY answer (DEFAULT_OLLAMA_NUM_CTX=32768,
  live-verified the runner honours request num_ctx). PLUS: puppeteer.launch child pinned the
  event loop (ask answered then hung forever) → Chrome now spawns DETACHED and every invocation
  CONNECTs via DevToolsActivePort; ask disconnects post-run. Toolchain: Node 24.16 (nvm default),
  puppeteer-core 25.1 (clickCount→count), Locator API on click/type. PROOF: back-to-back live
  asks — ASK1 93s exit 0 (browser_open, grounded, external-source cite), ASK2 92s exit 0
  (reconnects, browser_read reads the SAME page). smoke:browser 13/13; pnpm check exit 0 on
  Node 24; precheck:grounding pass^2. LESSON: eval:tools 7/7 ≠ the surface works — only driving
  the assembled path catches exposure/prompt/window/process-lifecycle blockers.

- ✓ 2026-06-11 **browser: see the real web — SPA settle + shadow DOM + <select> grounding**:
  bounded settle-and-retry (`looksUnsettled`, 2×700ms) so late-rendering SPAs aren't a blank
  page; composed-tree walk + `pierce/` ref resolution so open shadow roots are observed AND
  actable; `browser_type` on a dropdown grounds the option in code (`matchOption`, fail-close —
  unmatchable option throws, page untouched); position:fixed controls no longer filtered
  (offsetParent check dropped); +combobox/searchbox/checkbox/radio/menuitem/tab roles.
  NEW standing gate `pnpm smoke:browser` (real headless Chrome, file:// fixtures, no network,
  skip-if-no-Chrome) 10/10. Tool-description fix: browser_open gained the "NOT for acting on
  the already-open page" line — the KO type case was 0/3 ON THIS MACHINE even at HEAD (the
  7/7 STABLE claim didn't reproduce — T=0 varies across machines); now 7/7 STABLE 3/3, full
  eval:tools 97/97. Also: removed a raw NUL byte committed into puppeteer-controller.ts
  (git saw the file as binary; byte-hygiene).

- ✓ 2026-06-11 **fresh-pass batch #2-#4**: README model-claim drift fixed (identity doc said
  qwen3:8b default — stale since 6/7; EN+KO). Duplicate date/time prompt line dropped on persona
  turns (~20 tokens/turn). **ask stage-latency instrumentation** (createStageTimer →
  trace `timings` + MUSE_TIMINGS=1 stderr): FIRST real breakdown = retrieval 0.2s (0.7%) ·
  generation 20.2s (75%) · verdict 6.5s (24%) of 26.8s — perf work should target generation
  (KV prefix env, sleep-compute) and reverify cost, NOT retrieval. Known-flake note: synthetic
  EN-weather case invents a tool name ~1/3 at temp 0 (pre-existing; REPEAT=3 surfaces it).
- ✓ 2026-06-11 **fresh-pass #1: --json carries the gate verdict** — the verdict now computes in
  json mode too (emissions stay non-json; best-of stays inert there); payload gains
  `groundedVerdict`; json traces now carry REAL labels instead of null (more error-analysis
  fuel). Live-verified. Closes half of audit CLI #8 (dead verdict under --json).
- ✓ 2026-06-11 **F9(half): SDT-adaptive proactivity criterion** — Green&Swets likelihood-ratio
  criterion as code: `sdtCriterion` (Laplace-smoothed, bounded β) + `adjustConfidenceFloor`
  (acceptance-region scaling) + `summarizeNoticeResponses` (done/snooze=acted, dismiss=noise,
  from the existing ↩-reply markers). WIRED live: the daemon's pattern tick now adapts the
  0.7 firing floor per the user's own response history (≥3 responses; fail-soft to default).
  A dismiss-heavy pattern category self-suppresses; an acted-on one fires more readily. 4/4.
- ✓ 2026-06-11 **Maturity-review do-next batch (#1-#5 ALL shipped)**: ① dead ACT-R wired (recall-hit
  ledger → Petrov-2006 approximation, hot episode outranks cold; 3fb1b95d). ② multi-hop measured
  REAL (joint@4 2/6) → deterministic second-hop ships 4/6 with single-hop hit@1 15/15 preserved
  via augment-never-displace (df9dc99b). ③ contextual chunk annotation (embedText, bare-value
  probe 5/6→6/6, both rank paths + persisted index; 4f237b95). ④ prompt-budget ENFORCEMENT
  (priority eviction, opt-in MUSE_PROMPT_TOKEN_BUDGET; 8b5a18ed). ⑤ multi-agent subtract-then-type:
  race PARKED (wire-compat → sequential, runRace deleted), parseWorkerResult typed boundary on all
  seams, and the FIRST live orchestration battery (eval:orchestration — injected failure
  propagates, bounded termination, fan-in survives; PASS on gemma4 in 2.3s).
  Remaining from the review: block-ablation arm (feeds/reflection) — queued.

- ✓ 2026-06-10 **AUDIT FIX (HIGH-adjacent): non-TTY fail-close unified across ALL actuator gates**
  — the stores/safety audit found web/email/home approval gates lacked the non-interactive deny
  the messaging gate had (outbound-safety rule 2: an undeliverable confirm must deny — a piped
  stdin byte must never act as the confirmation keypress). buildWebApprovalGate /
  buildEmailApprovalGate extracted with the shared contract; approvals re-run threads
  isInteractive (headless approve stays fail-close). 3 new gate tests; CLI 2455 green.
- ✓ 2026-06-10 **F7 semantic entropy: NEGATIVE result, recorded** — discrete SE (Nature 2024)
  AUROC 0.375 vs retrieval-confidence baseline 0.813 on answerable-vs-refuse: Muse's
  abstention-trained prompt makes refusals CONSISTENT ("NOT IN NOTES" × k), so sample
  scatter never appears — SE adds no signal here; do not adopt
  (docs/benchmarks/RESULTS-semantic-entropy.md, scripts/eval-semantic-entropy.mjs kept for re-runs).

- ✓ 2026-06-10 **Top-5 batch (Jinan-directed "do all 5")**: ① reverify judge now
  format-CONSTRAINED on all 4 call sites (REVERIFY_RESPONSE_FORMAT + parseGroundingReverifyJson,
  fail-close, legacy YES-parse fallback; precheck:grounding pass^3 live) — a verdict can no longer
  be lost to parse drift. ② source-trust DECIDED (option B) + shipped: the verified-sources block
  heading names itself external/tool-fetched (KO/EN), tool evidence carries trusted:false.
  ③ multi-turn query rewriting (needsContextualRewrite → one constrained inference → retrieval-only
  rewrite, fail-open): LIVE 2-turn proof — "그거 언제 바뀌었지?" resolved the anaphor and answered
  6월 2일 [from wifi.md]. ④ plan-cache reuse Jaccard→embedding blend
  (selectPlanExemplarByRelevance, cosine floor 0.75, fail-open lexical; wired via createGateEmbedder
  whose fallback also moved to the v2-moe default). ⑤ self-eval case ratchet extended to ALL golden
  sets (toolCases=84, adversarialCases=16, planCases=10). Gates: pnpm check exit 0 · CLI 2452 ·
  agent-core 1583 · autoconfigure 503 · lint 0/0 · precheck:grounding pass^3.
- ✓ 2026-06-10 **Lever #1 SHIPPED — multilingual embedder default + one-time legacy migration**
  (6caaa6ac): measured A/B (eval:embedder-ab, production ranking config, paraphrase queries) —
  v1 `nomic-embed-text` KO hit@1 **50%** vs `nomic-embed-text-v2-moe` **100%** (EN 100% too,
  no regression; embeddinggemma 92%). Default flipped (env `MUSE_EMBED_MODEL` overrides; leaf
  module `embed-model-default.ts`; 20 literals swept). `resolveIndexModel` migrates a
  LEGACY-default index once (live-verified on the real index); custom models preserved. All
  grounding batteries green ON THE NEW EMBEDDER (pass^3, Δ+0.94, chat 1.00/0.00).
  NOTE for the setup-language idea: one multilingual default serves KO+EN, so no setup
  language question is needed for the embedder; reply language remains a persona pref.
- ✓ 2026-06-10 **Lever #3 SHIPPED — ollama-perf doctor posture + stable-prefix prompt ordering**
  (c76ad9ba + part of 6caaa6ac): `muse doctor` advisory for OLLAMA_FLASH_ATTENTION/KV_CACHE_TYPE
  (reads process env + macOS launchd); ask's volatile prompt lines (time, retrieval guidance)
  moved BELOW the stable instruction block so Ollama's KV prefix reuse survives across turns.
  Residual: TTFT effect not isolated (needs control of the user's Ollama.app env — measure
  after Jinan sets the env vars).
- ✓ 2026-06-10 **Chat grounding parity — reverify escalation on the front-door surface**: the
  chat gate's borderline bands (weak retrieval, coverage-only failure, unsupported asserted
  value) now spend the SAME one-shot reverify judge ask uses (`gateChatAnswerWithReverify`,
  shared `chatGatePrecheck` keeps the deterministic number/email/quote checks identical; the
  judge fires ONLY on those bands — zero extra inference on a normal grounded turn; fail-close
  on judge error). Closes the recorded named-entity-drift-on-chat gap via the value-escalation
  band. TDD 6/6; CLI suite 2436 green; precheck:grounding pass^3; eval:chat-grounding
  faithfulness 1.00 / false-refusal 0.00; live chat round-trip cited. Sync `gateChatAnswer`
  stays (eval + no-provider fallback).
- ✓ 2026-06-10 **Multi-agent handoff fail-close (`validateWorkerHandoff`)**: a BLANK worker
  output no longer flows downstream as "completed" (MAST information-withholding) — sequential
  marks the step failed and tells the next worker, parallel reports failed, race never lets a
  blank answer win, supervisor excludes the worker and falls through. Typed `WorkerHandoff` +
  6/6 tests (incl. failure-propagation assertions); multi-agent suite 75/75.
- ✓ 2026-06-10 **Agent-performance levers research pass** → ranked 12-lever list with sources +
  feasibility-on-Ollama-today at `docs/strategy/agent-performance-levers.md`; top 3 promoted to
  the Open section above.
- ✓ 2026-06-10 **Best-of-N recall shipped — the gate is now a SELECTOR, not just a filter**
  (`muse ask --best-of <n>`, 2-5): when the first draft fails the grounding verdict, redraw n-1
  fresh drafts, `selectBestGroundedDraft` (agent-core, deterministic rubric-sum ranking, "weak"
  never accepted, TDD 5/5) picks the best grounded survivor, and the FULL reverify-backed gate
  confirms it before it replaces the answer — fail-close, so resampling can only raise the
  answered rate at the same fabrication=0. Orchestration extracted as `drawBestGroundedRedraft`
  (4/4 unit, composed with the REAL selector). Gates: pnpm check all-workspace green, lint 0/0,
  precheck:grounding pass^3 3/3, eval:grounding-delta Δ+0.94 unchanged, live happy-path ×4.
  HONEST LIMIT: the live adoption path (🎯) never fired in 3 adversarial forcing attempts —
  measured follow-up recorded above. Source: backlog ◦ (arXiv 2504.04718 — small models can't
  self-verify; Muse's owned verifier selects instead).
- ✓ 2026-06-10 **Trace outcome-logging COMPLETE for `muse ask` — cli.local traces carry real labels**
  (the standing ★ PREREQUISITE): the ask path now writes a run-log trace per answered run with the
  top-level `grounded` label the run already computed — `abstain` (refusal), `grounded`/`ungrounded`
  (rubric verdict), `null` only where the verdict doesn't run (`--json`/`--image`). Pure
  `askOutcomeLabel` (TDD, 3/3) + writeRunLog wiring before the output split; full CLI suite 210
  files/2426 green; LIVE both polarities on gemma4 (혈액형→abstain, notes question→grounded, source
  receipt shown). Error-analysis fuel now accrues from real usage; the analyzer stays deferred until
  ~20-30 labeled failures exist.
- ✓ 2026-06-10 **improve-muse restructured: finder/recommender, not full build loop** — a real
  invocation ended with "할 게 없다" (the ★ refill had all shipped; remaining = 1 medium-risk ★ +
  2 ⏳-on-Jinan), exactly the autonomy-ceiling failure dev-loop.md §5 predicted. Per Jinan's direction
  the skill now runs ORIENT+FIND only and MUST end with a ranked recommendation ("nothing to do" is a
  forbidden output — empty backlog ⇒ the refill scout IS the candidate; blocked item ⇒ the surfaced
  decision IS the recommendation). BUILD→COMMIT stays in dev-loop.md §3 after the pick. GREEN-verified:
  a fresh subagent following the new skill against the same repo state produced 3 ranked candidates +
  the source-trust ⏳ as an A/B question + a clear 내 추천, no build, no "nothing to do".

- ✓ 2026-06-09 **pre-push hook fix** — the hook ran `exec pnpm` and blocked the push with
  "pnpm: not found" from a GUI/IDE git client (which spawns hooks with a minimal PATH where an
  nvm/corepack-installed pnpm is absent). Now resolves pnpm (with common-path fallback) and SKIPs
  (exit 0) if still unfound — fail-open on a broken hook environment, never block a push because the
  tripwire couldn't start. LESSON: a pre-push convenience hook must degrade to skip, not block.
- ✓ 2026-06-09 eleventh `improve-muse` fire (20-min loop) — **`noWrite` over-invocation scorer**:
  `toolScorers.noWrite(writeToolNames)` in eval-harness.mjs — reads allowed, any write/execute
  (actuator) tool fails. The IrrelAcc primitive `noTool` couldn't express ("report yesterday" may
  call a recall read but must never fire calendar_add). 14/14. The refill's 3 ★ are now all shipped.
- ✓ 2026-06-09 tenth `improve-muse` fire (20-min loop) — **groundToolArguments substring-hardening**:
  isGrounded now matches a value token at a WORD START (prefix), not as a raw substring — so a fabricated
  "art" is no longer grounded by "start the meeting", while morphology (meeting→meetings) and Korean
  particle attachment (강남역→강남역에서) still ground. Strengthens the deterministic anti-fabrication edge
  at the tool boundary. unit 12/12; live eval:tool-arg-grounding 2/2 (강남역 kept, fabrication dropped).
- ✓ 2026-06-09 ninth `improve-muse` fire (20-min loop) — **REFILL + outbound-safety guard test**:
  the clean backlog had drained, so FIND WORK (c) ran a gap-finding scout → 3 fresh clean ★ slices
  added (contacts negative-invariant, groundToolArguments substring-hardening, noWrite scorer). Then
  built the top one: resolve-contact.test.ts now pins that relationship/about/connections NEVER resolve
  a recipient (outbound-safety rule 3) — 7/7. The loop un-stuck itself via the prescribed refill.
- ✓ 2026-06-09 eighth `improve-muse` fire (20-min loop) — **NEGATIVE result, recorded**: tried the
  disjoint-drift sharpen on the SQuAD arm; it dropped Δ +0.63→+0.13 (catch 5/8→1/8), so verify-before-claim
  REVERTED it. Real finding: the SQuAD drift catch is high-variance (stochastic gemma reverify) — the
  single-run +0.63 is not stable; stabilize with pass^k before optimizing. A failed experiment caught and
  recorded, not shipped — the discipline working on a metric regression.
- ✓ 2026-06-09 seventh `improve-muse` fire (20-min loop) — **trace outcome-label schema**:
  writeRunLog now lifts `success`/`grounded` to the TOP LEVEL of every `.muse/runs` trace
  (readResponseSuccess/readResponseGrounded), so error-analysis can grep outcomes without
  descending into `response`. Additive (no existing test broke; 17/17). Foundation for the
  data flywheel; populating cli.local's `grounded` (medium-risk ask-path change) is the next sub-slice.
- ✓ 2026-06-09 sixth `improve-muse` fire (20-min loop) — **`groundedCases` ratchet**: self-eval
  now also counts the grounding-corpus CASES (29), so a dropped case fails self-eval, not just a
  dropped battery file (must-fix #3, for the grounding corpus). unit 9/9. Same fire surfaced the
  human-decision ceiling: source-trust → ⏳ (architectural fork, needs Jinan), trace-logging scoped
  (medium-risk persisted path). The loop is reaching the seed-drain / refill point honestly.
- ✓ 2026-06-09 fifth `improve-muse` fire (20-min loop) — **pick-evals matches grounding TEST
  files** (regex `grounded` added → `grounded-not-true.test.ts` now maps to the grounding
  batteries, not lint-only). Same fire RE-SCOPED the source-trust ★: a graph trace found
  tool-output produces `VerifiedSource` (response-filters path), SEPARATE from the grounding
  `KnowledgeMatch` set — so the wiring target was wrong; corrected before code was wasted.
- ✓ 2026-06-08 fourth `improve-muse` fire (first 20-min-loop iteration) — **source-trust
  FOUNDATION**: `KnowledgeMatch.trusted` provenance bit + pure `groundedOnUntrustedOnly`
  detector (additive — verifyGrounding/the gate untouched), agent-core, 7/7 tests. Live
  gate unchanged (eval:grounding-delta still Δ+0.94). The grounded≠true mitigation now has
  a foundation; wiring it through tool-output-evidence → recall → answer-marker is the next ★.
- ✓ 2026-06-08 third `improve-muse` fire — **grounded≠true boundary NAMED**:
  `packages/agent-core/src/grounded-not-true.test.ts` (3 cases, deterministic) locks that the
  gate marks a false-but-source-supported answer "grounded" (faithfulness is to the source,
  not truth) while STILL catching a fabricated citation (integrity protected). The biggest open
  hole is now a tracked, named property; the actionable mitigation (source-trust segregation)
  is the new top ★. testFiles 847→848.
- ✓ 2026-06-08 second `improve-muse` fire — **public-dataset grounding-delta arm SHIPPED**:
  `buildSquadGroundingCorpus` maps a pinned SQuAD-2.0 slice (8 paras, no model-generation —
  templated answers) → `eval:grounding-delta:squad` writes `docs/benchmarks/RESULTS-squad.md`.
  LIVE Δ+0.63 (gate ON 0.63 vs OFF 0.00) on gemma4 — the first EXTERNALLY-anchored architectural
  delta. unit 10/10; self-authored arm still Δ+0.94 (no regression).
- ✓ 2026-06-08 first real `improve-muse` fire: BUILD's verify-before-claim caught that the
  top item's "SQuAD-unanswerable→refuse" mapping yields Δ≈0 (refuse=retrieval-confidence;
  SQuAD-unanswerable is adversarially similar → stays confident). Re-scoped the item to the
  drift/answer-grounding path with templated answers, before any fixture work was wasted.
- ✓ 2026-06-08 `feat/grounding-ci-gate`: fabrication=0 grounded-surface ratchet (self-eval)
  · live pre-push grounding tripwire (`precheck:grounding`) · grounding-delta benchmark
  (`eval:grounding-delta`, Δ+0.94 gate ON vs OFF on gemma4) · self-eval ENOENT fix.
