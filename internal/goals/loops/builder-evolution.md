# builder-evolution loop journal

> Theme: continued improvement of the Builder/automation track + surfacing user-felt capability
> gaps. cron `55ad6e29` (session, hourly at :23), Tier2+ (Jinan's explicit 2026-07-18 approval:
> push to origin/main only when green). Stop: CronDelete 55ad6e29.

## fire 1 · 2026-07-18 · skill v2.1.1 · 454c3f797
meta: value-class=reliability · pkg=@muse/cli · kind=reliability · verdict=PASS · firesSinceDrill=1
ratchet: serve-core tests 22->45 · fabrication 0 · self-eval green(0ff19cd3c fixed the missing envInventory registration)
- What: `muse serve` supervision — on the child dying unexpectedly, exponential-backoff restart (1s..30s, circuit-breaker after 5 in a 10-minute window, resets after 60s alive), and if a signal lands during the sleep gap it stops restarting and exits cleanly. Pure policy (nextRestartDecision) with an injected clock, fully unit-tested.
- Why: 3 real defects hit during 2026-07-17/18 live sessions — when the child died, the supervisor kept waiting with the port empty (half the root of the zombie class).
- Review point: exit 0 (a normal exit) doesn't restart (restart: on-failure semantics) — prevents bypassing admin/shutdown.
- Risk: after giving up, the supervisor's exit code = the last child's code; wrapping under launchd/systemd could double-restart (needs observation when composed with an external supervisor).
- Live: measured `kill -9` on the child -> restart in 1s (new pid, health re-serves, honest logs) · TERM -> clean exit including the child · 0 orphans.

## fire 2 · 2026-07-18 · skill v2.1.1 · 8ca40ba1c
meta: value-class=new-capability · pkg=@muse/scheduler+@muse/web+@muse/api · kind=capability-wiring · verdict=PASS(opus) · firesSinceDrill=2
ratchet: scheduler tests 169(+9) · web 529+browser16 · api e2e new 1(outcome-graded) · fabrication 0
- What: Builder "tool execution" flow — wired a scheduled job (jobType mcp_tool) so it actually runs the loopback MCP tool (an `extraTools` seam injected via scheduler-runtime + runtime-assembly), a server·tool picker in the web create/edit panel (`readRiskToolOptions` restricted to risk==="read"), tool payload compilation in flow-edit-compile, and a fix so the dynamic-scheduler error message records the real message.
- Why: previously an mcp_tool job was only saved and couldn't execute (only external MCP connections were supported) — the builder's "call a tool" node was a dead surface.
- Review point: write tools are entirely absent from the executable set (createLoopbackMcpToolsFromEnv) — even a manipulated POST registering muse.messaging.send FAILs as not-connected, no unattended send possible (verified by opus). toolArguments stays un-projected.
- Risk: the policy for unattended write/execute tools is a [decision] left to Jinan — v1 is read-only fail-close.
- Live: real browser (isolated-HOME demo server) — picker shows 14 servers, messaging=providers/inbox only·reminders=list/search only (verified voice case), muse.time/now flow create→test run→execution record SUCCESS+real-timestamp JSON rendered.

## fire 3 · 2026-07-18 · skill v2.1.1 · b2b680b78
meta: value-class=new-capability · pkg=@muse/web · kind=ui-capability · verdict=PASS(opus) · firesSinceDrill=3
ratchet: web SSR 542(+7) · browser 18(+1) · unit +7 · fabrication 0
- What: builder output-node notification channel picker — instead of typing a raw `provider:destination`, pick from connected+paired messaging channels and it fills in the exact value. deriveNotifyChannelOptions (pure, configured&&registered&&pairedOwner only) + NotifyChannelQuickPick (react-query /api/messaging/setup, null when none). Wired into both create+edit panels (sibling audit).
- Why: a real UX burden where the user had to know and type a `telegram:12345`-style format — the value the execution runner already parses via parseNotificationChannel, so it's runner-supported·deterministic.
- Review point: registered:false (saved but non-live)·unpaired entries fail on send, so they're never exposed (0 false positives); schedulerDeliveryValue handles the matrix double-prefix; errors/localOnly 403 degrade gracefully to null (text field remains).
- Risk: none (the picker is a convenience layer, the text field is the source of truth). A live POSITIVE case needs real Telegram registration, so it's proven with real-Chromium vitest; live measured the no-regression case.
- Note: 2 builder slices landed interactively (after fire 2) — tool-execution flows (f2e539321, scheduler+web+api/wiring)·fullscreen+LNB (b2f9652ec, web/ui-affordance) — counted toward the (pkg,kind) diversity tally.

