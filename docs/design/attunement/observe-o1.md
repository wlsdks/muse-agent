# Observe O1: consented category-session collection

Observe O1 is a deliberately narrow Attunement substrate. It can collect a
bounded sequence of app **categories** for one exact, owner-selected
PersonalThread. It does not yet decide when to help.

## What ships

- Consent is explicit and versioned. Run `muse observe consent`, then
  `muse observe start <threadId> --accept-version 1`.
- The collector stores only category, canonical start/end time, and duration.
  Raw application identifiers exist only long enough to perform an exact lookup
  in the owner's mapping file.
- `status`, `inspect`, `pause`, `resume`, and `forget` are available through the
  CLI and authenticated local API. Status never exposes collector fingerprints
  or fencing tokens.
- One fenced collector may run at a time across the CLI and API daemons. A
  second live daemon fails before it invokes the operating-system source.
- Deleting a PersonalThread is refused while any Observe session still refers
  to it. The owner must explicitly forget that session first.

## Enabling collection

Collection is off unless all values below are present and exact:

```text
MUSE_OBSERVE_ENABLED=true
MUSE_OBSERVE_SESSION_ID=observe_<uuid>
MUSE_OBSERVE_THREAD_ID=<exact PersonalThread id>
MUSE_OBSERVE_PLATFORM=macos|windows
MUSE_OBSERVE_MAP_FILE=/absolute/owner-only/apps.json
MUSE_OBSERVE_INTERVAL_MS=10000..300000
```

The mapping file must be a non-symlink regular file, owner-only on POSIX, and
use this strict shape:

```json
{
  "version": 1,
  "apps": {
    "com.example.Editor": "writing"
  }
}
```

Allowed categories are `communication`, `planning`, `research`, `writing`,
`building`, and `other`. Matching is byte-exact and case-sensitive. There is no
default, trimming, fuzzy match, or inferred mapping; even `other` must be
explicit.

## Privacy and authority boundary

The macOS source asks only for the frontmost bundle identifier. The Windows
source asks only for the foreground process name. Fixed executables, fixed
arguments, a two-second timeout, 4 KiB output limits, fatal UTF-8, and an exact
single-line protocol bound both sources. Application identifiers are not
persisted, logged, returned in errors, joined to browser/activity data, or sent
to a model.

The host-only collector subpath isolates lease and sample authority from the
normal package barrel. This prevents accidental authority laundering; it is not
a security boundary against malicious code in the same process.

## Honest limitation

O1 is collection infrastructure, not Personal Rhythm. It provides no timing
hypothesis, friction signal, causal inference, usefulness score, proactive
delivery, feedback adaptation, model call, external send, or action. A later
stage must qualify those capabilities separately using deterministic graders,
fault tests, and explicit owner outcomes. Synthetic tests prove implementation
contracts only; they are not organic observation evidence.
