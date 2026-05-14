# 074 — Notes index rebuild on schema bump

## Why

notes-index.json carries a 'version: 1' field. If the schema changes,
the existing index is silently wrong. Detect mismatch + rebuild.

## Scope

- Read commands-notes-rag.ts.
- On schema mismatch, log + rebuild.

## Verify

- cli +1 test.

## Status

open
