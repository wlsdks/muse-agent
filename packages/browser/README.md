# @muse/browser

Owns Muse's native browser-control tools (Hermes-style `browser_*`) that drive the user's real,
logged-in Chrome over CDP via `puppeteer-core`. It is a package rather than a folder because
browser control is a distinct native-tool surface from MCP-protocol tools — it depends only on
`@muse/tools` + `@muse/shared` + `puppeteer-core`, never on MCP plumbing.

## Public surface

- `PuppeteerBrowserController`, `PuppeteerBrowserControllerOptions`,
  `DetachedBrowserLaunchReceipt` — launches/attaches to a detached, persistent Chrome and exposes
  navigation, click, type, and read operations over CDP.
- Browser tools from `browser-tools.ts` (re-exported via `export *`) — the `MuseTool` definitions
  (open/read/back/click/type/upload/dialog/look, etc.) built on top of the controller.
- `browser-action-plan.ts`, `matcher.ts` exports (`export *`) — action-plan modeling and
  page-element matching used by the click/type/fill tools.
- `controller.ts` exports (`export *`) — the base browser-controller abstraction the Puppeteer
  implementation satisfies.

## Depends on

- `@muse/shared` — common primitives.
- `@muse/tools` — the `MuseTool` contract these browser tools implement.

## Rules that bind this package

Browser control drives a real, logged-in Chrome session and is not part of the CLI's default tool
set — it is registered only when the caller opts in via `--with-tools`
(`apps/cli/src/actuator-tools.ts`). The state-changing acts (`browser_click`, `browser_type`, form
submission, dialog accept) are outbound-adjacent actions in someone else's system and therefore
fall under [`../../.claude/rules/outbound-safety.md`](../../.claude/rules/outbound-safety.md): this
package intentionally does not embed the approval gate — the controller and gate are injected by
the caller (`apps/cli`), so the outbound-safety wiring lives at the CLI boundary, not here. Reads
and navigation are free; only the state-changing acts carry the draft-first approval requirement.

## Tests

```bash
pnpm --filter @muse/browser test
```
