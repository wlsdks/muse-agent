# 076 — muse trace tail — live-tail recent traces

## Why

In-memory tracing pipeline has a  reader. Add a CLI subcommand
to print recent spans as they're recorded.

## Scope

- New commands-trace.ts with tail subcommand.
- SSE-style from /api/admin/traces?follow=1 OR local store read.

## Verify

- cli + api tests.

## Status

open
