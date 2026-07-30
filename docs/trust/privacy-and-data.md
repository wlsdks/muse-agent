---
title: Where your data lives — privacy summary
audience: [users, product, developers, AI agents]
purpose: One place for "what is stored where, and what each privacy posture blocks"
updated: 2026-07-30
related: [../design/attunement.md, ../product/SYSTEM-MAP.md, ../product/FEATURES.md, ../strategy/differentiation.md, ../README.md]
---

# Where your data lives (privacy summary)

Muse handles one person's private data and working rhythm, so "what it observes, where it stores
that, and where it may send it" matters as much as any feature. Personal stores are file-backed by
default today, and the model provider is your choice. If you need fail-closed protection from
covered remote model, voice, image, indexing, and Home Assistant paths, set
`MUSE_LOCAL_ONLY=true`.

For behaviour details see the [system map](../product/SYSTEM-MAP.md) and the [feature definitions](../product/FEATURES.md);
for "why it was designed this way" see the [differentiation doc](../strategy/differentiation.md).

## Where your data is stored

- **Personal stores live on your machine, under your account.** Notes, tasks, calendar entries,
  reminders, contacts, memory, past-conversation summaries and imported material are stored by
  default in **your own files on your own computer**. There is no shared cloud account and no
  workspace shared with other users (single user — no multi-tenancy, no RBAC).
- **Personal Continuity is local too.** The life/work threads you create, the local task/note IDs
  you link, and delivery, outcome and reset receipts are stored atomically and owner-only (`0600`)
  in `~/.muse/attunement.json` by default. This slice stores IDs rather than copying note text, and
  makes no model calls and no automatic data collection.
- **The semantic index (embeddings) uses a loopback endpoint by default.** But with
  `MUSE_LOCAL_ONLY` off, pointing `OLLAMA_BASE_URL` at a remote address means the personal text
  being indexed can be sent to that address. If you need Muse's semantic-index transport restricted
  to a loopback endpoint, turn on `MUSE_LOCAL_ONLY=true` so remote endpoints are refused.
- **Encryption at rest is plaintext by default and opt-in.** "Stored on your machine" does not mean
  encrypted. The default is plaintext; some stores (user-memory, episodes, action-log, contacts,
  playbook) can be switched on with an `… encrypt` command (for example `muse memory encrypt`,
  `muse actions encrypt`; set `MUSE_MEMORY_KEY` first for a strong key). Tasks, reminders and notes
  are not yet covered. `muse privacy` reports the state of the supported encrypted stores, but it is
  not yet a full data inventory covering browsing/activity/proactive history, run logs and
  checkpoints. Full-disk encryption (FileVault and equivalents) is recommended separately at the OS
  level.

## What local-only blocks (the explicit local-only posture)

- **No egress to cloud AI or cloud voice.** Under `MUSE_LOCAL_ONLY=true` nothing can reach a cloud
  LLM or a cloud voice service. Selecting a cloud model does not silently disable it — the runtime
  **refuses loudly**.
- **Microphone audio stays local.** Only local speech-to-text and text-to-speech engines are
  registered, so mic audio cannot leak out even when a cloud voice key is present.
- **Images too.** Image understanding runs locally, and the local-only gate closes the paths by
  which image bytes would reach a cloud provider.
- **A remote host counts as egress.** A model running on someone else's server — even the same
  open-source model — is treated as external and refused.
- **Home Assistant's remote path closes as well.** With `MUSE_LOCAL_ONLY=true`, the standard Home
  Assistant read, control and watch paths refuse a remote URL before reading a token. Only root
  endpoints on `http://127.0.0.0/8[:port]` or `http://[::1][:port]` are allowed, and redirects are
  not followed. This is a scope limit on the Home Assistant integration; it is not a claim to audit
  or block every network egress from Muse or from the computer.
- **This posture starts from a local model.** With `MUSE_LOCAL_ONLY=true`, a cloud key sitting on
  the machine cannot hijack the default model. With the flag off, a discovered cloud key may select
  the model.
- **Connecting to other Muse instances (swarm) still sends no personal data.** When several Muse
  instances are peered (off by default, explicitly opt-in), **only learned know-how such as skills**
  moves between them. Personal data — notes, memory, past conversations, contacts — is not a
  sendable category in the first place, and even the exported know-how leaves with secrets redacted.
  Received know-how is quarantined inactive until a human promotes it.

These decisions run as **fixed rule code**, not on the model's good intentions. The health-check
command (`muse doctor`) reports the current posture.

## If you use a cloud provider

Muse is provider-neutral, so you may choose a cloud model. In that case the chosen provider's
request boundary and policies apply. Users who need the covered remote-provider paths to fail
closed should turn on `MUSE_LOCAL_ONLY=true`; under that posture a cloud model provider is refused
before it is even instantiated.

## The Muse Observe data boundary (O1 collection available)

