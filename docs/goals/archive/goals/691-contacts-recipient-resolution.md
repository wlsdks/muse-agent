# 691 — P13 COMPLETE: a contacts provider resolves a name → recipient (`~/.muse/contacts.json` + `resolveContact`), reporting AMBIGUOUS / not-found rather than guessing — the recipient-resolution backbone for outbound safety, plus `muse contacts add|list|resolve`

## Why

P10 and P12 are complete; P11–P16 actuator breadth is next. P11 email
is the highest-priority *named* target, but its read path is gated
behind OAuth/token setup that can't be fully delivered in one commit,
so its outward value is blocked. **P13 contacts** is the better next
slice: it is local-file (zero-setup, immediately usable by the user),
read-only (no outbound-safety gate), and is explicitly "the
recipient-resolution backbone for P11/P15 outbound safety" — building
it first is correct sequencing, since P11-send / P15 web-actions need
`outbound-safety.md` rule 3 ("Recipient is resolved, never guessed").

## Slice

- `packages/autoconfigure/src/provider-paths.ts`: `resolveContactsFile`
  (`MUSE_CONTACTS_FILE`, default `~/.muse/contacts.json`), re-exported
  through `personal-providers` → `@muse/autoconfigure`.
- `packages/mcp/src/personal-contacts-store.ts` (new): `Contact` type;
  durable store (atomic fsync+rename write, tolerant read, corrupt
  quarantine — same posture as the veto/objective stores) with
  `readContacts` / `writeContacts` / `addContact` (idempotent on id) /
  `removeContact` / `queryContacts` (name-sorted); `contactIdentifier`;
  and the pure **`resolveContact(contacts, query)`** →
  `resolved` | `ambiguous` (with candidates) | `unknown`. An exact
  name/alias match wins; only with no exact match does it fall back to
  case-insensitive substring; **multiple matches are AMBIGUOUS, never a
  guess**. Exported from `@muse/mcp`.
- `apps/cli/src/commands-contacts.ts` (new): `muse contacts
  add|list|resolve`. `add` requires `--email`/`--handle` so a contact
  is resolvable; `resolve` prints the resolved recipient, OR the
  ambiguous candidates (exit 1, nothing on stdout), OR not-found
  (exit 1) — never a single guessed recipient. Registered in
  `program.ts`.

## Verify

- `@muse/mcp` personal-contacts-store.test.ts (7): store round-trip
  (add/query/idempotent-replace/remove) + `resolveContact`
  resolved/by-alias/exact-over-substring/ambiguous/unknown/empty.
- `@muse/cli` commands-contacts.test.ts (4): add→list→resolve over the
  real store; ambiguous → candidate list + exit 1 with NO guessed
  recipient on stdout; not-found exit 1; add without email/handle
  rejected.
- **Clean-mutation-proven**: making `resolveContact` return the first
  match (a guess) on multiple matches fails the two AMBIGUOUS tests.
  Restored; green.
- `pnpm check`: EXIT=0 (cross-package: autoconfigure + mcp + cli).
  `pnpm lint`: 0/0. `pnpm check:capabilities`: ✓. Byte-scan: clean.
- No LLM request/response path touched — pure store + CLI; `smoke:live`
  N/A.

## Status

**P13 FLIPPED.** Contacts resolve a name → recipient with the
never-guess guarantee that outbound safety requires.

| `muse contacts resolve <q>`        | result                              |
| ---------------------------------- | ----------------------------------- |
| unique name/alias match            | resolved → email/handle             |
| exact "Bob" with a "Bobby" present | resolved to Bob (exact beats substr)|
| two contacts named "Bob"           | AMBIGUOUS: candidates, exit 1       |
| no match / empty                   | not-found, exit 1                   |

## Decisions

- **Local file, single-user** — matches the personal-pivot / single-
  user design point; zero setup, no external API, no OAuth, no cost.
  Editable by hand or via `muse contacts add`.
- **Exact-before-substring** — so "Bob" resolves to the contact named
  "Bob" even when "Bobby" exists, avoiding a spurious ambiguity; only a
  genuinely non-exact query falls back to substring.
- **Ambiguous/unknown never resolve to a recipient** — the core
  outbound-safety guarantee (rule 3). The CLI surfaces the ambiguity to
  stderr with a non-zero exit and prints nothing resolvable on stdout,
  so a downstream "email <name>" can't silently pick wrong.
- **Store in @muse/mcp** — alongside the other personal stores
  (objectives/vetoes/consents), the layer the agent + outbound gate
  consume; `apps/cli` and `apps/api` both import it.
- **Chose P13 over the higher-priority P11** — P11-read is OAuth-gated
  (outward value blocked this commit); P13 is immediately usable AND
  unblocks P11-send / P15. Sequencing, not avoidance — recorded here.

## Remaining risks

- **No fuzzy / nickname intelligence** — resolution is exact-or-
  substring over name+aliases; "Rob" won't match "Robert" unless added
  as an alias. Deliberate: a guess-free resolver beats a clever-but-
  wrong one for recipient safety.
- **Not yet wired into an outbound flow** — P13 is the backbone; the
  consumer (P11-send drafting "email Bob" → resolve → gated send) is a
  later slice that will exercise the ambiguous→clarify path end-to-end.
- **No contacts import** (vCard / Google) — manual `add` only; an
  importer is a future additive slice.
