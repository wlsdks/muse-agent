---
name: audit-parity
description: Run all parity gates in one shot — pnpm check, smoke:broad, verify:reactor-routes, verify:reactor-db
---

Run every gate and produce a 5-line report:

```bash
pnpm check 2>&1 | grep -iE "FAIL|error TS" | head -10
pnpm smoke:broad 2>&1 | tail -3
REACTOR_SOURCE_DIR=/Users/stark/ai/reactor pnpm verify:reactor-routes 2>&1 | grep -E "Reactor routes|Muse routes|Missing"
REACTOR_SOURCE_DIR=/Users/stark/ai/reactor pnpm verify:reactor-db 2>&1 | grep -E "Reactor tables|Muse tables|Missing"
```

Report format:

- pnpm check: pass / fail
- smoke:broad: N passed, F failed
- verify:reactor-routes: M Reactor / K Muse / D missing
- verify:reactor-db: M Reactor / K Muse / D missing
- Verdict (one sentence).