Observe O1 is an opt-in surface that collects, locally, only the app **category**, timestamp and
duration for one exact PersonalThread that you select. It offers
`consent/start/status/inspect/pause/resume/forget`, and discards raw app identifiers after an
explicit owner-only map lookup. O1 does not produce desktop work rhythm, friction, hypotheses,
intervention outcomes, notices or actions. Any future Personal Rhythm / timing stage keeps these
five properties as release gates:

1. **Owner-controlled placement** — today this means an owner-only local store with per-source TTL.
   External provider paths are separately opt-in, and observation data is never automatically
   included in cloud model context.
2. **Visible** — active sources, collected fields, retention, last read and derived hypotheses are
   shown in one place.
3. **Pausable** — pause stops OS reads by the next tick, and a disabled source polls zero times.
4. **Inspectable** — every rhythm and friction hypothesis traces back to redacted evidence IDs and a
   rule version.
5. **Forgettable** — deletion works per event, per period, per source and in full, and derived state
   is rebuilt along with it.

The default storage target is minimal metadata such as app-session transitions and durations.
**Persisting raw keystrokes, continuous screen capture, clipboard contents, selected text or window
titles is forbidden in the default profile.** Browser history remains, as today, a separate
explicitly opt-in source that is not combined with the O1 collector. Adding browser observation to
Observe later must separately clear private-window exclusion and per-source controls. The detailed
contract is in the [Attunement design](../design/attunement.md).

## Privacy-graded routing — sending only personal-data-free turns to the cloud (opt-in, off by default)

A middle point between going fully cloud ("turn local-only off") and staying fully local: per chat
turn, send only requests that carry **no personal information at all** to a stronger cloud model,
and keep anything with even a hint of a personal signal local. Off by default — both environment
variables below must be set.

- **How to turn it on**: `MUSE_PRIVACY_ROUTING=true` plus `MUSE_CLOUD_MODEL=<provider/model>` (for
  example `gemini/gemini-2.5-flash`).
- **What forces a turn to stay local** (any one of these is enough; the decision is deterministic
  code): memory (persona) or note/episode retrieval results actually made it into this turn's
  prompt; PII was detected in the message; the message uses a possessive ("my …", "내 …"); or a
  remembered fact's value (a stored person's name, say) appears in the message. The logic lives in
  `packages/policy/src/privacy-routing.ts` (`resolvePrivacyRoutedModel`) and fails closed to local
  whenever it is unsure.
- **What a cloud-routed turn actually carries**: the raw message, a reply-language instruction and
  one line with the current time. Persona, memory, retrieved notes/episodes and prior conversation
  history are structurally impossible to include, because the function that builds the request
  (`buildCloudTurnRequest`) never receives them as arguments.
- **`MUSE_LOCAL_ONLY=true` always wins.** Even with privacy routing on, local-only means the cloud
  model is never attempted (policy layer plus model-router gate — defence in depth).
- **If the cloud model is not ready** (no key, network error) the turn **falls back to local
  quietly** — no error surfaces to the user.
- **It is visibly marked**: a cloud-routed reply is labelled `☁️ cloud (context-free) — <model>`
  (in Korean, `☁️ 클라우드 (개인 정보 없음) — <model>`). Locally handled turns look exactly as usual,
  with no marker. `muse doctor`'s `privacy routing` entry shows the current posture (off / on plus
  model / forced local by local-only).
- **Current scope**: this slice is wired into the single-turn `muse chat` path (`runLocalChat` — CLI
  `muse chat --local` plus the status TUI). The interactive Ink chat (plain `muse`) does not apply
  this routing yet — persona and retrieval assembly happen inside render components, which this
  slice could not separate safely — so an interactive `muse` session today always stays local even
  with the option on.

## Acting toward other people (when something leaves)

Unlike *reading* your data, **actions that send something to another person** (email, messages, form
submissions) pass through separate safeguards:

- **Draft first, never an automatic send** — it leaves only after a human confirms that exact
  content.
- **Fail closed** — denial, timeout, or a failure to deliver the confirmation all mean nothing is
  sent.
- **Every action logged and reversible** — sent or refused, it is recorded and can be undone.

## Permanently out of scope

- **No banking, payments or transfers.** Muse does not connect accounts and does not move money (an
  irreversible risk, so a permanent product boundary).
- **No hosted/cloud personal-memory store is shipped.** Shipping one would first require the
  encryption, identity, conflict, deletion, export, and recovery gates in the
  [Attunement product contract](../strategy/attunement.md). Autonomous outbound sends remain
  permanently out of scope.

---

*Summary: personal stores are file-backed by default today, and you choose the model provider and
the deployment shape. `MUSE_LOCAL_ONLY=true` fails closed on the covered remote-provider paths, and
future Observe work does not ship unless it is visible, pausable, inspectable and forgettable.
Anything going to another person always passes through your confirmation.*
