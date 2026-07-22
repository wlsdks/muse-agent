# Self-queueing follow-up

Status: **all 5 steps shipped end-to-end + CLI + MCP loopback.**
Audit finding #25 (Tier 3). The full chain runs in production:

- Step 1 — rule detector (English + Korean) — `extractFollowupPromises`
  in `@muse/agent-core/src/followup-detector.ts`.
- Step 2 — `~/.muse/followups.json` store — `personal-followups-store.ts`
  in `@muse/mcp`. Atomic tmp+rename writes, tolerant reads.
- Step 3 — runtime capture hook — `createFollowupCaptureHook` in
  `@muse/agent-core`, wired into the autoconfigure runtime hook
  stack. Auto-captures from assistant turn output.
- Step 4 — firing engine + daemon — `runDueFollowups` in
  `@muse/mcp` + `apps/api/src/followup-tick.ts` `setInterval`
  rider. LLM-synthesised delivery via the messaging registry.
- Step 5 — LLM-fallback detector + per-day budget. Opt-in via
  `MUSE_FOLLOWUP_LLM_FALLBACK=true`. Budget tracker:
  `~/.muse/followup-llm-budget.json`.
- User surface — `muse followup list|show|cancel|snooze` CLI +
  `muse.followup.{list,cancel,snooze}` loopback MCP tools.

Env knobs that activate the daemon path:
`MUSE_FOLLOWUP_DEFAULT_PROVIDER`, `MUSE_FOLLOWUP_DEFAULT_DESTINATION`,
`MUSE_FOLLOWUP_TICK_MS`, `MUSE_FOLLOWUP_MAX_PER_TICK`,
`MUSE_FOLLOWUP_QUIET_HOURS`.

The opt-in LLM fallback remains an awaited foreground hook: its extracted
promise must be available before the hook persists the turn's follow-ups. It
therefore does not use the fire-and-forget background-review queue. Its daily
call cap remains the controlling budget; changing that latency contract needs
a separate persistence design that can merge late detector results safely.

The text below preserves the original design rationale — kept for
reference even though every step now exists in code.

## Why this matters

When the model says "I'll check tomorrow morning" or "let me remind
you in 30 minutes," nothing actually queues that. The runtime ends
the turn; the promise stays text. The audit's verdict: "The agent is
a request-response oracle, not a self-directed assistant. JARVIS
would need output introspection to auto-schedule follow-ups."

Closing this gap means: the agent's *outbound* messages get scanned
for explicit time-bound promises, those promises become entries in
the scheduler or reminder store, and when the time arrives the agent
re-enters the conversation to honour them.

## Constraints

- **No false promises.** A casual "I'll think about it" is NOT a
  scheduleable follow-up. Detection must lean toward false negatives
  rather than spurious queueings.
- **Privacy.** The scan runs locally on the model output; no third
  party sees the user's conversation.
- **No double-charging.** Promise → scheduled job → agent turn is
  one extra LLM call per honoured promise, not per scan.
- **User vetoable.** A user can `muse followup list` to see queued
  promises and `muse followup cancel <id>` to drop one.

## Detection: rule-first, LLM-fallback

A regex-based first pass catches the canonical English / Korean
shapes:

| Pattern (loose) | Example | Resolves to |
| --- | --- | --- |
| `(in|after) <N> (min(ute)?s?|hour(s)?|day(s)?)` | "in 30 minutes" | now + N |
| `(tomorrow|next <day>) (morning|afternoon|evening)` | "tomorrow morning" | next-day 09:00 (configurable) |
| `at <HH(:MM)?( AM/PM)?>` | "at 3pm" | today at 15:00 (or tomorrow if past) |
| Korean `(내일|N시간 뒤|N분 뒤)` | "1시간 뒤" | now + N |

What the rule pass *doesn't* catch (conditional intent, multi-part
promises) gets a follow-up LLM call against a small extraction
prompt, gated by `MUSE_FOLLOWUP_LLM_FALLBACK=true` (default off; opt-in
because every assistant turn costs an extra round-trip).

## Storage

New `~/.muse/followups.json`:

```json
{
  "version": 1,
  "followups": [
    {
      "id": "fu_…",
      "userId": "stark",
      "scheduledFor": "2026-05-14T00:00:00Z",
      "summary": "Check on the Q3 budget memo",
      "originRunId": "run_…",
      "originTurnHash": "sha256:…",
      "status": "scheduled" | "fired" | "cancelled"
    }
  ]
}
```

`originTurnHash` lets the agent show the user "you said *this* — do
you want me to follow up now?" instead of guessing from scratch.

## Firing path

The existing scheduler tick is the gate. A new daemon module
`packages/scheduler/src/followup-tick.ts` mirrors `reminder-tick.ts`:

1. Every tick (60s default), enumerate scheduled followups with
   `scheduledFor <= now`.
2. For each: re-enter the agent runtime with a small system
   preamble — "Earlier you said you'd <summary>. The user is now
   reachable. Compose the follow-up message you'd send" — plus the
   origin turn for context.
3. The synthesized response goes through the existing messaging
   sink (Telegram/etc) AND the Phase D broker (when it exists, see
   `phase-d-chat-stream-routing.md`).
4. Mark `status: fired`.

## CLI surface

- `muse followup list` — pending + recently-fired followups
- `muse followup show <id>` — full record + origin turn
- `muse followup cancel <id>` — drop, never fires
- `muse followup snooze <id> "tomorrow at 9am"` — bump scheduledFor

## Implementation order (3-4 iters)

1. **Detector (rule-only)** — pure function
   `extractFollowupPromises(text, locale)` returning typed shapes.
   Direct unit test with English + Korean fixtures.

2. **Store** — `~/.muse/followups.json` CRUD with same atomic
   tmp+rename pattern as tasks-store.ts.

3. **Runtime hook** — `afterTurn` hook scans the assistant output,
   writes detected promises to the store.

4. **Firing daemon** — scheduler tick re-enters the runtime,
   composes the message, marks fired.

5. **(opt-in)** LLM-fallback detector — short prompt, structured
   JSON output, behind env flag.

## Anti-patterns to avoid

- Hard-coded message templates ("you said you'd…"). Let the model
  compose the follow-up; we only seed the context.
- Burning context window on the entire origin transcript. Only
  the *one* turn that issued the promise + a short header.
- Re-scanning every assistant message for every detector — short-
  circuit on length thresholds so a one-word "OK" doesn't run the
  rule sweep.

## Out of scope

- Multi-step promises ("I'll do X, then Y, then Z") — first iter
  treats each clause as independent.
- Conversational confirmation ("should I schedule a follow-up?")
  before queueing — initially queue silently and trust the
  `muse followup list` CLI surface for visibility.
