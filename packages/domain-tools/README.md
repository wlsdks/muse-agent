# @muse/domain-tools

The concrete domain `MuseTool` implementations and their loopback MCP servers: email, web
action/fetch, calendar, contacts, weather, home automation, notes/tasks providers (Apple,
Notion, local file), and every `createXMcpServer` loopback wired into `muse-in-chrome`/MCP.
It is a package because these are the tools that reach outside Muse's own stores (email,
web, smart home), so their draft-first/approval contracts need one shared home distinct from
the generic `@muse/tools` runtime.

## Public surface

- `GmailEmailProvider`, `ImapSmtpEmailProvider`, `sendEmailWithApproval`,
  `replyEmailWithApproval`, `composeForward`, `createEmailSendTool` — email read/send with a
  draft-first approval gate.
- `performWebActionWithApproval`, `createWebActionTool`, `fetchReadableUrl`,
  `createWebDownloadTool` — approved web actions and readable-content fetch.
- `sendMessageWithApproval` — the approval-gated outbound-message primitive.
- `performHomeActionWithApproval`, `createHomeActionTool`, `readHomeAssistantState` — Home
  Assistant read/act with the same approval gate.
- `AppleNotesProvider`, `NotionNotesProvider`, `LocalDirNotesProvider`,
  `AppleRemindersProvider`, `NotionTasksProvider`, `LocalFileTasksProvider` — pluggable
  notes/tasks providers behind `NotesProvider`/`TasksProvider`.
- `createCalendarMcpServer`, `createNotesMcpServer`, `createTasksMcpServer`,
  `createFilesystemMcpServer`, `createSearchMcpServer`, `createDefaultLoopbackMcpServers`, and
  ~20 sibling `createXMcpServer` factories — the loopback MCP server catalog.
- `OpenMeteoWeatherProvider`, `createWeatherTool` — weather lookup.
- `assertPublicHttpUrl`, `isPrivateIPv4`, `isNonPublicWebAddress` — SSRF-guarding URL checks
  shared by the web/fetch tools.

## Depends on

- `@muse/tools`, `@muse/mcp`, `@muse/mcp-shared` — the `MuseTool` contract and loopback MCP
  server wiring these tools implement against.
- `@muse/stores` — the personal stores (contacts, followups, patterns) several tools read.
- `@muse/memory` — user-memory/episode types some tools reference.
- `@muse/messaging` — outbound message provider types for `sendMessageWithApproval`.
- `@muse/model`, `@muse/calendar`, `@muse/proactivity`, `@muse/fs`, `@muse/shared` — model
  calls, calendar types, proactivity hooks, and filesystem/shared primitives.
- `imapflow`, `nodemailer`, `undici` — the vendor email/HTTP libraries the email and web
  tools wrap (permitted here since they are not model-provider SDKs).

## Rules that bind this package

- [`../../.claude/rules/outbound-safety.md`](../../.claude/rules/outbound-safety.md) — every send/act-toward-a-third-party tool here
  (`sendEmailWithApproval`, `performWebActionWithApproval`, `performHomeActionWithApproval`,
  `sendMessageWithApproval`) is draft-first and approval-gated per this contract; none of them
  auto-send on the agent's own judgement.
- [`../../.claude/rules/tool-calling.md`](../../.claude/rules/tool-calling.md) — each `createXTool` factory follows the verb_noun
  naming, `required`-args, and "use when / not when" description contract.

## Tests

```bash
pnpm --filter @muse/domain-tools test
```
