## 853 — feat: contacts store a phone number

## Why

The `Contact` model held name / email / handle / aliases / birthday but
**no phone number** — so a JARVIS-style assistant couldn't answer
"what's mom's number?" or capture "mom's number is 415-555-0101". Phone
is the single most common contact field, and the gap also blocked any
future "call / text X" reach. P13 is the people graph; this fills its
most glaring hole.

## Slice — phone as a first-class, reachable contact field

`@muse/mcp`:
- `Contact` gains `readonly phone?` (stored verbatim — not reformatted).
- `serializeContact` emits `phone` when present.
- `find_contact` returns `phone` (so look-up by name surfaces the
  number) + keywords `phone / number / call / text` so the lookup tool
  is selectable for those prompts.
- `add_contact` accepts a `phone` param AND counts it as a reachable
  channel: the fail-close "must be reachable" check is now
  `email || handle || phone` (a phone-only contact is valid).

`apps/cli` `muse contacts`:
- `add --phone <p>` persists it; the reachability gate matches the tool
  (`--email || --handle || --phone`).
- `describeContact` (used by `list` / `resolve`) renders the phone, and
  a phone-only contact is no longer mislabelled `(no email/handle)`.

## Verify

- `packages/mcp` contacts-tool.test.ts: `find_contact` returns the phone
  when looked up by name ("what's mom's number?"); `add_contact` saves a
  phone-only contact (phone is a reachable channel).
- contacts-resolve-by-email.test.ts: `serializeContact` emits phone when
  present, omits it when absent.
- `apps/cli` commands-contacts.test.ts: `add --phone` round-trips the
  real store and `list` shows the number without the "(no email/handle/
  phone)" fallback; reachability error names `--phone`.
- **Mutation-proven**: dropping the phone field from `find_contact`
  output makes the "mom's number" test fail; reverting the reachability
  check to `email || handle` makes the phone-only add test fail.
- `pnpm check` EXIT 0 (mcp 18 contacts tests, apps/cli 133/133 files,
  apps/api 71/71), `pnpm lint` 0/0. Store + tool + CLI only — no LLM
  request/response path → no smoke:live.

## Decisions

- **Phone is a reachable channel, not just metadata.** A contact with
  only a phone number is now valid (you can call/text them) — so the
  outbound-safety "recipient must resolve" posture extends to phone,
  and the add gate accepts phone alone. Email/handle stay the
  email-recipient identifiers (`contactIdentifier` unchanged), since
  phone isn't an email destination.
- **Store verbatim, no format validation.** Phone formats vary wildly
  (international, spaces, dashes, parens); a regex would reject valid
  inputs. The number is stored as typed, like email/handle aren't
  format-checked. `resolveContact`-by-phone is deliberately out of
  scope (the common query is by name → returns the number).
- No new dependency.
