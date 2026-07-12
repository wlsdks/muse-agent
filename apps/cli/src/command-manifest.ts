// Stub metadata for lazy-loaded commands: enough to render `muse --help`,
// shell completion, and did-you-mean WITHOUT importing the command handlers
// (which pull the ~100-module @muse/* graph). Kept in sync with the real
// command tree by command-manifest.drift.test.ts — when you add/rename a
// command or change its description / options / arguments / subcommands, add or
// update its entry here AND its loader in command-loaders.ts; the drift test
// fails with the exact mismatch until they agree.

export interface CommandStub {
  readonly name: string;
  readonly description: string;
  /** Positional-argument term for the help line, e.g. "[query...]" / "<shell>" ("" = none). */
  readonly argsTerm: string;
  /** Whether the real command declares options (drives the " [options]" help suffix). */
  readonly hasOptions: boolean;
  /** Direct subcommand names (for shell completion of groups). */
  readonly subcommands: readonly string[];
}

export const COMMAND_STUBS: readonly CommandStub[] = [
  {
    "name": "actions",
    "description": "Review what Muse did autonomously on your behalf (the accountability log)",
    "argsTerm": "",
    "hasOptions": true,
    "subcommands": [
      "decrypt",
      "encrypt",
      "encryption-status"
    ]
  },
  {
    "name": "agent-notices",
    "description": "Phase D agent-initiated heads-ups streamed by the API",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "tail"
    ]
  },
  {
    "name": "agents",
    "description": "Define, list, and locate manual sub-agents (~/.muse/agents)",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "add",
      "list",
      "path",
      "show"
    ]
  },
  {
    "name": "anomaly",
    "description": "Spot your most unusual days — activity that stands out against your own history (local, robust, draft-first)",
    "argsTerm": "",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "approval",
    "description": "Tool-call trust decisions — audit pending tool requests, grant/deny to your trust list (for outbound sends see `muse approvals`)",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "approve",
      "deny",
      "list",
      "request"
    ]
  },
  {
    "name": "approvals",
    "description": "Outbound action worklist — confirm/dismiss draft-first sends awaiting your OK (for tool-call trust see `muse approval`)",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "approve",
      "clear",
      "list"
    ]
  },
  {
    "name": "ask",
    "description": "Ask a question with your notes as context — RAG-grounded one-shot via local Qwen. Reads piped stdin too: `cat doc.md | muse ask 'summarize this'`",
    "argsTerm": "[query...]",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "auth",
    "description": "Manage CLI credentials",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "login",
      "logout",
      "rotate-jwt",
      "status"
    ]
  },
  {
    "name": "bg",
    "description": "Inspect background processes Muse has started",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "list",
      "logs",
      "prune",
      "restart",
      "run",
      "stop"
    ]
  },
  {
    "name": "board",
    "description": "Your durable agent task board — add work, run the next ready task, approve what's parked for review",
    "argsTerm": "",
    "hasOptions": true,
    "subcommands": [
      "add",
      "expand",
      "move",
      "reclaim",
      "retry",
      "review",
      "rm",
      "run",
      "seed",
      "show"
    ]
  },
  {
    "name": "brief",
    "description": "One-command morning briefing — your personal summary of tasks + recent notices",
    "argsTerm": "",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "browsing",
    "description": "Local, opt-in Chrome browsing-history ingest + search (never leaves your machine)",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "recent",
      "search",
      "sync"
    ]
  },
  {
    "name": "calendar",
    "description": "Personal calendar — view your schedule and create/reschedule/cancel events (add, edit, delete, block, import)",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "add",
      "block",
      "conflicts",
      "delete",
      "edit",
      "events",
      "export",
      "focus",
      "free",
      "import",
      "providers",
      "show",
      "this-week",
      "tomorrow"
    ]
  },
  {
    "name": "checkins",
    "description": "Proactive check-ins on things you said you'd do (the daemon asks how they went)",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "cancel",
      "list",
      "scan",
      "snooze"
    ]
  },
  {
    "name": "commitments",
    "description": "Open loops you voiced in chat that never became a task or reminder",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "scan",
      "track"
    ]
  },
  {
    "name": "companion-line",
    "description": "One short opener for the desktop companion bubble (JSON: {line, grounded, mode, topic})",
    "argsTerm": "",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "config",
    "description": "Manage CLI config",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "set",
      "show",
      "unset"
    ]
  },
  {
    "name": "contacts",
    "description": "Manage and resolve your people graph (~/.muse/contacts.json)",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "add",
      "birthdays",
      "decrypt",
      "dupes",
      "encrypt",
      "encryption-status",
      "export",
      "import",
      "link",
      "list",
      "network",
      "overdue",
      "related",
      "resolve"
    ]
  },
  {
    "name": "cost",
    "description": "Inspect token-cost usage (daily roll-ups, top spenders, per-run)",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "daily",
      "for",
      "local",
      "top"
    ]
  },
  {
    "name": "csv",
    "description": "Exact aggregates over a CSV — sum / avg / min / max a column or count rows, with an optional row filter. Deterministic (no model). Use when you need a precise total/count over tabular data; for free-text questions use `muse ask --file`.",
    "argsTerm": "<file>",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "daemon",
    "description": "Run Muse's background daemon (proactive notices) in one process. --once runs a single tick and exits.",
    "argsTerm": "",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "debug",
    "description": "Debugging surfaces (replay captures of failed runs)",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "context",
      "replay",
      "replay-show"
    ]
  },
  {
    "name": "demo",
    "description": "Try Muse on a bundled sample corpus — cited answer + honest refusal, zero setup",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": []
  },
  {
    "name": "digest",
    "description": "Notices the interruption budget deferred — compiled into one daily message by the background daemon",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "list"
    ]
  },
  {
    "name": "doctor",
    "description": "Run a runtime health check (model, MCP, calendar, scheduler, etc.)",
    "argsTerm": "",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "email",
    "description": "Email — sync your inbox into recall (`sync`) + draft-first send / reply / forward",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "forward",
      "reply",
      "send",
      "sync"
    ]
  },
  {
    "name": "episode",
    "description": "Self-captured prior-session summaries (auto-written at REPL exit when MUSE_EPISODIC_MEMORY_ENABLED=true)",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "clear",
      "consolidate",
      "decrypt",
      "encrypt",
      "encryption-status",
      "list",
      "reindex",
      "remove",
      "search",
      "show",
      "themes"
    ]
  },
  {
    "name": "export",
    "description": "Bundle every ~/.muse/*.json store + the notes tree into a single timestamped tar.gz",
    "argsTerm": "",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "feeds",
    "description": "RSS/Atom feed ingest for ambient world-state",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "add",
      "list",
      "refresh",
      "remove",
      "search",
      "today"
    ]
  },
  {
    "name": "find",
    "description": "Search your tasks, reminders, contacts, and calendar for a term (local substring). Notes → `muse notes search`; memory → `muse recall`.",
    "argsTerm": "<query...>",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "followup",
    "description": "Self-queued follow-up promises (auto-captured from agent turns)",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "cancel",
      "list",
      "show",
      "snooze"
    ]
  },
  {
    "name": "forget",
    "description": "Remove a fact/preference (`muse forget name`) or the whole persona (`muse forget --all --force`)",
    "argsTerm": "[key]",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "glance",
    "description": "Read the frontmost app + window title (+ selected text when Accessibility is granted). macOS only.",
    "argsTerm": "",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "history",
    "description": "Unified activity feed across reminder/proactive/followup/pattern/episode stores (newest first)",
    "argsTerm": "",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "home",
    "description": "Smart-home control via Home Assistant (opt-in, confirmation-gated)",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "call",
      "entities",
      "state"
    ]
  },
  {
    "name": "import",
    "description": "Restore a `muse export` tarball into ~/.muse/. Refuses to overwrite without --force.",
    "argsTerm": "<bundle>",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "inbox",
    "description": "Read + triage your Gmail inbox (read-only; needs MUSE_GMAIL_TOKEN)",
    "argsTerm": "[id]",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "ingest",
    "description": "Ingest an exported AI chat history (ChatGPT/Claude conversations.json) or an .mbox mail archive into your notes corpus",
    "argsTerm": "<file>",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "job",
    "description": "Background long-running agent tasks",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "delete",
      "list",
      "run",
      "status",
      "tail"
    ]
  },
  {
    "name": "journey",
    "description": "One chronological timeline of what Muse has learned about you — facts, skills, strategies",
    "argsTerm": "",
    "hasOptions": true,
    "subcommands": [
      "forget"
    ]
  },
  {
    "name": "learned",
    "description": "Show what Muse has learned about working with you — trusted/avoided strategies & skills + recent reflections",
    "argsTerm": "",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "listen",
    "description": "Push-to-talk voice loop: speak a prompt, hear the agent reply through the speakers",
    "argsTerm": "",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "logo",
    "description": "Print the Muse mascot (the bluebird) as terminal art. Use to show Muse's banner/logo; not for any data or agent task.",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": []
  },
  {
    "name": "maintenance",
    "description": "Housekeeping for ~/.muse archives",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "compact",
      "prune-activity",
      "prune-log"
    ]
  },
  {
    "name": "mcp",
    "description": "Manage MCP servers",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "add",
      "call",
      "config-add",
      "config-doctor",
      "config-path",
      "config-show",
      "connect",
      "disconnect",
      "list",
      "serve",
      "status",
      "tools",
      "use"
    ]
  },
  {
    "name": "memory",
    "description": "Personal user-memory facts / preferences",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "clear",
      "consolidate",
      "decrypt",
      "diff",
      "encrypt",
      "encryption-status",
      "forget",
      "history",
      "promote",
      "search",
      "set",
      "show",
      "why"
    ]
  },
  {
    "name": "messaging",
    "description": "Outbound messengers (Telegram / Discord / Slack / LINE)",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "inbox",
      "pairing-code",
      "providers",
      "send"
    ]
  },
  {
    "name": "metrics",
    "description": "Observability surfaces (SLO + drift + budget + token cost)",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "show"
    ]
  },
  {
    "name": "models",
    "description": "List the models Muse can use + their capabilities (vision/tools/local). Filter: --vision/--tools/--local/--provider",
    "argsTerm": "",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "note",
    "description": "Frictionless capture: append a one-line thought to today's inbox note and auto-index it (pass text, pipe via stdin `pbpaste | muse note`, or speak it with --voice)",
    "argsTerm": "[text...]",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "notes",
    "description": "Personal notes (filesystem-backed)",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "append",
      "bridges",
      "conflicts",
      "delete",
      "fix-links",
      "folders",
      "graph",
      "hubs",
      "ingest",
      "links",
      "list",
      "providers",
      "read",
      "recent",
      "reindex",
      "related",
      "rename",
      "review",
      "save",
      "search",
      "semantic",
      "trails"
    ]
  },
  {
    "name": "objectives",
    "description": "Standing objectives Muse pursues autonomously (watch X / until Z / tell me when W)",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "add",
      "cancel",
      "done",
      "list"
    ]
  },
  {
    "name": "on-this-day",
    "description": "Resurface notes you wrote on TODAY's date in earlier years — date-cued recall. Read-only, deterministic, no model. Uses the YYYY-MM-DD in a note's path (e.g. journal/2025-06-06.md).",
    "argsTerm": "",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "onboard",
    "description": "Guided setup: the single next step to your first private, cited answer",
    "argsTerm": "",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "open",
    "description": "Look up an activity record by ID prefix (scans every store; first hit wins, ambiguous matches surfaced)",
    "argsTerm": "<prefix>",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "orchestrate",
    "description": "Drive multi-agent orchestration runs and inspect history",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "get",
      "list",
      "run",
      "stats"
    ]
  },
  {
    "name": "pattern",
    "description": "Pattern-detection audit + cooldown management",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "dismiss",
      "dismissed",
      "fired",
      "lapsed",
      "list",
      "reset",
      "shifts",
      "upcoming"
    ]
  },
  {
    "name": "persona",
    "description": "System-prompt persona templates",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "add",
      "list",
      "remove",
      "show",
      "use"
    ]
  },
  {
    "name": "playbook",
    "description": "Learned strategies the agent applies from past feedback (ACE)",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "add",
      "consolidate",
      "decrypt",
      "distill",
      "encrypt",
      "encryption-status",
      "list",
      "pause",
      "remove",
      "resume",
      "reward",
      "undo"
    ]
  },
  {
    "name": "privacy",
    "description": "Inventory your confided data at rest — which personal stores are encrypted vs plaintext, and whether the key is strong (read-only)",
    "argsTerm": "",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "proactive",
    "description": "Proactive surfacing utilities (test / scan against MUSE_PROACTIVE_* env)",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "acted",
      "dismiss",
      "done",
      "history",
      "keep",
      "scan",
      "scoreboard",
      "snooze",
      "test",
      "veto",
      "watch"
    ]
  },
  {
    "name": "propose",
    "description": "Review + confirm the actions Muse has proposed (draft-first; nothing sends until you approve)",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "approve",
      "decline",
      "list"
    ]
  },
  {
    "name": "read",
    "description": "Read a local PDF or text file (.txt/.md/.log/.csv); optionally answer a question grounded in its text. Point at a DIRECTORY with --save-to-notes to bulk-ingest a whole folder of documents into your corpus.",
    "argsTerm": "<path>",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "recall",
    "description": "Semantic search across notes + episodes indices",
    "argsTerm": "<query>",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "recap",
    "description": "Evening recap — what you got done today + what's coming up (the retrospective sibling of `muse brief`)",
    "argsTerm": "",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "reflections",
    "description": "Grounded insights Muse has formed about you from past sessions (each cites its sources)",
    "argsTerm": "",
    "hasOptions": true,
    "subcommands": [
      "decrypt",
      "encrypt",
      "encryption-status",
      "refresh"
    ]
  },
  {
    "name": "remember",
    "description": "Tell Muse something in natural language — it extracts facts/prefs/vetoes/goals into ~/.muse/user-memory.json",
    "argsTerm": "<text...>",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "remind",
    "description": "Personal reminders (passive — surfaced in `muse today`)",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "add",
      "clear",
      "fire",
      "history",
      "list",
      "run",
      "snooze"
    ]
  },
  {
    "name": "resume",
    "description": "Resume a crashed/interrupted run from its last checkpoint (fault-tolerant execution)",
    "argsTerm": "[run-id]",
    "hasOptions": false,
    "subcommands": []
  },
  {
    "name": "routine",
    "description": "Aggregate ~/.muse/activity.jsonl into routine.active_hours + topDays; --apply writes the fact",
    "argsTerm": "",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "runs",
    "description": "Inspect recent agent run history",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "delete",
      "list",
      "show"
    ]
  },
  {
    "name": "scheduler",
    "description": "Manage scheduled jobs",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "create-agent",
      "delete",
      "dry-run",
      "executions",
      "list",
      "next",
      "pause",
      "pause-status",
      "resume",
      "trigger"
    ]
  },
  {
    "name": "search",
    "description": "Web search via the muse.search MCP tool (SearXNG primary, DuckDuckGo fallback)",
    "argsTerm": "<query...>",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "session",
    "description": "Focus / Do-Not-Disturb controls for proactive notices",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "lock",
      "status",
      "unlock"
    ]
  },
  {
    "name": "settings",
    "description": "Inspect and edit runtime settings",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "get",
      "list",
      "refresh",
      "set",
      "unset"
    ]
  },
  {
    "name": "setup",
    "description": "Survey or configure Muse (no args → status report)",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "calendar",
      "cloud",
      "data",
      "local",
      "messaging",
      "model",
      "start",
      "status",
      "voice",
      "wizard"
    ]
  },
  {
    "name": "show",
    "description": "Render an image inline in the terminal (iTerm2/WezTerm/Ghostty). Falls back to the native viewer on other terminals (incl. Kitty, which uses an incompatible protocol).",
    "argsTerm": "<path>",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "skills",
    "description": "List, add, and locate Muse skills (~/.muse/skills)",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "add",
      "archived",
      "author",
      "authored",
      "consolidate",
      "curate",
      "list",
      "path",
      "restore",
      "reward"
    ]
  },
  {
    "name": "specs",
    "description": "List, inspect, and resolve agent specs",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "get",
      "list",
      "resolve"
    ]
  },
  {
    "name": "status",
    "description": "At-a-glance dashboard: persona + model + imminent tasks + last notice",
    "argsTerm": "",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "summarize",
    "description": "Extractive summary of a document — its OWN top sentences by significant-word density (Luhn 1958). Deterministic, no model, cannot fabricate. Use for a verbatim gist; for a reworded answer use `muse ask --file`.",
    "argsTerm": "<file>",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "swarm",
    "description": "Review know-how other Muses shared with you (A2A swarm — inbound is inert until you promote it)",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "council",
      "pending",
      "promote",
      "reject",
      "serve",
      "share",
      "status"
    ]
  },
  {
    "name": "tasks",
    "description": "Personal todo list",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "add",
      "complete",
      "delete",
      "edit",
      "flow",
      "list",
      "next",
      "open-loops",
      "providers"
    ]
  },
  {
    "name": "telemetry",
    "description": "Inspect runtime telemetry (ctx flags / token totals / latency)",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "recent",
      "summary"
    ]
  },
  {
    "name": "time",
    "description": "Current time in a place / timezone — e.g. `muse time tokyo` or `muse time Asia/Tokyo` (omit for local)",
    "argsTerm": "[place...]",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "today",
    "description": "Personal morning briefing — open tasks, next 24h calendar, recent notes",
    "argsTerm": "",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "tools",
    "description": "Inspect tool usage stats, accuracy, and recent calls",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "accuracy",
      "calls",
      "ranking",
      "stats"
    ]
  },
  {
    "name": "trace",
    "description": "Inspect a local run — query, answer, RETRIEVED sources+scores, tools, grounding, steps (no server)",
    "argsTerm": "[run-id]",
    "hasOptions": false,
    "subcommands": []
  },
  {
    "name": "traces",
    "description": "Inspect recorded trace events / spans",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "list",
      "spans",
      "tail"
    ]
  },
  {
    "name": "trust",
    "description": "Per-user tool trust list (skills trust calibration)",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "block",
      "grant",
      "list",
      "revoke",
      "unblock"
    ]
  },
  {
    "name": "user",
    "description": "The typed user model Muse keeps about you (persona-injected)",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "model"
    ]
  },
  {
    "name": "voice",
    "description": "Voice provider surface (STT / TTS)",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "providers",
      "tts"
    ]
  },
  {
    "name": "watch-folder",
    "description": "Watch a folder for new files and fire each one as a proactive notice — credential-free external-signal trigger",
    "argsTerm": "",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "weather",
    "description": "Show current weather + rain heads-up for a place (Open-Meteo, free, no key). Omit the place for your configured home (MUSE_WEATHER_LOCATION).",
    "argsTerm": "[location...]",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "web-action",
    "description": "Perform a confirmation-gated web action (submit/book). Never autonomous; not for payments.",
    "argsTerm": "",
    "hasOptions": true,
    "subcommands": []
  },
  {
    "name": "webhook",
    "description": "HTTP entry point for external proactive triggers",
    "argsTerm": "",
    "hasOptions": false,
    "subcommands": [
      "serve"
    ]
  },
  {
    "name": "week",
    "description": "Your next 7 days at a glance — events, due tasks, birthdays, and the daily weather forecast grouped by day (read-only, local)",
    "argsTerm": "",
    "hasOptions": true,
    "subcommands": []
  }
];
