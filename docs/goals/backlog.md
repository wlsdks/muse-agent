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
  Osmani's "Loop Engineering" into `.claude/skills/loop-creator/references/loop-engineering.md` (6 primitives →
  Muse seams · verifiable stopping condition `/goal` · 3 failure-mode guards:
  unattended-verification / comprehension-debt / cognitive-surrender) and a
  generative `.claude/skills/loop-creator/SKILL.md` that fills the checklist,
  generates a principle-compliant recurring loop prompt, and registers the cron
  itself (delegating scheduling to `/loop`). Replaces hand-written ad-hoc loop
  prompts. FOLLOW-UP: pre-verify the skill end-to-end (theme → generated prompt →
  registered cron → reported stop method) on a real theme before relying on it.

## Done — chat-gate toolGrounded blanket bypass (2026-06-12)

- ✓→Done **toolGrounded blanket bypass** — the chat gate skipped on ANY tool call
  (`toolsUsed.length`) even when the tool returned nothing, taking the deterministic
  value checks down with it — a hole in the fabrication=0 floor on the conversational
  surface. FIX (spec `docs/superpowers/specs/2026-06-12-chat-gate-toolgrounded-bypass-design.md`,
  brainstorm+grill-hardened): bypass now keys on **non-empty `toolGroundingSources`**,
  not "a tool ran"; the value checks (`gateChatAnswerDeterministic`) ALWAYS run with
  the tool's own output folded into evidence (a value the tool didn't return is caught,
  a faithful one passes); an empty-result tool falls through to the full gate. Single
  source of truth `groundingSourceFromExecuted` (agent-core) shared by `run()` + the
  `tool-result` stream event (additive `grounding` field) so BOTH chat-repl (run result)
  and chat-ink (stream) gate on one contract. TDD: 4 helper + 2 stream + 3 finalize
  cases (value-check-survives + empty-result-hole RED→GREEN); `pnpm check` (full tree,
  2484 cli) + lint 0. Residual (in spec): tool-grounded PROSE fabrication still passes
  (separate slice, needs judge-vs-tool-evidence). (audit CLI #4)

## ★ Open — TOOL expansion & hardening (loop theme, 진안-directed 2026-06-12)

The loop's standing focus: EXPAND Muse's own tool surface + HARDEN the existing tools.
- ✓→Done **web_download silently clobbered an existing file** (EXPANSION gap-scout, live) — wrote bytes with a
  plain `writeFile(path, bytes)` (flag "w"), so downloading a name that already exists in the user's Downloads
  dir SILENTLY OVERWROTE the unrelated existing file (irreversible data loss, not even flagged) — AppWorld
  "collateral damage" class, against the module's own fail-closed-disk promise. FIX: a new `writeNonClobbering`
  helper dedupes like a browser (`name (1).ext`, `(2)`, …) using the `wx` flag (atomic exists-check+create, no
  TOCTOU); a real write error (EACCES/ENOSPC) is re-thrown → surfaces, never looped; bounded at 1000. TDD
  (pre-existing report.pdf intact + new bytes at "report (1).pdf") RED→GREEN; mcp 1698, check 0, lint 0.
  Fable-5 PASS (5 concurrent → 5 unique files; fresh-dir original name unchanged; no-ext/dotfile/multi-dot edges).
- ✓→Done **web_download buffered the ENTIRE response body before the size-cap check** (gap-scout runner-up;
  shipped fire 17) — `Buffer.from(await response.arrayBuffer())` then `> maxBytes`, so a multi-GB / never-ending
  body filled RAM despite the 50MB cap (memory-exhaustion DoS). FIX: a Content-Length pre-check (reject before
  reading if declared > cap) + a streamed `getReader()` read that aborts (`reader.cancel()`) the moment the
  accumulated size crosses the cap — the server can lie about/omit CL, so the streamed abort is the real defense;
  a no-body fallback still caps via arrayBuffer. TDD (instrumented 20×100B stream, cap 250B → aborts after ~3
  chunks, nothing written) RED→GREEN; mcp 1700, check 0, lint 0. Fable-5 PASS (under-cap byte-identical, no false
  reject on absent/garbage CL).
- ✓→Done **FLAKY cli chat-grounding.test "fails soft when retrieval throws" — made hermetic (fire 18)** — failed `pnpm check` transiently
  in fires 16 AND 17 (~5s, Ollama-timing dependent), passes on isolated re-run. Not a loop-slice regression but a
  real flaky gate. NEEDS: make the test hermetic (it should fail-soft without a live/slow Ollama path) — small fix
  but on the chat-grounding surface, separate from the TOOL theme; flag to 진안 / a chat-grounding fire. RESOLVED: added an optional injectable `searchRecall` DI seam to
  groundChatTurn/retrieveChatGrounding (production default = real recall); the test now injects a sync-throwing
  recall + MUSE_CHAT_AUTO_REINDEX=0 → NO network, runs in ms (was ~5s), and asserts `called===true` (strictly
  stronger). Fable-5 PASS (production unchanged, fail-soft still exercised). cli 2530, check 0 first-try, lint 0.
- ✓→Done **muse.tasks.update lost-update TOCTOU** (gap-scout runner-up; shipped fire 16) — built a WHOLE stale
  snapshot (`{...tasks[index]}`) outside the write queue and wrote it back inside mutateTasks, so two concurrent
  updates to DIFFERENT fields lost-update (last-writer-wins on the whole object). FIX: build a field-level DELTA
  (sets/clears) and re-apply it onto the FRESH `current[i]` inside the mutate callback (mirror `complete`); single-
  update semantics 1:1 unchanged. TDD (two concurrent updates to title + notes both persist in tasks.json) RED→GREEN;
  mcp 1699, check 0, lint 0. Fable-5 PASS (reproduced RED in a /tmp worktree). RESIDUAL (acceptable, pre-existing):
  a partial dueAt reschedule still anchors to the stale existing-due, so a due-move RACE on the SAME field is
  last-writer-wins (the cross-field lost-update is fixed); same class as `complete`'s resolve-outside-queue.
- ✓→Done **muse.url.parse query map prototype pollution** (EXPANSION gap-scout, live) — the query map was a
  prototype-bearing `{}`, so an attacker-controlled URL `?__proto__=a` hit the Object.prototype SETTER (param
  vanished + the object's prototype polluted before serialization) and `?constructor=c` collided with the
  inherited Object constructor (corrupted to an array via the dedup). Same class as the fire-4 json.merge
  __proto__ fix, unfixed on the URL surface. FIX (1 line): `const query = Object.create(null)` — null-prototype
  map, so __proto__/constructor land as plain own DATA keys and the `existing === undefined` dedup works for
  every key. TDD 1 (__proto__=a → own "a", constructor=c → "c", x="1") RED→GREEN; mcp 1696, check 0, lint 0.
  Fable-5 PASS (dedup string/array shapes preserved, JSON serializes null-proto own keys, no downstream consumer).
- ⏳ **muse.text.stats whitespace→zero — NOT a clean bug (documented behavior, needs 진안)** — `stats("   ")` returns
  `{characters:0, lines:0, words:0}` but an existing test (mcp.test.ts "treats whitespace as zero") DOCUMENTS this as
  intended. Unlike encode_query's incidental "[object Object]", the whitespace→zero is a named design choice — changing
  it alters documented behavior. Deferred to 진안: is whitespace-only meant to count as zero, or report factual chars/lines?
- ✓→Done **muse.url.encode_query encoded a nested object as "[object Object]"** (gap-scout runner-up; shipped fire 14) —
  `String(raw)` coerced a nested object/array value to the literal "[object Object]" — a silently-corrupt query param.
  FIX: an isScalar guard returns `{error: must be string/number/boolean}` for a non-scalar value or array item (scalars,
  scalar arrays, null/undefined skipping unchanged). TDD (nested-object value + object-in-array → error; scalar control
  encodes) RED→GREEN; updated an existing unit that incidentally characterized the "[object Object]" output (Fable-5
  judged the change legitimate — the test's intent was scalars). mcp 1697, check 0, lint 0.
- ✓→Done **muse.calendar.add mis-anchored a time-only endsAt** (EXPANSION gap-scout, live EN+KO) — `add`
  resolved `endsAt` with `parseIsoDate(endsAtRaw)` whose default anchor is now(today), so a bare time-of-day
  end ("4pm"/"오후 4시") for a NOT-today event resolved against TODAY while startsAt resolved to tomorrow →
  the LocalCalendarProvider INVALID_TIME_RANGE guard rejected it ("endsAt must be at or after startsAt").
  The sibling `update` already anchors a time-only end to the event day (`anchorFor`); `add` never did. FIX
  (1 expr): anchor a time-only endsAt to the resolved START's day — `isTimeOnlyPhrase(endsAtRaw) ?
  parseIsoDate(endsAtRaw, () => startOfLocalDay(startsAt)) : parseIsoDate(endsAtRaw)`. Date-bearing/ISO/absent
  endsAt unchanged. TDD 2 (EN "tomorrow 3pm"+"4pm", KO "다음 주 월요일 오후 3시"+"오후 4시" → end on start's
  day 16:00, no error) RED→GREEN via a registry mirroring the provider guard; mcp 1694, check 0, lint 0.
  Fable-5 PASS (no regression on other endsAt shapes; guard untouched).
- ✓→Done **muse.calendar.update cross-day move anchored a time-only endsAt to the OLD day** (gap-scout runner-up; shipped fire 12) —
  update's `anchorFor` uses `resolved.event.startsAt` (the original day), so "move it to Monday, ending 5pm"
  lands the end on the original day, not Monday. FIX: anchor the time-only endsAt to `newStartsAt` when the
  start moved. 1 expr + 1 test. (Sibling of the add fix above.)
- ◦ **relative-time "this weekend" asked ON a Saturday resolves to today 09:00 (possibly past)** (runner-up) —
  loopback-relative-time.ts:~477 delta `% 7` = 0 with no roll-forward (unlike the bare-weekday handler that
  forces delta=7). FIX: roll forward to next Saturday when today is already Sat. 1 line + 1 test.
- ✓→Done **muse.math.evaluate silently truncated a malformed multi-dot number** (EXPANSION gap-scout) —
  `parseNumber` scans a literal by greedily consuming digits AND dots, then did `Number.parseFloat(literal)`:
  `parseFloat("1.2.3")` returns 1.2 (stops at the 2nd dot, NOT NaN), so the NaN guard never fired and
  `evaluate("1.2.3 * 100")` silently returned 120. The math tool's WHOLE contract is an exact digit the
  local 8B can't compute, and this is the shared core behind the muse.math MCP tool AND the muse ask /
  chat-repl arithmetic fast-paths — a wrong digit flows into a user answer with NO model in the loop.
  FIX: one line, `Number.parseFloat(literal)` → strict `Number(literal)` (Number("1.2.3")=NaN → existing
  `invalid number literal` throw; "5."/".5"/integers/decimals still parse — node-verified no valid number
  regresses; "1..2" also now rejected). TDD 1 (multi-dot → error + 5./.5 controls) RED→GREEN; mcp 1687,
  check 0, lint 0. Fable-5 verifier PASS (no valid-input regression, reaches ask/chat fast-path). Matches
  code-style.md "strict Number() not parseFloat".
- ✓→Done **muse.json.query walked the prototype chain** (EXPANSION gap-scout runner-up; shipped fire 10) — path resolution uses
  `segment.key in cursor` so a path like `constructor`/`__proto__` on a plain object returns `found:true`
  with an inherited (often function) value that JSON-serialization silently drops to `{found:true}` (no
  value), and `__proto__` leaks Object.prototype. FIX: `Object.hasOwn(cursor, segment.key)` (own-property
  only). Sibling of the fire-4 __proto__ merge fix. 1 line + 1 test.
- ✓→Done **atomicWriteFile leaked its tmp on failure** (EXPANSION gap-scout runner-up) — `atomicWriteFile`
  (the shared sidecar-store write primitive) opened `<file>.tmp-<pid>-<uuid>`, wrote+fsync+closed it, then
  `fs.rename(tmp, file)`. On ANY failure after the tmp was opened (writeFile/sync error OR the rename
  failing), the tmp was orphaned → `*.tmp-*` litter accumulating in every sidecar dir (memory/tasks/
  reminders/action-log/…). FIX: wrap open→write→rename→chmod in try/catch; on failure
  `fs.rm(tmp,{force:true}).catch(()=>undefined)` then rethrow the ORIGINAL error (rm errors swallowed, never
  substituted; force no-ops if open never created the tmp). TDD 1 behavioral (target=directory → rename
  throws → assert rejection AND zero `.tmp-` entries) RED→GREEN; mcp 1681, check 0, lint 0. Fable-5 verifier
  PASS (swapped HEAD source to reproduce RED; no cross-writer race — rm targets only this call's UUID tmp).
- ✓→Done **muse.fs.stat lied about symlinks** (EXPANSION gap-scout runner-up) — the tool's description
  promises "Symlinks are reported as kind=symlink without following", but it called `fsLib.stat` (which
  FOLLOWS the link), so `entryKind`'s `isSymbolicLink()` was always false → a symlink was ALWAYS reported
  as its target's kind, never `symlink`. The contract was unsatisfiable. FIX: added an optional `lstat?`
  to the injectable fs seam + wired real `node:fs/promises` lstat into the default; the stat tool now
  calls `(fsLib.lstat ?? fsLib.stat)(decision.resolved)` (lexical path → lstat sees the link). The
  realpath-escape guard still runs first (unchanged), so no path guard was weakened. TDD 1 behavioral
  (lstat→isSymbolicLink → kind=symlink, vs stat-follow → file) RED→GREEN; mcp 1680, check 0, lint 0.
  Fable-5 verifier PASS (sandbox-compiled HEAD reproduced RED). RESIDUAL: read/list still FOLLOW symlinks
  on the lexical path (by design — realpath guard prevents escape; a symlink-swap TOCTOU window remains,
  separate slice). Runner-up still OPEN: `atomicWriteFile` leaks `*.tmp-*` on a write/rename failure (no
  unlink on the error path — accumulates litter in sidecar store dirs).
- ✓→Done **muse.json.merge prototype-pollution** (EXPANSION gap-scout, Fable-5) — `deepMerge` did
  `result[key] = …` for every key of model-supplied `overrides`; model args arrive via JSON.parse, which
  makes `"__proto__"` an OWN data key, so `result["__proto__"] = …` hit the Object.prototype SETTER and
  HIJACKED the merged object's prototype (silently injected inherited fields like `isAdmin`, dropped the
  key). FIX: special-case `key === "__proto__"` — read any existing own value via
  `Object.getOwnPropertyDescriptor`, deep-merge, write back via `Object.defineProperty` as an own
  enumerable data prop (never the setter); other keys unchanged. Verifier confirmed `__proto__` is the
  ONLY setter vector here (constructor/prototype create plain own props, no pollution) and the guard
  recurses to every depth. TDD 1 behavioral (JSON.parse'd `__proto__` overrides → prototype intact +
  no injected field + key preserved as data) RED→GREEN; mcp 1679, check 0, lint 0. Fable-5 verifier PASS.
- **ask error-path run-log trace (#6/#7) — DECOMPOSED (v1.11.2 decompose-on-defer)**: writeRunLog(success:true)
  was inline at the END of the ~2000-line `muse ask` action (commands-ask.ts:3734) with NO enclosing
  try/catch, so a thrown run left no trace (error-analysis fuel lost) + Ctrl-C logged success:true. Same
  pattern in chat-repl. Split into loop-sized slices with exact seams:
  - ✓→Done **6a — pure `buildAskRunLog` builder (the shared seam)**: extracted the inline cli.local payload
    into `buildAskRunLog(params)` in program-helpers.ts (next to writeRunLog), supporting BOTH success and a
    FAILURE shape (`success:false` + `error`). Wired the live success path (commands-ask.ts:3734) to it
    (not inert). TDD 3 (success payload + readResponseSuccess lifts true; FAILURE payload lifts false + carries
    error; confidence/error omitted when absent) RED→GREEN. cli 2528, check 0, lint 0.
  - ◦ **6b — wrap the ask run in a failure-logging seam (THE fix, dedicated fire)**: extract the 1842 action
    body into a nested `async function runAskAction(queryParts, options)` (closure vars stay in scope) and
    register `.action(async (q,o)=>{ try { await runAskAction(q,o) } catch(e){ await writeRunLog(.., buildAskRunLog({..success:false, errorMessage:String(e)})); throw e } })`. RED: a thrown ask run writes a
    success:false entry. SIZING: the body-extraction is a big MECHANICAL (~2000-line) move — behavior-identical,
    verify with the full ask suite BEFORE adding the catch; warrants its own focused fire (or human-paired), not
    bundled. 6a already provides the payload so the catch is one-liner.
  - ◦ **6c — #7 Ctrl-C/abort does NOT log success:true**: once 6b's catch exists, an AbortError/SIGINT reaching
    it logs success:false (or skips), never success:true. RED: simulate abort → assert no success:true entry. Small.
  - ✓→Done **6d — chat-repl failure trace**: `createTuiChatSubmitter` wrote a run-log only on the happy
    path; a thrown runner left no trace. Added an injectable `runChat` param (default = real local/remote
    dispatch) + a try/catch that writes a `success:false` entry (response {error, success:false}) best-effort
    then re-throws the original error. TDD 2 (throwing runner → success:false trace + re-throw; success path
    unchanged) RED→GREEN. cli 2530, check 0, lint 0. Fable-5 PASS (success path byte-identical, no double-log).
    Note: done independently of 6b (chat handler is a small fn, no 2000-line extraction needed).
- ⏳ **calendar credential encryption-at-rest — DEFERRED (architectural cost)**: `FileCalendarCredentialStore`
  stores caldav passwords / google tokens plaintext (0600). The proven envelope lives in `@muse/memory`,
  but `@muse/mcp`→`@muse/calendar` already, and `@muse/memory` pulls `@muse/db`+`@muse/model` — encrypting
  the lean calendar package would bloat its dep graph (and the desktop binary). Needs a shared low-level
  crypto seam or a key-provider injection decision (Jinan-level), not an autonomous fire.
- ✓→Done **notes-family tool-selection coverage + sharpened save/append not-when** (per-tool not-when
  audit follow-up): `muse.notes` save/append had ZERO not-when clauses and were ABSENT from eval:tools.
  RED baseline (live gemma4, 3 runs) caught a real save-vs-append confusion (KO "write to a note" →
  notes.append 0/3 instead of notes.save). FIX: sharpened save (=CREATE/REPLACE a note FILE) + append
  (=ADD to an EXISTING note) descriptions with use-when/NOT-when (both NOT a to-do/reminder) +
  `buildNotesScenario` (6 cases: 3 positive notes-file + 3 disambiguation task/reminder must NOT route
  to a note tool). GREEN 12/12 STABLE 3/3; Fable-5 verifier PASS (discriminating + registered + not
  over-fit). mcp 1678·check 0·lint 0. REMAINING per-tool not-when targets: messaging/episodes/context.
- ✓→Done **SSRF-guard test fallout swept (web_action consumers)** — the earlier always-async
  assertPublicHttpUrl hardening correctly broke 4 tests that used non-resolvable reserved-TLD hosts
  (`*.test`) as fake public URLs → guard refused them, no fetch fired. Threaded an OPTIONAL
  `lookup?: HostLookup` DI seam through `buildActuatorTools` + `approvePendingApproval` (runActuatorByName
  already had it); the 4 tests (cli×2, api×2) now inject a fake PUBLIC resolver. Production omits lookup →
  real node:dns/promises → guard intact (Fable-5 verifier confirmed: seam is caller-controlled, not
  model-facing; no SSRF hole). check 0·lint 0.
- ✓→Done **scout raw-NUL byte-hygiene regression** — `run-log-analysis.ts:85` had a literal raw NUL
  delimiter (`${kind}\x00${topic}`) from an earlier fire, FAILING the @muse/shared byte-hygiene gate on
  main (caught by `pnpm check`, missed by quick self-eval). Replaced with the u+0000 escape (byte-identical
  runtime value; key is Map-only, never split). shared byte-hygiene 30/30.
- ✓→Done **web_download post-redirect SSRF re-check** (EXPANSION-scouted): the SSRF guard ran only
  on the INITIAL url, so a public URL redirecting to a private/link-local host (169.254.169.254
  metadata, 127.0.0.1) was followed and WRITTEN TO DISK. Now re-applies assertPublicHttpUrl to the
  final `response.url` AFTER fetch, BEFORE any write (mirrors loopback-web-read + fetch-readable-url —
  web_download was the only fetch path missing it). Behavioral test (redirect→private = refused +
  nothing written) RED→GREEN; Opus security-grade verifier PASS. mcp 1668·lint 0.
- ✓→Done **SSRF DNS-rebinding closed** — the web fetch tools (web_download, web_action) had a
  `deps.lookup ? async : sync` bypass: with no lookup wired (production), the SYNC guard ran, catching
  only LITERAL private IPs, not a public hostname that *resolves* to a private IP (rebinding). Fix:
  drop the bypass, always call `assertPublicHttpUrl` (its defaultLookup = node:dns/promises resolves +
  checks) — so the no-lookup production path now catches rebinding. Hermetic tests: injected
  privateLookup→refused + a dns-stubbed no-lookup test that the verifier confirmed discriminates the
  fix (reverting the bypass makes it fail). web_action fixed too. (loopback-web-read was already
  correct.) mcp 1670·lint 0. Note: this fire FAILED first (test proved NXDOMAIN not rebinding) →
  test fixed → re-verified PASS.
Every slice ships its eval/test and never weakens the grounding floor. Ranked:

- ✓→Done **mac wifi_status read** (capability-scout): "am I on WiFi? / what network?" was unanswerable
  — `mac_system_set` could TOGGLE wifi but there was no READ (write/read asymmetry). Added a
  `wifi_status` shell-read source to the wired `mac_app_read` (networksetup -listallhardwareports →
  device, -getairportnetwork → {connected, network}), reusing parseWifiDevice. read-only (no
  -setairportpower). Behavioral parse tests (connected+disconnected) + eval read-vs-write disambig
  (EN+KO). macos 85·lint 0, Opus-verified. SCOUT NOTE: surface now broadly capable; remaining
  capability gaps are niche/live-only (running_apps, ip_address) → recommend a theme switch next.

- ✓→Done **mac_screenshot arbitrary-write closed** (EXPANSION-scout): the `path` arg went straight to
  `screencapture -x <path>` with no validation — a model/injection could overwrite ANY writable file
  (e.g. ~/.ssh/authorized_keys) with PNG bytes. Fix: allowlist (~/Desktop, ~/Downloads, tmp), `~`
  expand, basename, parent-dir realpath check, AND full-target realpath (a symlink AT an allowed path
  pointing outside is refused — mirrors the loopback-filesystem fix). fail-closed, runner never called
  on refusal. 6 behavioral tests (abs-path/traversal/outside-parent/symlink-at-target → refused,
  allowed/default → ok). FAIL→fix→re-PASS: the first gate caught a SILENT symlink-at-target residual
  (the prior fire had just closed that exact class) → closed it + tested → re-verified. macos 83·lint 0.

- ✓→Done **loopback-filesystem symlink-escape closed** (EXPANSION-scout runner-up): the MCP
  filesystem server's allowlist checked paths LEXICALLY only — a symlink inside an allowed root
  pointing outside (/allowed/x -> /etc/passwd) passed and was read/listed/statted. Fix: a 2nd gate in
  checkAllowed realpath-resolves the path AND the roots (symmetric, handles macOS /var->/private/var)
  and refuses if the real path escapes (fail-closed on throw/ENOENT); applied to read/list/stat. 8
  behavioral tests (escape→error, normal→content, dangling→refused). Verifier confirmed production
  always wires the default realpath (the optional dep is test-only, no skip-hole). mcp 1678·lint 0.
  (file_read already had a realpath guard; this was the MCP-server variant's gap.)

- ✓→Dropped (NOISE, fire 6) **browser-read ungrounded ×7** — the scout's first hit turned out to
  be dev-test NOISE: 7 traces from the 2026-06-11 browser-testing session, all EMPTY answers
  (ans_len 0, tools []) — a no-op the gate correctly marked ungrounded, NOT a real grounding miss.
  Fix went to the SCOUT instead (fire 6): exclude empty-answer non-answers, so the board is now
  clean. Lesson: an ungrounded EMPTY answer ≠ actionable work.

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
- ✓→Done **mac: read Calendar.app / Notes.app / Reminders.app** — all three shipped as SOURCES on
  the already-wired `mac_app_read` tool (`reminders` incomplete items+due, `calendar` today's events,
  `notes` recent titles) — not new tools, keeps the exposed set small (tool-calling.md). Each:
  reachable in the model-facing app enum (verifier confirmed), behavioral parse test (fake osascript
  runner), eval:tools golden cases (EN+KO). risk=read (snippets never mutate). The earlier INERT
  separate-tool attempt was rolled back; done the COMPLETE way (extend wired tool + eval). So
  "what's on my calendar today / what reminders do I have / what notes" works locally.

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
- ◦ **per-tool not-when audit** — PROGRESS (loop fire): the `followup` tools (list/cancel/snooze)
  were the ONLY personal-tool family with ZERO not-when clauses → added "use when / NOT when"
  disambiguating them from tasks/reminders (followup = agent auto-captured thread, not a user item)
  + buildFollowupScenario in eval-tool-selection.mjs (6 positive + 4 disambiguation cases). Verifier
  confirmed the disambig cases are discriminating + wired. Other families (tasks/reminders/calendar)
  already have not-when. REMAINING: spot-audit any other tool families that lack it.
- ◦ **tool-arg grounding coverage** — extend `groundedArgs` (the deterministic anti-fabrication
  boundary) to every actuator persisting model-named free-text; one behavioral drop test each.
  DONE: `tasks.add` (notes/tags), `tasks.update` (notes), `add_contact` (relationship), `calendar`
  (location/notes), `followup.cancel` (reason) — each Opus-verifier-traced to the runtime grounding.
  REMAINING: spot-audit other update/edit paths' optional free-text (reminders has none fabricable —
  text=user-stated, dueAt=time, recurrence=enum).
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
- ✓→Done **Calendar store + credential store: corrupt file → silent full wipe** — both
  `LocalCalendarProvider.readAll` and `FileCalendarCredentialStore.readAll` returned empty on
  JSON-parse-failure OR schema-mismatch, and the next atomic write then overwrote the corrupt-but-
  recoverable original — permanent data loss. Adopted the sibling reminders-store posture via a shared
  `corrupt-quarantine.ts` (`quarantineCorruptStore` = best-effort rename to `<file>.corrupt-<ts>`),
  called on all 4 corrupt branches; writes were already atomic (tmp→rename). TDD 3 (corrupt JSON +
  schema-mismatch quarantined with original bytes preserved; credential corrupt quarantined) RED 3/3 →
  GREEN; calendar 152, check 0, lint 0. Fable-5 verifier PASS (ENOENT/transient-IO not quarantined,
  predicate unchanged so strictly safer, rename preserves 0600, concurrency-safe). RESIDUAL (out of
  slice): local-provider's per-entry `isPersistedEvent` flatMap still silently drops INDIVIDUAL corrupt
  events from an otherwise-valid array — a partial-loss path (logs nothing); separate slice.
- ✓→Done **toolGrounded blanket bypass** — fixed; keys on non-empty toolGroundingSources, value checks
  always-on, single-source helper shared run()+stream. See the Done entry up top. (CLI audit #4)
- ✓→Done **Chat-only users never get the embedder migration** (CLI audit #5) —
  `refreshStaleNotesIndexForChat` gated re-embed on CONTENT staleness only and returned early when
  notes were unchanged, so a chat-only user (the desktop companion never runs `muse ask`, the only
  other reindex trigger) kept ranking v2-moe query vectors against a legacy v1 index forever
  (cross-model cosine noise above the 0.5 floor). FIX: read the index model BEFORE the staleness
  gate; re-embed on `modelStale || contentStale`, where `notesIndexNeedsModelMigration` =
  `resolveIndexModel(existing, requested) !== existing` (legacy→default migrates; custom/default/none
  unflagged so no every-turn loop). Made the fn exported + deps-injectable (isStale/reindex/
  readIndexModel) for an Ollama-free OUTCOME test. TDD 5 (1 helper unit + 4 DI behavioral: legacy-fresh
  reindexes to default, default/custom-fresh don't, content-stale still does) RED→GREEN; cli 2525,
  check 0, lint 0. Fable-5 verifier PASS. RESIDUAL (separate slice): if the embedder is DOWN during a
  model-mismatch rebuild, `reindexNotes` drops prior-entry carry-forward → saves an empty index until
  notes change / manual reindex (fail-close: zero hits → refusal, not fabrication; pre-existing path).
- ◦ **ask error paths skip the run-log trace** (failed runs are exactly the error-analysis fuel) +
  Ctrl-C still runs the verdict pipeline and logs success:true. try/finally + success:false entries.
  (CLI audit #6/#7)
- ◦ smaller: ~~correction-polarity regex unanchored ("NOT CONTRADICT"→contradict decay)~~ ✓DONE
  (2026-06-13 fire 17: core de-negation existed; HARDENED to cover contraction auxiliaries
  WON'T/CANNOT/WOULDN'T/SHOULDN'T/COULDN'T + 0-2 intervening words "NOT A CONTRADICTION"/"DOESN'T
  REALLY CONTRADICT"; conservative-by-design over-strip = fail toward no-decay; 99 agent-core green) ·
  ~~enforceAnswerCitations whitespace rewrite on clean answers~~ ✓DONE (fire 18: cleanup gated on stripped.length>0 — clean answers verbatim, code blocks preserved; 1732 green) ·
  ~~casual-prompt 말해줘 over-match suppresses source blocks~~ ✓DONE (fire 20: removed 말해줘 from isCasualPromptText social regex — "내 일정 말해줘" etc are recall imperatives, were wrongly classed casual → source footer suppressed; Fable-judge PASS, agent-core 1741 green) · ~~dedup memoizes write results~~ ✓DONE (fire 19: real bug was stale-READ-after-write — a memoized read went stale after an intervening write in-loop; fix = mutating record invalidates read entries, keeps write entries/anti-double-write; Fable-judge PASS, agent-core 1738 green) ·
  ~~groundToolArguments partial-array reported as dropped~~ ✓DONE (fire 21: partial-array clean now keeps survivors WITHOUT reporting the arg in `dropped` — dropped = fully-removed args only, per the contract; .args cleaning unchanged; Fable-judge PASS, agent-core 1746 green) · consented-action header override ·
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
- ✓→Done **ACT-R base-level activation for recall ranking** — frequency×spacing activation over the
  access logs now drives promotion RANKING (not the single recency half-life). (T2-1)
  [DONE 2026-06-12, cognition loop fire 1–3 + 진안 review-gate decision: RANKING-ONLY; the
  gate-scale migration (ACT-R driving eligibility, needs log-scale threshold recalibration + A/B)
  was deliberately NOT pursued — ranking lift is captured, gate stays on the scale-safe plain score.]
  — [in progress 2026-06-12, cognition loop] fire 1: `actrActivation(accessAgesDays,{decay,minAgeDays})`
  = `ln(Σ tⱼ⁻ᵈ)` + 9-case battery SHIPPED in `@muse/memory` (recall-promotion.ts). fire 2: the DATA
  FOUNDATION — `personal-recall-hits-store.ts` now logs a bounded `recentAccessMs` per memory (cap 20,
  tolerant migration of old records, garbage-sanitizing read). fire 3: WIRED — `recallActivation` +
  opt-in `useActrRanking` on selectPromotable/selectForgettable ranks by ACT-R (frequency×spacing)
  while the eligibility GATE stays on the plain recency score (scale-safe); enabled at the `muse memory
  consolidate`/promote call sites. ⏳ REMAINING (review-gate decision): a measured A/B on whether ACT-R
  should also drive the eligibility GATE (needs threshold recalibration to the log scale) before
  graduating — ordering is live now, gate-migration is the open call. Then this item → Done.
- ✓→Done **ACE deterministic playbook delta-merge** — itemized deterministic deltas replace the
  LLM-rewrite first pass + an anti-collapse invariant test (+10.6% AppWorld for the pattern). (T1-1)
  [DONE 2026-06-12, cognition loop fire 4: `deltaMergePlaybookStrategies` (whitespace-dedup +
  token-coverage subsumption + non-transitive anti-collapse GUARD) was already implemented & wired
  ahead of the LLM merge; the MISSING piece — a DIRECT anti-collapse invariant battery — was added
  (7 cases incl. the non-vacuous property "if it returns a survivor, that survivor token-covers EVERY
  input", so a learned strategy is never silently dropped). Test-only; agent-core 1691 green.]
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
- ✓→Done **`hallucinations_v1`-style per-sentence groundedness** — finer than the answer-level
  gate: labels each sentence supported/unsupported so the fuel names WHICH sentence was
  un-groundable. Source: Google ADK eval criteria.
  [DONE 2026-06-12, cognition loop fire 5+6: labeler + LIVE-wired into the ask grounding-gap
  fuel HINT. fire 6 added `worstUnsupportedSentence` + wired it so a grounding-gap weakness
  records the worst un-groundable sentence as its ledger `hint`. LIVE-PROVEN on the assembled
  CLI: "광합성 화학 반응식" → hint named the exact ungrounded formula sentence; abstains →
  hint named the refusal sentence. Realized via the real-usage weakness-fuel path (better than
  the originally-imagined eval:self-improving surface); "contradictory" label (NLI) stays deferred.]
  — [fire 5] the LABELER shipped:
  `reportSentenceGroundedness(answer, evidence, floor?)` in `@muse/agent-core`
  (`sentence-groundedness.ts`) — pure, reuses the gate's `lexicalTokens` + the
  `splitPreservingSentencePunctuation` splitter; per-sentence supported/unsupported by
  token-coverage ≥ floor (0.5), reports unsupportedCount + unsupportedFraction. Diagnostic
  only (no gate verdict changed). 9-case battery. NEXT: WIRE into eval:self-improving's
  report so a miss names the sentence; "contradictory" label needs NLI (non-deterministic,
  deferred — supported/unsupported is the deterministic core).

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

- ✓→Done **Evidence-tallied playbook lifecycle (Memp, arXiv:2508.06433)** — [2026-06-13, cognition
  loop fire 27, PAPER-GROUNDED, Fable scout+judge] Playbook reward was a clamped NET scalar that
  conflated "never used" with "used 10× / 5↑5↓"; deprecation needed a near-pure losing streak;
  probation graduated on a single net-positive bump. Applied Memp's update regimen (public preprint;
  reimplemented): per-entry outcome TALLIES (`reinforcements`/`decays`) + `wilsonInterval` +
  `effectiveStrategyReward` (evidence-damped; legacy-identical without a tally) + `planStrategyLifecycle`
  (deprecate when wilsonUpper<0.4 & n≥5; graduate when probation & wilsonLower>0.5 & n≥3). Wired
  END-TO-END: `adjustPlaybookReward` (store) writes the tallies; the 4 production projections
  (`buildPlaybookProvider` + 3 commands-ask mappers) now CARRY them; `scoreStrategy`/`isAvoidedStrategy`/
  `isInjectableStrategy` consume them on the live `applyPlaybook` ranking path. Fable judge FAILed v1
  (the lifecycle was INERT — projections stripped the tallies) → completed the wiring + an assembled-path
  test (confident-bad {0,8} excluded THROUGH the real provider; counterfactual proves the stripped
  projection let it through). Playbook = prompt-ranking only (floor untouched). agent-core 1805 + autoconfigure 509 + cli 2528 green.

- ✓→Done **Multi-aspect verifier vote on the MoA fallback (BoN-MAV, arXiv:2502.20379)** — [2026-06-13,
  cognition loop fire 26, PAPER-GROUNDED, Fable scout+judge] When the MoA aggregator threw/returned empty,
  `orchestrateAnswer` blindly picked the `"thorough"` proposal — even if off-topic while another was on-point;
  no candidate was ever verified ("Bo-n" without "MAV"). Applied BoN-MAV (public CC-BY; reimplemented): NEW
  `verifier-vote.ts` — `aggregateVerifierVotes` (binary aspect votes, AggScore=approvals/count, argmax,
  deterministic tie-break, NaN-guarded) + `DEFAULT_ASPECT_VERIFIERS` (on-topic/substantive/non-hedging —
  relative ranking, NEVER abstains). Wired into the aggregator-failure fallback only (happy path byte-identical;
  no grounding/citation/abstention semantics touched). Fable judge PASS — reverted-to-HEAD proved the delta
  non-vacuous (off-topic thorough vs on-topic skeptic → skeptic). agent-core 1786 green.

- ✓→Done **Associative recall via Personalized PageRank (HippoRAG 2, arXiv:2502.14802)** — [2026-06-13,
  cognition loop fire 25, PAPER-GROUNDED, Fable scout+judge] Muse recall was isolated (cosine+BM25+ACT-R)
  with zero graph/spreading-activation structure. Applied HippoRAG 2 (public ICML 2025 preprint;
  reimplemented, no code copied): NEW `packages/agent-core/src/associative-recall.ts` — `buildNoteLinkGraph`
  (undirected weighted note graph, edge weight Σ 1/df(sharedToken), df===N excluded) + `personalizedPageRank`
  (deterministic power iteration, damping 0.5, dangling→teleport, mass-conserving). Wired opt-in into
  `rankKnowledgeChunksWithHop` (`associative?` flag): seed PPR with primaries, append top **PPR>0**
  graph-reachable bridges via the fire-22 query-relative-cosine fail-safe path (max-2, primaries
  byte-identical, flag-off no-op). Floor-safe (no verdict change). Fable judge FAILed v1 (missing PPR>0
  floor → appended unrelated PPR-0 notes; vacuous integration test) → remediated (PPR>0 floor + a
  non-vacuous test: bridge absent flag-off / present flag-on via the token chain / unrelated excluded,
  counterfactual-verified). agent-core 1772 green. NEXT: synonym edges + wire into CLI ask after a live multi-hop battery.

- ✓→Done **No needless judge escalation on sentence-opener connectives** — [2026-06-13, cognition loop
  fire 24, Fable-scout runner-up] `answerAssertsUnsupportedValue` flagged sentence-initial capitalized
  connectives ("However"/"Based"/"Therefore"/"Additionally", all absent from LEXICAL_STOPWORDS) as
  named entities → a needless value-escalation judge pass (wasted local inference) whenever an answer
  opened a sentence that way. Added `SENTENCE_OPENER_STOPLIST` to the named-entity filter; genuine
  wrong-entity/number/email drift detection is structurally untouched (preserved). Fable judge FAILed
  the first attempt (positive tests were vacuous — used a THROWING judge that the fail-open escalation
  swallowed); remediated to `async () => false` so the verdict differs, and counterfactual-verified
  (revert src → the 3 opener tests now FAIL). agent-core 1760 green.

- ✓→Done **Second-hop retrieval no longer inflates CRAG confidence** — [2026-06-13, cognition loop
  fire 22, Fable-scout-found] `rankKnowledgeChunksWithHop` appended hop "bridge" matches carrying a
  SEED-relative cosine, but `KnowledgeMatch.cosine` is contractually "cosine to the QUERY" (the CRAG
  confidence signal). An inflated bridge (a near-duplicate note ~0.95 to the seed but ~0.48 to the
  query) flipped a weak retrieval to "confident" → suppressed the LOW-confidence warning + defeated
  the proactive stay-quiet gate + could fire phantom clarifications. FIX: recompute each appended
  bridge's cosine against the ORIGINAL query (embed query once via options.embed — cache hit in
  prod; prefer the chunk's embedText for the consistent space); FAIL-SAFE to cosine:0 on any embed
  error (a bridge must never RAISE confidence). Verdict logic untouched (input repair, IMMUTABLE-CORE
  safe). Fable judge reverted-to-HEAD to PROVE the regression bites (0.9997→"confident" pre-fix,
  0.48→"ambiguous" post). agent-core 1753 green.

- ✓→Done **MoA orchestrator: honest contributor attribution** — [2026-06-12, cognition loop fire 7,
  multi-agent #3] the MoA aggregate path set `contributors = all proposers`, but the field is
  documented as "ids the synthesized answer ACTUALLY drew on" and the aggregator discards off-topic
  proposals — a MAST reasoning-action-mismatch (the audit trail over-claimed). Added
  `attributeContributors(merged, proposals, floor=0.4)` (a proposer counts only when the merge
  lexically covers ≥floor of its tokens; fallback to all if none clear it) wired into the multi-merge
  return only. Other return paths (single / single-survivor / aggregator-empty) were already correct.
  agent-core 1708 green incl. a non-vacuous regression (3 proposers, merge echoes 2 → exactly 2 credited).

- ✓→Done **A2A council: typed + length-bounded response boundary** — [2026-06-12, cognition loop
  fire 8, multi-agent #3] the council REQUEST hand-off had a typed `parseCouncilRequest`, but the
  RESPONSE (the direction that flows into the initiator's LOCAL synthesis) was an inline ad-hoc check
  with NO length bound — a buggy/compromised allowlisted peer could flood local synthesis context
  (the wire's "bounded compute" goal wasn't enforced on the accepting side). Added a symmetric
  `parseCouncilResponse` + `MAX_COUNCIL_REASONING_CHARS` (truncate over-long reasoning at the trust
  seam) wired into `requestCouncilReasoning`. fromPeerId is carried-through (NOT a rejection reason —
  the judge caught + relaxed an over-strict draft that would have dropped legitimate reasoning when a
  peer's selfPeerId is unset, which handler.ts emits as ""). a2a 141 green.

- ✓→Done **Council synthesis: one member, one voice (per-peer dedup)** — [2026-06-12, cognition loop
  fire 9, multi-agent #3] `synthesizeCouncilAnswer` fed raw utterances into the synthesis without
  deduping by peer — a duplicate peerId (dup registry entry, or the initiator's selfId colliding with
  a peer id, both reachable via `gatherCouncil`) double-weighted that member (MAST duplicated-work,
  skews a deliberation). Added pure `dedupeUtterancesByPeer` (last-wins, order-preserving) applied at
  the synthesis boundary. agent-core 1712 green incl. a prompt-capture integration (dup peer → the
  synthesis prompt shows the LAST reasoning once, 2 members not 3).

- ✓→Done **Background memory consolidation (sleep daemon)** — [DONE 2026-06-13, cognition loop
  fires 10-12+16, background #5] `consolidationPlan` (recall promote/fade) only ran on the manual `muse
  memory consolidate` CLI — the daemon consolidates the PLAYBOOK but never MEMORY. fire 10 shipped
  the brake-first gate `shouldConsolidateMemory({nowMs,lastRunMs,newHitsSinceLastRun,…})` in
  `@muse/memory` (run only when ≥minNewHits material AND ≥minIntervalMs since last run — non-straining;
  10-case battery). fire 11: `planMemoryConsolidationTick(records, state, options)` — the pure
  decide-and-run unit: counts recall records re-engaged since lastRunMs (the new material), gates on
  the brake, and only then DELEGATES to consolidationPlan, returning {ran, plan?, nextState} (lastRunMs
  advanced only when it ran). 7-case battery (incl. plan==consolidationPlan delegation + both brakes).
  fire 12: WIRED into the daemon — `runMemoryConsolidationTick` (sibling fn, testable) reads recall
  hits → planMemoryConsolidationTick → logs promote/fade, registered as a daemon tick next to
  playbookConsolidateTick (MUSE_SELFLEARN_ENABLED-gated, fail-soft, in-closure lastRunMs). Background
  memory consolidation now RUNS on the daemon schedule (brake-gated). fire 16: promotion-PERSISTENCE
  — `runMemoryConsolidationTick` gains an optional `persist` dep; the daemon binds it to the existing
  `promoteRecalledMemories` (idempotent: clears prior PROMOTED_FACT_ + writes the current top-N into
  the persona; non-destructive, never touches real user facts, never outbound) behind a DEDICATED
  opt-in flag `MUSE_SLEEP_PROMOTE` (default OFF ⇒ report-only preserved). So with the flag on, the
  daemon graduates the most recall-useful memories into the always-on persona in the background,
  brake-gated. cli 2520 green (persist-on-brake-pass, not-on-fail/disabled, fail-soft on throw).
  (ACT-R ranking from T2-1 feeds the selection via useActrRanking.) #5 thread COMPLETE.

- ✓→Done **MoA fan-out: no duplicated sub-agent work (dedupe roles by id)** — [2026-06-12, cognition
  loop fire 13, sub-agents #4] `orchestrateAnswer` ran every role as a parallel proposer without
  deduping by id — duplicate-id roles ran a redundant sub-agent (wasted inference) AND yielded dup-id
  proposals that corrupt fire-7's `attributeContributors`/`contributors`. Added pure `dedupeRolesById`
  (first-wins, order-preserving) at the roleList resolution. MAST "no duplicated sub-agent work".
  agent-core 1718 green incl. an integration (2 dup-id roles + 1 → exactly 2 proposals, unique ids).
  DEFAULT_ROLES path unaffected (distinct ids → no-op).

- ✓→Done **MoA fan-out: empty proposer output → failedRoles (failure surfacing)** — [2026-06-12,
  cognition loop fire 14, sub-agents #4] `orchestrateAnswer` kept EVERY fulfilled proposer as a
  proposal, even one returning empty/whitespace text (a degraded sub-agent that didn't throw) —
  polluting the aggregator candidate list + inflating proposals.length. Now a fulfilled-but-empty
  proposal falls into `failedRoles` like a throw (MAST "failure propagation surfaces"). One-condition
  change (`&& outcome.value.text.trim().length > 0`); fail-close/single-survivor/aggregate/onProposal
  unchanged. agent-core 1722 green (empty→failedRoles, whitespace, all-empty fail-close, regression).

- ✓→Done **MoA aggregator failure resilience** — [2026-06-13, cognition loop fire 15, sub-agents #4]
  the proposers run under allSettled (resilient) but the AGGREGATOR call was unguarded — a flaky
  local-model aggregator throw REJECTED the whole orchestration, discarding every successful
  proposer's work. Wrapped `aggregate()` in try/catch → a throw becomes an empty merge → the EXISTING
  fallback returns the best proposal (the "thorough" one). MAST graceful-degradation / don't-lose-
  sub-agent-work. agent-core 1725 green (throws→resolves-with-proposal, empty→fallback, success→merged).

- ✓→Done **Weakness-ledger bounded growth** — [2026-06-13, cognition loop fire 23, Fable-scout
  runner-up] `writeWeaknesses` wrote all rows uncapped (unlike recall-hits' 5000-trim) → the ledger
  grew without bound as novel topic rows accrued. Added `MAX_WEAKNESS_ENTRIES=2000` trim: on overflow
  keep what the selectors surface (count desc, then recency), evict stale one-offs; under the cap =
  verbatim/unreordered. mcp 1683 green; Fable-judge PASS (under-cap order-pin non-vacuous, evictions genuine).

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
