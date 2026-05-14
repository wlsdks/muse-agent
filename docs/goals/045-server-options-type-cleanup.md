# 045 — Trim apps/api/src/server.ts ServerOptions block (565 LOC)

## Why

server.ts is just over the 700-LOC threshold (565 actually). The
ServerOptions interface is ~150 LOC of optional fields. Extract to its
own types module so the registrations have more breathing room.

## Scope

- New apps/api/src/server-options.ts with ServerOptions + nested types.
- server.ts imports the type only.

## Verify

- All gates green.

## Status

open
