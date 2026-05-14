# 036 — Final sweep for env-only probes that bypass mergeModelKeysFromFile

## Why

Iters 44-46 + 53 closed the major env-only-probe sites. Sweep one more
time — anything still reading MUSE_MODEL / *_API_KEY directly without
the file-overlay merge?

## Scope

- grep \"process.env.MUSE_MODEL\b\|process.env.GEMINI_API_KEY\"
  + similar across apps + packages.
- For each hit: confirm overlay-correct OR fix.
- Lock-in test per fix.

## Verify

- All gates green.
- grep returns only intentional env-only sites (e.g., tests).

## Status

open