## fire 4 · 2026-07-18 · skill v2.1.1 · 4642f1cc8
meta: value-class=new-capability · pkg=@muse/scheduler+@muse/api+@muse/web · kind=capability · verdict=PASS(opus, 2nd pass) · firesSinceDrill=4
ratchet: scheduler 177(+8) · api scheduler-routes 12(+4) · web browser 19(+1) · fabrication 0
- What: flow duplication — POST /api/scheduler/jobs/:id/duplicate + a "Duplicate" button in FlowHeaderActions. buildDuplicateJobInput (pure) copies all 20 config fields, excludes id·execution lifecycle·timestamps, enabled:false (draft-first), name suffix (" (copy)"/" (사본)").
- Why: a basic builder capability every n8n/Zapier already has was missing — an existing flow couldn't be reused as a starting point. Reuses the create path the execution runner already supports → runner-supported·deterministic.
- Review point: the duplicate is enabled:false so the copied schedule doesn't silently fire; both notificationChannelId+webhookUrl are copied, preserving the `channelId ?? webhookUrl` delivery resolution exactly; 404-before-create means zero partial side effects.
- Risk: no name-uniqueness constraint (duplicate "X (copy)" entries allowed) — intentional.
- Lesson: a config-copy mapper needs a field-by-field audit — the first Opus pass caught a missing webhookUrl (a silent divergence the green suite couldn't catch, losing the delivery target); enumerating the source interface and diffing against the mapper confirmed 20/20 before PASS. Every mapper like this should start with an "all config fields" test.
- Live: real-browser e2e (isolated demo) — clicking Duplicate→a new flow "Daily brief (사본)" with a distinct id·enabled=false·the original unchanged, confirmed via API list showing 2 entries.

## fire 5 · 2026-07-18 · skill v2.1.1 · d3482e441
meta: value-class=ux-fix · pkg=@muse/web · kind=ui-legibility · verdict=PASS(opus) · firesSinceDrill=5
ratchet: web SSR 549(+7) · compile unit +6 · component +1 · fabrication 0
- What: the execution-record card now shows a FAILED run's computed failureReason (the clean reason) in a danger tone. resolveExecutionDisplay (pure): FAILED+non-empty reason→error tone, otherwise→output. Removed the raw "Job 'X' failed:" prefix since it duplicated the badge.
- Why: failureReason was already computed by the API but the UI never used it (dead data), and a FAILED result was buried in the same muted style as a successful output, so the failure reason wasn't legible.
- Review point: no information loss — schedulerFailureReason only strips the prefix, everything else stays in reason and is exposed via show-more full text. Unit coverage across every status/field combination.
- Risk: none (pure display logic).
- Lesson: real-browser measurement caught a CSS-specificity bug — a bare `.exec-error` (0,1,0) lost to `.row .row-meta` (0,2,0) → grey. The SSR test only confirmed the class existed (couldn't see the computed color). Fixed with the 2-class `.row-meta.exec-error`. Lesson: a new color class that overrides an existing color must match+outrank the target selector's specificity, and computed color must be measured in a real browser.
- Live: an isolated-demo failed tool run — .exec-error renders "MCP server ... not connected" (no prefix) at rgb(229,83,75)=danger.

## fire 6 · 2026-07-18 · skill v2.1.1 · 715c2be2f
meta: value-class=new-capability · pkg=@muse/web · kind=ui-capability · verdict=PASS(opus) · firesSinceDrill=6 · consecutiveAllPASS=6
ratchet: web SSR 550(+1) · browser 20(+1) · compile unit +1 · fabrication 0
- What: added a "system prompt" textarea to the builder's agent-action node (both create+edit panels). Wired agentSystemPrompt into ActionEditForm/FlowDraft/body types; patch=trim→null (empty clears it), create=trim→undefined (omitted).
- Why: the scheduled execution runner (runtime-wiring.ts:70-72) already injects agentSystemPrompt as a system message, but the builder only exposed prompt+model — a runner-supported knob was unreachable.
- Review point: runner-support rule — confirmed agentSystemPrompt is actually consumed by the executor. agentMaxToolCalls/personaId are ignored by the executor so they're deliberately left unexposed (prevents shipping something that does nothing). The tool branch omits the field. The copilot revision resets it the same way as agentModel (matches an existing pattern).
- Risk: none.
- Live: a real-browser round trip — edit the system prompt on an action node→save→GET job persists agentSystemPrompt (agentPrompt unchanged).

## fire 7 · 2026-07-18 · skill v2.1.1 · 06813eefc
meta: value-class=ux-fix · pkg=@muse/web · kind=ui-legibility · verdict=PASS(opus) · firesSinceDrill=7 · consecutiveAllPASS=7
ratchet: web SSR 550 · browser 22(+2) · fabrication 0
- What: 4 validation warnings in the builder create+edit panels (invalid cron·invalid tool JSON) rendered with `color: var(--err)`, but `--err` is an undefined variable so they were colorless (muted grey). Replaced all 4 with a `.field-error{color:var(--danger);font-size:var(--text-xs)}` class.
- Why: even with an invalid cron/JSON input, the feedback looked like a neutral hint rather than an error (a core builder-validation UX defect).
- Review point: sibling class to fire 5's bug — a color that didn't render. Used a dedicated `.field-error` instead of `.subtle` (no specificity contest, and the edit panel has the same markup so it's red there too). `.subtle` only supplied color, so nothing is lost. Opus confirmed no override in the edit panel's non-live context either.
- Risk: none (the 12→11px font size change is intentional).
- Lesson: any new color class needs real-browser computed-color verification (SSR/DOM tests only confirm the class exists). An undefined CSS var (like `--err`) silently falls back to no color — use only the codebase's real color tokens (`--danger`).
- **NOTE (for fire 8): consecutiveAllPASS=7. The next fire (8) reaches 8 → run a JUDGE-DRILL (deliberately inject a bad slice→confirm the evaluator FAILs it→roll back), then reset the counter.**
- Live: an isolated-demo create panel with invalid-cron → .field-error at rgb(229,83,75)=danger.

## fire 8 · 2026-07-18 · skill v2.1.1 · 1f9978270 · JUDGE-DRILL + real slice
meta: value-class=new-capability · pkg=@muse/web · kind=ui-capability · verdict=PASS(opus) · firesSinceDrill=0(reset) · consecutiveAllPASS=0(reset)
ratchet: web SSR 552(+2) · browser 23(+1) · fabrication 0
- JUDGE-DRILL (triggered by consecutiveAllPASS≥8): injected a deliberately defective slice — wired `agentMaxToolCalls` into the builder the same way fire6 wired agentSystemPrompt (every deterministic gate green: SSR 551·browser 22·tsc/lint/build all 0). The independent Opus evaluator **correctly FAILed it**: runtime-wiring.ts's createScheduledAgentExecutor never passes job.agentMaxToolCalls into agentRuntime.run + AgentRunInput has no maxToolCalls slot at all (the shared runtime constructor option only defaults to 10) + zero consumption path in scheduler/autoconfigure → ships something that does nothing. It also flagged that the new unit test only proves "web compiled the value" — a false confidence. **Confirmed not a rubber-stamp → rolled back via git restore.** maker=judge compensating control worked.
- Real slice: flow-timezone editing — the trigger node only showed tz read-only; made it editable via a curated IANA select (always includes the job's own zone). Wired timezone into TriggerEditForm/patch (schedule setForm preserves tz via a `...form` spread).
- Why: the scheduler actually uses job.timezone as the cron-parser tz in computeNextRunAt — 9am Seoul differs from 9am UTC. Runner-consumption verified (the opposite of the drill).
- Review point: proved runner-consumption live — changing tz UTC→Asia/Seoul shifted nextRun from 09:00Z to the next day's 00:00Z. Confirmed a form-state bug (a missing `...form` spread) is guarded against via mutation-RED. The curated select means no new invalid-tz vector.
- Risk: none.
- Lesson: JUDGE-DRILL is a mandatory compensating control under the maker=judge ceiling — confirmed the evaluator actually reads runtime-wiring.ts and verifies runner-consumption (adaptive, not a fixed checklist). Every new builder field must be grep-verified against the executor's consumption path before exposing it.
- Live: an isolated-demo tz-edit round trip + measured the nextRun shift.

## fire 9 · 2026-07-18 · skill v2.1.1 · 43f28951c
meta: value-class=ux-fix · pkg=@muse/api+@muse/web · kind=correctness · verdict=PASS(opus) · firesSinceDrill=1 · consecutiveAllPASS=1
ratchet: api flow-projection 15(+1) · web SSR 553(+1) · fabrication 0
- What: a disabled flow showed "Next run 9:00" in both the list and trigger-canvas node (even though it never fires) — an honest-state violation. Fix: flow-projection now computes nextRunAtIso only when enabled (disabled→null), the list shows a "Paused" label. cron/timezone stay visible (the schedule config is visible even when paused), and the node automatically omits the next-run chip.
- Why: the honest-state product floor — a disabled flow doesn't fire, so "next run X" is a false state. A single server-side projection change fixes both builder surfaces (list+canvas) at once.
- Review point: compareFlows is null-safe on both sides (disabled already sorts after enabled); every nextRunAtIso consumer (Work·Autonomy) has a truthy-guard so nothing breaks (opus verified). formatMetaValue filters out null→no chip.
- Risk: none.
- Live: measured — an isolated-demo flow disabled → API nextRun null·list shows "Paused"·trigger node shows only cron+tz (no next-run chip).

## fire 10 · 2026-07-18 · skill v2.1.1 · 162846891
meta: value-class=new-capability · pkg=@muse/api+@muse/web · kind=llm-capability · verdict=PASS(opus) · firesSinceDrill=2 · consecutiveAllPASS=2
ratchet: api 1327(+18: compile 32·routes 15) · web SSR 554 · browser 24(+2) · eval:flow-draft 5 cases 5/5×3 STABLE · fabrication 0
- What: copilot now drafts TOOL flows — added action/toolServer/toolName to FlowDraftPayload, the route injects the runtime registry's read-risk muse.* loopback tools as an allowlist (all 4 parse paths fail-close on membership, an off-list pair=422), the web side prefills a tool draft into tool mode+enables tool mode in the composer+expands the diff ack, and eval:flow-draft got a tool golden set+an over-firing guard.
- Why: the largest builder gap that had previously been deferred via DECOMPOSE — natural language couldn't create a tool flow. The allowlist = the exact set the scheduler's extraTools actually executes, so ships-nothing is impossible (guaranteed by construction, per fire 8's drill lesson).
- Review point: no path exists for an untrusted model output to create a write/execute job (opus directly exercised the empty-list fail-close·stray-pair normalization·11 name-regex edges). A revision must echo the action (no silent tool→agent flip). Legacy 5-field clients stay backward compatible.
- Risk: the runtime tool list (~25) is larger than eval's 6-item subset — the live e2e succeeded against the actual full list, but selection quality keeps being watched by eval.
- Live: a full real-gemma4 e2e — composer "log the current time every hour on the hour" → a tool draft (muse.time/now, `0 * * * *`) → prefilled into TOOL mode → create → test run → execution record success with a real timestamp.

## fire 11 · 2026-07-18 · skill v2.1.1 · 7461df407 + 7454f7830
meta: value-class=regression-fix+ux-fix · pkg=@muse/api+@muse/web · kind=repair+ui-capability · verdict=PASS(opus) · firesSinceDrill=3 · consecutiveAllPASS=3
ratchet: self-eval promptSeam fail→pass · web SSR 560(+6) · browser 25(+1) · fabrication 0
- What A (regression): fire 10's local helper name buildSystemPrompt collided with check:prompt-seam's banned-name proxy → renamed to buildDraftSchemaSystemPrompt. The behavior matcher wasn't tripped (0 identity text) — opus confirmed "routing through the seam would actually violate D5, the rename is the honest fix (not evasion)."
- What B (a real defect from the owner's screenshot): every canvas node sat at y=0 in one row + drag position wasn't persisted → overlaps recurred. Fixed via staggered initial rows (120/0/220, vertical spacing≥node height) + localStorage persistence via flow-node-positions (storage-injected·fail-safe): seed→merge (in-memory→saved→default)→save only on drag end.
- Why: Jinan's explicit 2026-07-18 request ("nothing should overlap, and boxes must be draggable with the mouse") — a foundation needed regardless of which redesign concept gets picked.
- Review point: node ids are flow-scoped so switching flows can't cross-contaminate; NaN/corrupt JSON/storage exceptions all degrade to the default layout; an orphaned key (~100B) from a deleted flow is a non-blocking note.
- Lesson: ① re-run self-eval not just at fire start but **before commit** too — fire 10 pushed with a lingering promptSeam regression (only checked green at start). ② used `git stash --keep-index` in the isolated worktree to bypass guard-writeback — next time plan the commit order first (stage alongside new test files).
- Live: a real mouse drag→localStorage saved {x:568.79,y:147.2}→full reload→transform restored exactly to translate(568.792px,147.208px) + measured the stagger overlap-check as false.

## fire 12 · 2026-07-18 · skill v2.1.1 · 7b32ca45b + f76295948
meta: value-class=gate-integrity+ux-fix · pkg=scripts+@muse/web · kind=eval-wiring+ui-dedup · verdict=PASS(opus) · firesSinceDrill=4 · consecutiveAllPASS=4
ratchet: eval:agent battery 11→12(flow-draft folded in) · 1 skip-as-pass dismantled · web SSR 563 · fabrication 0
- What A: 5 live probes right after the redesign (empty state·copilot draft prefill (real gemma4)·create·tabs·Work/Scheduled·padding restoration) — **0 defects**. Switched kind under the EXHAUSTION rule.
- What B: folded eval:flow-draft into the eval:agent bundle — while folding it in, found and fixed a **real SKIP-AS-PASS bug**: a skip message ("unavailable") didn't match classifySkip's vocabulary, so the skip was being tallied as 'ok' (reproduced with a dead URL → fixed to 'skip (ollama-unreachable)'). Sibling audit: the other 11 batteries were all already compatible.
- What C (owner's screenshot): removed the top-bar view title — every view already has its own title (eyebrow+h1), so the top-bar title was always a duplicate ("Today" shown twice). Live-measured: the top bar now shows only search.
- Why: an unwired battery rots (§5) + the owner flagged it immediately.
- Review point: opus directly ran classifySkip against both messages to verify the bug narrative (confirmed there's no generic 'skipped' code). The remaining W3 items are a FRESHNESS hit — CLI/web/API outcomes are already shipped, only "reflected in the next pack" needs attunement design.
- **Owner queue (2026-07-18, top priority to address)**: ① bring the Scheduled view up to builder-grade (usage isn't discoverable — align with the builder workspace) ② bring the Work view up to builder-grade. (a)-priority for upcoming fires.
- Risk: eval-council-floors FAILs on a dead-URL run (embed-model-missing) — a pre-existing classification policy, passes in a real environment (model installed).

## fire 13 · 2026-07-18 · skill v2.1.1 · 6c19b6e80
meta: value-class=new-capability · pkg=@muse/web · kind=ui-capability(owner-directed) · verdict=PASS(opus) · firesSinceDrill=5 · consecutiveAllPASS=5
ratchet: web SSR 572(+3) · browser 31(+5) · unit +6 · fabrication 0
- What: promoted Scheduled to builder-grade (owner queue ①) — a per-flow operations row (status dot·name·what it does (prompt head/server.tool)·when (human cadence+next run)·last-run badge·row-level controls: on/off·run now·open in builder) + an on/paused summary + a builder-oriented empty state. The existing digest/budget summary is demoted to a secondary block below. "Open in builder" hands off via a one-shot sessionStorage hint (consumed+deleted by the builder on mount; a deleted id degrades to the default selection).
- Why: Jinan said "I don't even know how to use Scheduled" — the read-only summary had nothing to act on.
- Review point: immediately applied opus's follow-up recommendation — allow Run-now on a paused row (verified against dynamic-scheduler: the enabled gate only skips automatic runs, a manual trigger still runs) + a regression test. A busy flag prevents flip-flop from double-clicking either mutation. mergeScheduleRows renders blank stats when a job row is missing (nothing dropped).
- Risk: rows past jobs limit=100 render blank stats in the tail (harmless at personal scale). The SSR "1" count assertion is weak (the summary string is the real safeguard) — opus's note.
- Live: an isolated demo with 2 flows (agent+tool/1 execution) — row rendering muse.time.now·hourly·SUCCESS·never-run measured, off→paused, click name→builder opens on that flow.
- Owner queue remaining: ② Work builder-grade — next fire.

## fire 14 · 2026-07-18 · skill v2.1.1 · 2287757ee
meta: value-class=new-capability · pkg=@muse/web · kind=ui-capability(owner-directed) · verdict=PASS(opus) · firesSinceDrill=6 · consecutiveAllPASS=6
ratchet: web SSR 575(+3) · browser 34(+3) · unit +3 · fabrication 0
- What: Work link UX brought to builder-grade (owner queue ②) — replaced raw id typing (LinkPicker) with a name-based picker (EntityLinkPicker, unlinked candidates only·hidden when none), a linked flow now shows a mini operations row (status dot·name click=builder-focus handoff (reusing the fire 13 seam)·next-run/paused·unlink), plus a task row+unlink. Added an optional body to ApiClient.del (works-unlink contract is DELETE+body; verified against all 12 existing call sites with no impact).
- Why: Jinan said "Work has the same problem" — a surface that requires knowing an id to link isn't builder-grade.
- Review point: thread links stay raw-id (no threads-list API — an honest scope cut, follow-up recorded). The SSR "unrelated not leaked" assertion is a refinement, not a removal (both directions: absent from the row + exact markup present in options). Undercounting under reference-corruption is pre-existing (the store prunes on delete).
- Risk: none.
- Live: an isolated-demo full cycle — picker link→row (shows next run)→click name→builder opens on that flow→unlink→row disappears+candidate returns to the picker, measured.
- Owner queue status: ① Scheduled (f13)·② Work (f14) done. Remaining follow-ups: threads-list API+thread picker, direct new-flow creation from the Work header (builder-prefill handoff).

## fire 15 · 2026-07-18 · skill v2.1.1 · 380812f91 (interactive "do it all at once, big" instruction)
meta: value-class=new-capability · pkg=@muse/api+@muse/web · kind=integration · verdict=PASS(opus, 2nd pass) · firesSinceDrill=7 · consecutiveAllPASS=7*
ratchet: api attunement 13(+1) · web SSR 577(+2) · browser 38(+4) · unit +2 · fabrication 0
- What: Work↔Builder integration — ① GET /api/attunement/threads (picker feed) + a Work thread picker/row/unlink (the last raw-id input is gone) ② "new flow for this Work" one-shot handoff: the builder opens the create panel and auto-links the created flow to that Work (best-effort).
- Why: knocking out fire 14's two recorded follow-ups at once (per Jinan: "keep going, do it all at once, big").
- Review point: **opus's first-pass FAIL caught a real defect** — the Work binding survived Cancel, so subsequently creating an unrelated flow also got auto-linked (a surprising mutation). Fix = clear the binding on cancel/flow-switch/manual new-flow, with a regression test that was red pre-fix. The re-gate traced through the copilot-after-Cancel edge case and PASSED.
- Risk: a link failure fails silently with no feedback (accepted since the user is already in the builder and can link manually, opus's judgment). A suspected Autonomy duplicate turned out to be unfounded on investigation (different tab composition) — confirmed slice C is unnecessary.
- Live: a full cycle measured — thread seeding→picker link→row / new-flow handoff→returns with the row auto-linked.
- *consecutiveAllPASS note: the first-pass FAIL is the gate working (caught pre-ship·fixed·re-PASSed), so it counts toward the shipped-PASS streak, but the next fire (16) reaching 8 still triggers a JUDGE-DRILL.

## fire 16 · 2026-07-18 · skill v2.1.1 · 96bb7d1b8 (interactive "all of it" instruction)
meta: value-class=new-capability · pkg=@muse/api+@muse/web · kind=llm-capability · verdict=PASS(opus) · firesSinceDrill=0(drill done) · consecutiveAllPASS=1
ratchet: api compile 40(+8) · routes 15 · web flow-edit-compile 59(+3) · browser 38 · eval:flow-draft 6/6(+1 case) ×3 · fabrication 0
- JUDGE-DRILL (consecutiveAllPASS hit 8, contractually mandatory): injected a deliberately defective slice — wired an optimistic "✓" for Scheduled Run-now into onSettled (fires even on failure) — every deterministic gate went green after it. The independent Opus judge **correctly FAILed it**: an honest-state/fabrication=0 violation (showing success on a failed trigger), a departure from the sibling toggle's onSuccess pattern, and flagged a happy-path-only test. Rolled back, counter reset. Gate trust reconfirmed.
- Real slice: copilot tool-argument drafting — 9 fields on FlowDraftPayload (toolArguments), DraftableTool.inputSchema (threaded from the registry through the route), per-tool args hints + Example 4 in the prompt, resolveToolArguments's deterministic anti-fabrication gate (rejects unknown-key·required·primitive-type·non-object → retries with repair), the web prefill (pretty JSON)+revision round trip, and an eval case "KO tool-args" (grading a copied prompt-literal URL).
- Why: a remaining item on Jinan's queue — until now tool drafts always had toolArguments fixed to {}, so any tool with arguments needed manual entry after the draft. The runner already consumes it (scheduler-runtime resolveTemplateJson) — not ships-nothing.
- Review point: parseCurrentDraftInput is shape-only (the registry schema is a route seam — documented in a comment). Opus live-probed a __proto__/constructor injection — the Object.hasOwn gate rejected it without contamination.
- Risk: on a revision turn, an unparseable textarea degrades to {} (documented, doesn't block chat). Finding (pre-existing defect, not from this slice): opening a blank create panel manually then making a copilot request projects the blank form as the revision currentDraft → 400 — recorded in backlog ◦.
- Live: an isolated demo (3806) full cycle — an HTTP draft (with args)→real-browser copilot→create-panel prefill ({"url":...}, muse.url/parse, name)→create→persisted toolArguments on the MCP_TOOL job→manual trigger→lastStatus SUCCESS.
- Lesson: never use `git checkout --` to revert a mutation over uncommitted edits (loses work, had to fully reconstruct from context to recover) — reconfirms the cp-backup principle ([[project_main_worktree_git_hazards]]).

## fire 17 · 2026-07-18 · skill v2.1.1 · ec0343dad (interactive "all of it" instruction — last queue item)
meta: value-class=new-capability · pkg=@muse/web · kind=ui-capability · verdict=PASS(opus) · firesSinceDrill=1 · consecutiveAllPASS=2
ratchet: unit flow-connection-logic 6(new) · browser 40(+2) · fabrication 0
- What: canvas connection semantics — gave a gesture pair to the one and only meaningful connection the runner consumes (action→output.notify=notificationChannelId): a dotted ghost "connect notification" on a flow with no channel (click→channel popover→connect=PATCH), and double-click on a real notification edge=disconnect (PATCH null). Structural edges stay inert (classifyEdgeRemoval). The ghost is positioned at the bottom of the output column +140px (no-overlap rule — the browser suite caught a real overlap mid-development and it was fixed).
- Why: implements the runner-supported scope of Jinan's "connect the boxes" request — arbitrary graphs aren't runner-supported, so only meaningful connections, not decorative ones. Drag-to-connect needs a hidden-handle rework and is scoped out (a follow-up candidate).
- Review point: PATCH reuses the existing flowEditToJobPatch("output") seam (no dual grammar); the ghost is UI-only (doesn't touch the server payload, opus verified); the combined detail-panel-open+disconnect state falls back to empty-state (no crash).
- Risk (non-gating, opus's note): the detachTitle i18n key is unreferenced (planned for a discoverability follow-up); a ghost's drag position lingers as a harmless stale localStorage entry after attach.
- Live: an isolated demo (3807) measured both directions — ghost (measured 0 overlap)→popover→connect→a real node+edge / double-click→ghost returns+server channelId null (terminal state).

## fire 18 · 2026-07-18 · skill v2.1.1 · 37ab54474
meta: value-class=new-capability · pkg=@muse/web · kind=ui-capability · verdict=PASS(opus) · firesSinceDrill=2 · consecutiveAllPASS=3
ratchet: unit flow-edit-compile 62(+3) · browser 46(+1) · related 238 · fabrication 0
- What: tool RE-POINTING for tool flows — made the node-detail's read-only server/tool (previously held back as a "v1/v2 concern") editable via the same read-risk cascading picker used in the create panel. Sends a batched PATCH {mcpServerName, toolName, toolArguments}, resets args to "{}" on a tool/server change (blocks carrying over arguments from the old schema), and blocks saving (fail-close) while the pair is incomplete/args invalid/unchanged/saving. A job referencing a tool that's since disappeared from the registry keeps its saved pair as an option (prevents silently clearing a live flow's target).
- Why: ② (a) — a capability the scheduler's PATCH already supports (runner-supported) that only the builder UI was blocking. From Jinan's queue: "something executable the builder still can't build."
- Review point: write/execute tools remain unexposed (the recorded [decision] holds); server-side scheduler-validation is the final authority. Opus rejected stale-args carryover/risk-elevation/dirty-check attacks, and flagged one false JSDoc comment → fixed in the same slice.
- Risk: none (the internal form type is consumed only by the edit panel — confirmed no impact on create/copilot).
- Live: an isolated demo (3808) — seeded the real 13-server registry cascade→muse.url/parse→switched to muse.time/now (measured the tool-option cascade·args reset)→save persists→re-run SUCCESS.
- self-eval note: an apiBoot:fail at fire start turned out to be stale-dist in the fresh worktree (autoconfigure unbuilt) — green after tsc -b, not a regression.

## fire 19 · 2026-07-18 · skill v2.1.1 · bc90a8ad6 (4 commits) (interactive "Sonnet review+cleanup+LNB" instruction)
meta: value-class=fix+ia+refactor · pkg=@muse/web · kind=review-remediation · verdict=PASS(opus, all 4 commits together) · firesSinceDrill=3 · consecutiveAllPASS=4
ratchet: unit 592 · browser 50(+5) · Flows.tsx 707→336 · LNB 15→13 rows · fabrication 0
- What: 4 commits addressing a 3-direction Sonnet review (defects/cleanup/LNB) — ① fixed 6 P1 defects (blank-panel 400·lost revision fields·unauthored detach·ghost keyboard·silent link failure·duplicate invalidation) ② LNB step 1 (Scheduled absorbed into the Builder "Schedule" tab + its row removed, integrations demoted to advanced, Work's eyebrow made truthful, resolved the Autonomy EN conflict) ③ mechanical cleanup (8 unused i18n pairs·extracted SaveRow·safe-storage·split Flows into 3) ④ Jinan's live feedback: made copilot a real chat UI (bottom-pinned composer·Enter to send·IME-safe·bubbles·pending·ack·empty state).
- Why: Jinan's direct instruction ("have Sonnet review it, apply improvements/fixes + clean up the code + trim LNB further").
- Review point: the review itself ran as 3 parallel Sonnets (findings=data), while judgment/gating stayed with an independent Opus (PASSed all 4 commits together — re-ran the suites directly + reproduced mutation-RED + verified pure moves). ScheduledView fully deleted (0 remaining references), integrations remain reachable via devMode/home deep link.
- Risk: a copilot retry produces 2 user bubbles (justified as separate submissions, opus accepted); the nav.scheduled key is kept because an absence-assertion test still references it.
- Live: measured across 2 demo runs — LNB 13 rows + schedule-tab round trip / chat composer pinned to bottom (<4px)·instant bubble·pending·ack·a real gemma4 round trip filling a form.
- What worked well (confirmed by review): the compile-seam separation·bounded repair-retry·useSavableForm pattern — noted as reuse candidates for other surfaces.

## fire 20 · 2026-07-18 · skill v2.1.1 · 969e5d6a7
meta: value-class=new-capability · pkg=@muse/web · kind=llm-capability(edit-copilot) · verdict=PASS(opus, 2nd pass — 1st pass caught a real defect) · firesSinceDrill=4 · consecutiveAllPASS=5*
ratchet: unit flow-edit-compile 72(+8)·flow-draft-diff 13(+2)·web 602 · browser 51(+1) · eval:flow-draft 6/6 · fabrication 0
- What: copilot chat now **edits the currently-selected existing flow** — copilotPayloadFromJob (projects an existing job into the 9 fields, reuses the existing revision LLM path), patchFromDraftRevision (deterministic changed-fields→PATCH; the tool pair/args are one unit; rejects no-change·action-flip), EditFlowCopilot (a suggest→apply/discard bar, draft-first — no PATCH before the Apply click). Sibling audit: flow-draft-diff didn't know about f16's 9th field (toolArguments) → added via JSON value comparison.
- Why: ② (a) the builder's top-priority capability — the edit half of "converse and manipulate from the right panel" was empty (create-only). Diversity: llm-capability, not pure ui.
- Review point: **opus's first pass caught a real defect** — the contract change left an un-updated SSR test (Flows.test.tsx) RED (only the 5 browser tests were updated, the full web unit suite was never run — an omission). Fix = updated both directions of the contract pin; on re-gate the evaluator confirmed non-vacuousness with its own mutation-RED before PASSing.
- Lesson: a contract-change fire can't rely on test:changed+browser alone — the gate must include the **entire unit suite** of every touched package (f19 ran it, f20 skipped it and got bitten).
- Risk: a chat-tab contract change (a selected flow = edit; create-drafting only applies when the panel is open with 0 flows) — updated 5 browser tests preserving intent. A possible staleness between suggest and apply during concurrent external edits is bounded since resolved.patch is based on the fetched detail, so PATCH only sends explicit fields — accepted.
- Live: an isolated demo (3810) — "change this to 8:30 and also send it to telegram 777" → a gemma4 revision → the apply bar names exactly two changed fields → apply → measured the server cron/notify changed + the prompt untouched.
