## 814 — feat: find_contact surfaces the contact's birthday

## Why

810's `find_contact` returned name/email/handle; 798 added a `birthday`
field to contacts. They didn't compose — "when's Jane's birthday?" was
unanswerable by the agent even when the data was on the contact. Small
composition that closes the gap.

## Slice

`@muse/mcp` contacts-tool.ts — `find_contact` now includes `birthday`
in a resolved result when the contact has one (omitted otherwise), and
the tool description + keywords mention birthday so the model selects it
for "when's X's birthday?".

## Verify

- `@muse/mcp` contacts-tool.test.ts (updated): a resolved contact with
  a birthday returns `birthday: "12-25"`; a contact without one omits
  the field; ambiguous/unknown unchanged.
- **Mutation-proven**: dropping the `birthday` spread → the resolve
  test fails; restore → 3/3. Full `pnpm check` EXIT 0, `pnpm lint`
  0/0. Tool catalog rides the model request → live SELECTION wants
  `smoke:live`; Ollama down → deferred.

## Decisions

- Pure composition of 798 (contact birthdays) + 810 (find_contact), no
  new config. No bullet flip — perception EXPAND; CAPABILITIES line
  under P20.
- **Env note**: GitHub push is unreachable this tick (network reset);
  commits 813 + 814 are held local and will push when the network
  recovers (the loop's sync step pushes the backlog).
