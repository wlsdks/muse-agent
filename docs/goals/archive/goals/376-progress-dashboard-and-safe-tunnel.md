# 376 — Progress dashboard + safe quick tunnel

Category: epic / outward (Presence — the user can see, from anywhere,
what Muse is doing, in plain language)

## Why

The user wants to glance at "what is the loop doing right now?" from
any device, in plain language, without touching the loop PC. A
read-only HTML view, exposed through an outbound-only Cloudflare
**quick** tunnel. Decision (user, 2026-05-18): **quick tunnel,
public-by-URL** — no account, no Cloudflare Access. The URL rotates
on restart, so a frozen link is explicitly given up; instead the
loop keeps the current URL written into `README.md`.

## Non-negotiable threat model

The loop PC must never be put at risk:

- `scripts/dashboard-server.mjs` binds to `127.0.0.1` only. No
  `0.0.0.0`, no inbound port, no port-forward.
- Exactly two routes: `GET /`, `GET /healthz`. Everything else
  404. No file serving, no path params, no writes, no shell, no
  request-derived input to any child process.
- `cloudflared tunnel --url http://127.0.0.1:<port>` is an
  *outbound* connection forwarding only that one local read-only
  endpoint. It opens nothing inbound.
- Public-by-URL is accepted: a visitor sees only the progress HTML
  (open goals + shipped commit subjects). No repo, shell, or other
  service is reachable.

## Slices

1. **Harden + test the server.** Direct unit test for the route
   table (200 `/`, `ok` `/healthz`, 404 everything else incl.
   traversal + non-GET), HTML-escaping test, and `pnpm dashboard`.
   (Server + `pnpm dashboard:tunnel` runner already committed.)
2. **Runner robustness + URL→README.** `scripts/dashboard-tunnel.sh`
   already: checks for `cloudflared` (prints the one-time
   `brew install cloudflared` hint if absent — no account needed),
   starts the server if down, runs the quick tunnel, splices the
   live `*.trycloudflare.com` URL into the `README.md` LIVE_URL
   markers. This slice: make the loop *operate* it — keep the
   tunnel up across iterations and commit the one-line README URL
   change whenever it rotates (only on rotation, not every iter).
3. **Keep it meaningful.** The dashboard renders commit subjects +
   goal `## Status` live, so no per-commit dashboard edit is
   needed — the loop just keeps writing clear subjects/status. Add
   a brief "Live progress" explainer to `README.ko.md` too.

## Verify

- `pnpm check` / `pnpm lint` (0/0) / `pnpm smoke:broad`.
- Server unit test (routes, escaping, localhost-only intent).
- `bash -n scripts/dashboard-tunnel.sh`; dry-run the README splice
  on a temp copy (idempotent between LIVE_URL markers).
- Manual: `lsof -iTCP:<port>` shows `127.0.0.1` (never `*`).

## Status

**CLOSED — human-operated infra. NOT loop work; must not reappear
as a self-generated goal (red-team P3).** The dashboard renders
live from git and needs no per-iteration upkeep. Shipped:
`scripts/dashboard-server.mjs` (127.0.0.1-only, routes + escaping
verified), `scripts/dashboard-tunnel.sh` (quick tunnel + idempotent
README URL splice, syntax + dry-run verified), README LIVE_URL
markers, `pnpm dashboard` / `pnpm dashboard:tunnel`. To expose: a
human runs `brew install cloudflared` once (no account) then
`pnpm dashboard:tunnel`. The loop never commits LIVE_URL/tunnel/
dashboard changes as iteration work.
