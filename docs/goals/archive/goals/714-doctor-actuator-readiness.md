# 714 — `muse setup status` reports actuator readiness — the biggest recent capability (P11–P17 actuators) was invisible to the setup doctor

## Why

`collectSetupStatusJson` / `muse setup status` reports model, calendar,
notes, tasks, voice, messaging, web-search, user-memory, proactive, and
reminder readiness — but said NOTHING about the gated actuators
(email/web/home), the largest capability added across P11–P17. A user
onboarding had no way to learn from the doctor whether email/home
actuation was wired or how to enable it. That's a real onboarding gap.

## Slice

- `packages/autoconfigure/src/setup-status.ts`: pure
  `readActuatorReadiness(env)` → `ActuatorReadinessSnapshot`
  (`{status, email, web, home, nextStep?}`): web always available;
  email iff `MUSE_GMAIL_TOKEN`; home iff `MUSE_HOMEASSISTANT_URL` +
  `MUSE_HOMEASSISTANT_TOKEN`; status `ok` when any provider-backed
  actuator is wired, else `info`; nextStep lists the missing ones + that
  actuators are opt-in via `muse ask --with-tools --actuators`. Wired
  into `SetupStatusSnapshot.actuators`.
- `apps/cli/src/commands-scheduler-setup.ts`: render
  `actuators — email ✓/✗, web ✓, home ✓/✗` with the nextStep.

## Verify

- `@muse/autoconfigure` setup-status.test.ts (153 tests):
  readActuatorReadiness — no-env → info + both hints + the `--actuators`
  note; MUSE_GMAIL_TOKEN → email ok, status ok, still hints home, no
  longer hints email; HA requires BOTH vars; all configured → nextStep
  dropped.
- **Dog-fooded**: `MUSE_GMAIL_TOKEN=… muse setup status` printed
  `[ok]   actuators — email ✓, web ✓, home ✗` + the home hint.
- `pnpm check`: EXIT=0 (the snapshot shape is shared with the REST/web
  surfaces; adding a field broke nothing). `pnpm lint`: 0/0.
  `pnpm check:capabilities`: ✓.
- No LLM request/response path touched — pure env-driven snapshot +
  renderer.

## Decisions

- **Pure `readActuatorReadiness(env)` helper, tested directly** — mirrors
  the existing `readWebSearchEnvSnapshot(env)` pattern so the readiness
  logic is unit-tested without mutating `process.env` through
  `collectSetupStatusJson`.
- **`web` always true** — the generic gated web action needs no provider
  env; status rolls up on the provider-backed actuators (email/home) so
  a fresh install reads `info` with actionable hints rather than a
  misleading `ok`.
- **Reused the shared SetupStatusSnapshot** — one source of truth for the
  CLI text render and the REST/web JSON, so the doctor surfaces can't
  drift on actuator reporting.
