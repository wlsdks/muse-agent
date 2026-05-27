# 400 — Situational briefing grounded in real imminent tasks (P8-b3, loop-extended)

## Why

P0–P9 are all delivered + audited. Rather than invent a 11th
epic, this iteration honours the steer ("prefer deepening and
polishing what exists over piling on new surface") by closing a
concrete, observed half-feature in the delivered P8: the
situational-briefing daemon shipped (P8-b2/396) with `imminent`
defaulting to `[]` — so in production it briefed delegated-
objective status ONLY and could never tell the user "submit the
Q3 report — due in 30 min". The P8 docs explicitly flagged
real-imminence as the natural follow-up. The contract permits the
loop to extend bullets toward a stronger outward direction, so P8
is extended with **b3**: ground the briefing in the user's REAL
imminent tasks.

(Also: probed qwen3:8b first to check whether the alternative
deepening — hardening `parseObjectiveVerdict` — was warranted; on
the reasoning-off path qwen3:8b emits clean strict JSON the
current parser handles, so that hardening would have been
speculative gold-plating. Picked the genuinely-justified
deepening instead.)

## Slice

- `packages/mcp/src/briefing-imminent.ts` — `deriveBriefingImminent`,
  a pure deterministic adapter that mirrors
  `runDueProactiveNotices`'s task imminence rule EXACTLY (open
  status, parseable `dueAt`, `proactive !== false`, due within
  `[now, now+leadMinutes]`) → `BriefingImminent[]`; tolerant
  (missing/unreadable store → `[]`).
- `apps/api/src/situational-briefing-tick.ts` — optional per-tick
  `imminentProvider(now)` (imminence is time-relative; a thrown
  provider fails soft to no imminent items, the objective-status
  briefing still goes out).
- `apps/api/src/tick-daemons.ts` — the situational-briefing daemon
  wires `imminentProvider = (now) => deriveBriefingImminent(
  tasksFile, { now, leadMinutes: MUSE_BRIEFING_LEAD_MINUTES })`
  when `options.tasksFile` is set; absent ⇒ unchanged
  objective-status-only behaviour.

## Verify

- `@muse/mcp` briefing-imminent.test.ts 2/2 (open/due-soon/
  proactive selection vs done/past/far/muted/NaN/no-due;
  leadMinutes window; missing store → `[]`).
- `@muse/api` situational-briefing-tick.test.ts 4/4 incl.
  "P8-b3: a real imminent task grounds the briefing's Upcoming
  alongside objective status" — drives the real tick with
  `imminentProvider = deriveBriefingImminent(tasksFile)` + a
  seeded objective over a real `TelegramProvider` HTTP-fake;
  asserts the POSTed briefing contains `Upcoming:` + the task
  title AND `Still tracking:` + the objective.
- `@muse/mcp` 475, `@muse/api` 191; tsc strict clean (ran
  proactively); `pnpm check` green (apps/cli 683, all packages);
  `pnpm lint` 0/0; `pnpm guard:core` clean.
- No request/response (LLM) path touched — deterministic adapter +
  HTTP-faked delivery; no smoke:live applies.

## Status

P8-b3 done. The situational-briefing daemon, when a tasks store is
configured, now grounds its `Upcoming:` in the user's real
due-soon tasks alongside delegated-objective status — a configured
production server finally tells the user what is coming up, not
just what it is tracking. P8 extended `b1, b2, b3`; P8-b3 flipped
`[x]` (— 400); one CAPABILITIES line appended; README backlog row
added.

## Decisions

- Extending P8 with b3 (not a new epic) is the honest framing: it
  closes a concrete, observed limitation of the delivered P8
  (`imminent: []` in production) flagged in P8's own docs — the
  contract explicitly allows extending bullets toward a stronger
  outward direction. Recorded here per that requirement.
- `deriveBriefingImminent` mirrors the proactive loop's task rule
  verbatim so the two surfaces never disagree on "what is
  imminent" — no new imminence semantics invented.
- Per-tick `imminentProvider` (not a static list): imminence is
  time-relative, so it must be recomputed each tick — same reason
  the proactive/objectives ticks recompute per fire.
- Calendar-derived imminence (vs personal tasks) is the natural
  next enhancement and is deliberately NOT bundled — tasks alone
  already make the briefing genuinely useful and the slice stays
  tight.
- `feat(api)`: a new production behaviour (the briefing now
  includes real upcoming items), spanning the @muse/mcp adapter +
  the apps/api tick/daemon wiring.
