# 308 — OpenTelemetry export recorded exceptions but never set ERROR status

## Why

`OpenTelemetryTraceEventSink` (`@muse/observability`) bridges
Muse trace events to a real OTel tracer. On an errored span it
called `span.recordException?.(event.attributes.error)` but
**never `span.setStatus({ code: ERROR })`**. OpenTelemetry
backends (Jaeger, Tempo, Grafana, the OTel collector),
error-rate dashboards, alerting rules, and tail-based sampling
all key on **span status**, not on the presence of an exception
event. So a span for an operation that *failed* was exported
with status `UNSET`/OK — the failure is **silently invisible**
in every status-driven view: error dashboards under-count,
alerts don't fire, and tail-sampling drops the very trace an
operator needs. A telemetry blindspot exactly where observability
matters most.

## Scope

- `packages/observability/src/index.ts`: add an optional
  `setStatus?(status: { readonly code: number; readonly
  message?: string })` to `OpenTelemetrySpanLike` (the Muse-owned
  structural interface — kept decoupled from the `@opentelemetry/api`
  SDK per the adapter rule; `{code,message}` is structurally
  compatible with the real `Span.setStatus`). Optional so a fake
  / partial tracer without it still works.
- `packages/observability/src/observability-tracers.ts`: in the
  error branch, after `recordException`, call
  `span.setStatus?.({ code: 2, message: error })` — `2` is OTel
  `SpanStatusCode.ERROR`. One short WHY comment records why the
  numeric literal matters (the span shows OK without it).

Behaviour-preserving: `setStatus` is optional and only invoked
when an error attribute is present; successful spans and tracers
that don't implement `setStatus` are unchanged.

## Verify

- `pnpm --filter @muse/observability test` — 56 pass. The
  existing OTel-export test's fake span now also captures
  `setStatus`: an errored event asserts
  `{ status: { code: 2, message: "failed" } }` is recorded
  alongside the exception; a **successful** event (no `error`
  attribute) asserts neither `recordException` nor any
  `setStatus` is called and the span still ends. The
  attribute / run.id / span.id / Timescale / Pino export
  assertions stay green.
- `pnpm check` — every workspace green (observability 56,
  apps/cli 563, apps/api 161, all packages). `pnpm lint` —
  exit 0.
- No real-LLM request/response path touched (telemetry export to
  an OTel-compatible tracer). A live Qwen run cannot exercise
  OTel span-status semantics, so the deterministic fake-tracer
  test is the rigorous verification — same stance as the
  telemetry goals 280 / 284.

## Status

done — an errored span exported through the OTel sink now
carries `SpanStatusCode.ERROR`, so failures are visible to
status-driven dashboards, alerting, and tail-sampling instead of
appearing OK. Successful spans and non-`setStatus` tracers are
unchanged.
