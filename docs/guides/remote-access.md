---
title: Using Muse from your phone (remote access via Tailscale)
audience: [users]
purpose: One `muse remote enable` to open the Muse web UI from your own Tailscale devices — without exposing it to the public internet
updated: 2026-07-15
related: [../README.md, ../setup-local-llm.md]
---

# Using Muse from your phone (remote access)

Muse's API server also serves the web UI, so proxying a single local port (3030 by default) is
enough to open the Muse running on your home or office computer from your phone. Muse offers that
proxy only through [Tailscale](https://tailscale.com)'s **Serve** feature: it connects **only
between your own devices on your own Tailscale account (tailnet)** and is never exposed to the
public internet. (Tailscale **Funnel**, which does expose publicly, is deliberately unsupported —
passing `--funnel` makes `muse remote` refuse.)

## Five-minute setup

**1. Install Tailscale on both the computer and the phone, signed into the same account**

- macOS: <https://tailscale.com/download/mac> (or `brew install tailscale`)
- Linux: <https://tailscale.com/download/linux>
- Windows: <https://tailscale.com/download/windows>
- Phone (iOS/Android): search "Tailscale" in the app store → sign in with the same account

If the computer is not signed in yet:

```bash
tailscale up
```

**2. Make sure Muse's API server is running**

Start it however you normally run Muse (the desktop app, or `pnpm --filter @muse/api dev`).

**3. Turn remote access on**

```bash
muse remote enable
```

If Tailscale is missing, not signed in, or the API server is not running, `muse remote enable`
prints guidance at that point and stops **without doing anything** (fail-close). When all three are
ready it prints:

```
✓ Muse is now available on your tailnet: https://<your-device-name>.<tailnet>.ts.net
Open this on your phone (any device on your tailnet) to reach Muse.
```

**4. Open that address on your phone**

Paste it into the browser on a phone with the Tailscale app running and the Muse web UI comes up. To
check the state again at any time:

```bash
muse remote status
```

## What "tailnet-only" means

- The URL opens **only from devices linked to your own Tailscale account** — it is not published to
  the internet at large, because Tailscale itself is a WireGuard-based private network.
- Muse's own login (authentication) is **off by default**, which means every device currently on the
  tailnet — usually just yours — can use Muse without logging in. `muse remote enable` prints a
  warning when that is the case. If you share a tailnet with other people, set
  `MUSE_AUTH_JWT_SECRET` (or `MUSE_AUTH_SECRETS_FILE`) to turn on token login.
- **Tailscale Funnel** (public internet exposure) is unsupported — Muse is a personal tool, so this
  was placed out of scope.

## Turning it off

```bash
muse remote disable
```

If it is already off, this does nothing and exits quietly (idempotent).
