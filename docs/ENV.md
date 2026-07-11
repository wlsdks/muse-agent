# MUSE_* environment variables — the generated inventory

**Generated file — do not edit by hand.** Regenerate with `pnpm docs:env`;
`pnpm check:env` (CI / self-eval) fails when this file no longer matches the
source. Every `MUSE_*` referenced in product source (`packages/`, `apps/`;
tests excluded) is listed with the workspaces that read it. Descriptions and
value contracts are curated incrementally in code (`.claude/rules/` /
per-module docs); this inventory is the discoverability + drift floor.

Total: **540** variables.

| Variable | Read by |
| --- | --- |
| `MUSE_A2A_COUNCIL` | apps/cli, packages/a2a |
| `MUSE_A2A_COUNCIL_GROUNDED` | apps/cli |
| `MUSE_A2A_ENABLED` | apps/cli, packages/a2a, packages/agent-core |
| `MUSE_A2A_PEERS_FILE` | apps/cli |
| `MUSE_A2A_PROTOCOL_VERSION` | packages/a2a |
| `MUSE_ACTION_LOG_FILE` | packages/autoconfigure |
| `MUSE_ACTIVE_CONTEXT_CALENDAR_ENABLED` | packages/autoconfigure |
| `MUSE_ACTIVE_CONTEXT_CALENDAR_LIMIT` | packages/autoconfigure |
| `MUSE_ACTIVE_CONTEXT_ENABLED` | apps/api, packages/autoconfigure, packages/domain-tools |
| `MUSE_ACTIVE_CONTEXT_REMINDERS_ENABLED` | packages/autoconfigure |
| `MUSE_ACTIVITY_FILE` | apps/cli |
| `MUSE_AGENTS_DIR` | apps/cli |
| `MUSE_AGENT_CARD_DESCRIPTION` | packages/autoconfigure |
| `MUSE_AGENT_CARD_NAME` | packages/autoconfigure |
| `MUSE_AGENT_CARD_VERSION` | packages/autoconfigure |
| `MUSE_ALLOW_WRITE_WITHOUT_MUTATION_INTENT` | packages/autoconfigure |
| `MUSE_AMBIENT_CLIPBOARD` | apps/api, apps/cli |
| `MUSE_AMBIENT_DESTINATION` | apps/api |
| `MUSE_AMBIENT_ENABLED` | apps/api |
| `MUSE_AMBIENT_FILE` | apps/api, apps/cli |
| `MUSE_AMBIENT_KNOWLEDGE_TRIGGER` | apps/api |
| `MUSE_AMBIENT_PROVIDER` | apps/api |
| `MUSE_AMBIENT_QUIET_HOURS` | apps/api |
| `MUSE_AMBIENT_RULES` | apps/api, apps/cli |
| `MUSE_AMBIENT_SOURCE` | apps/api, apps/cli |
| `MUSE_AMBIENT_TICK_MS` | apps/api |
| `MUSE_ANSWER_TEMPERATURE` | packages/autoconfigure |
| `MUSE_API_TOKEN` | apps/cli |
| `MUSE_API_URL` | apps/cli |
| `MUSE_APPLE_NOTES_FOLDER` | packages/autoconfigure |
| `MUSE_APPLE_NOTES_MIRROR` | apps/api, apps/cli, packages/autoconfigure, packages/macos |
| `MUSE_APPLE_REMINDERS_LIST` | packages/autoconfigure |
| `MUSE_APPLE_REMINDERS_MIRROR` | apps/api, apps/cli, packages/autoconfigure, packages/macos |
| `MUSE_APPROVALS_FILE` | apps/cli |
| `MUSE_APPROVAL_VERIFY_MODEL` | apps/cli |
| `MUSE_APP_NAME` | packages/autoconfigure |
| `MUSE_ASK_MAX_TOOLS` | apps/cli |
| `MUSE_ASK_REASONING_PRINCIPLES` | apps/cli |
| `MUSE_AUTHORED_SKILLS_DIR` | apps/api, apps/cli, packages/autoconfigure |
| `MUSE_AUTH_JWT_EXPIRATION_MS` | packages/autoconfigure |
| `MUSE_AUTH_JWT_SECRET` | apps/cli, packages/autoconfigure |
| `MUSE_AUTH_MAX_USERS` | packages/autoconfigure |
| `MUSE_AUTH_SECRETS_FILE` | apps/cli, packages/autoconfigure |
| `MUSE_AUX_COMPACTION` | packages/autoconfigure |
| `MUSE_BACKGROUND_PROCESSES_FILE` | packages/stores |
| `MUSE_BACKGROUND_REVIEW_ENABLED` | apps/api, apps/cli, packages/autoconfigure |
| `MUSE_BACKGROUND_REVIEW_MEMORY_TURNS` | apps/cli, packages/autoconfigure |
| `MUSE_BACKGROUND_REVIEW_SKILL_ARM` | packages/autoconfigure |
| `MUSE_BACKGROUND_REVIEW_SKILL_ITERS` | packages/autoconfigure |
| `MUSE_BELIEF_PROVENANCE` | packages/autoconfigure |
| `MUSE_BELIEF_PROVENANCE_FILE` | apps/cli, packages/memory |
| `MUSE_BIRD_ANSI` | apps/cli |
| `MUSE_BIRD_BLINK_ANSI` | apps/cli |
| `MUSE_BIRD_ROWS` | apps/cli |
| `MUSE_BLUETOOTH_OFF_SHORTCUT` | apps/cli, packages/macos |
| `MUSE_BLUETOOTH_ON_SHORTCUT` | apps/cli, packages/macos |
| `MUSE_BOARD_FILE` | packages/multi-agent |
| `MUSE_BOARD_MAX_DEPTH` | packages/multi-agent |
| `MUSE_BOARD_SPILL_DIR` | apps/cli |
| `MUSE_BOARD_STALE_MS` | apps/cli |
| `MUSE_BOARD_SYNTHESIS_HEADROOM` | apps/cli |
| `MUSE_BRIEFING_BIRTHDAY_DAYS` | apps/api |
| `MUSE_BRIEFING_DESTINATION` | apps/api |
| `MUSE_BRIEFING_ENABLED` | apps/cli |
| `MUSE_BRIEFING_HOME_ALERTS` | apps/api, apps/cli |
| `MUSE_BRIEFING_LEAD_MINUTES` | apps/api |
| `MUSE_BRIEFING_PROVIDER` | apps/api |
| `MUSE_BRIEFING_QUIET_HOURS` | apps/api |
| `MUSE_BRIEFING_RELATED_KNOWLEDGE_ENABLED` | apps/api, apps/cli |
| `MUSE_BRIEFING_SIDECAR_FILE` | apps/cli, packages/autoconfigure |
| `MUSE_BRIEFING_TASK_DUE_DAYS` | apps/api |
| `MUSE_BRIEFING_TICK_MS` | apps/api |
| `MUSE_BRIEFING_WINDOW_MS` | apps/api |
| `MUSE_BROWSER_MAX_ACTIONS` | apps/cli |
| `MUSE_BROWSING_AUTO_SYNC` | apps/cli, packages/recall |
| `MUSE_BROWSING_FILE` | apps/cli, packages/autoconfigure, packages/recall |
| `MUSE_BROWSING_SYNC_INTERVAL_MINUTES` | apps/cli |
| `MUSE_BUDGET_MONTHLY_LIMIT_USD` | packages/autoconfigure |
| `MUSE_BUDGET_WARNING_PERCENT` | packages/autoconfigure |
| `MUSE_CACHE_BOUNDARY` | packages/prompts |
| `MUSE_CACHE_BOUNDARY_MARKER` | apps/api, packages/prompts |
| `MUSE_CACHE_ENABLED` | packages/autoconfigure |
| `MUSE_CACHE_MAX_SIZE` | packages/autoconfigure |
| `MUSE_CACHE_TTL_MS` | packages/autoconfigure |
| `MUSE_CALDAV_APP_PASSWORD` | packages/autoconfigure |
| `MUSE_CALDAV_URL` | packages/autoconfigure |
| `MUSE_CALDAV_USERNAME` | packages/autoconfigure |
| `MUSE_CALENDAR_ENABLED` | packages/autoconfigure |
| `MUSE_CALENDAR_FILE` | apps/cli, packages/autoconfigure, packages/mcp |
| `MUSE_CALENDAR_ICS_FILE` | packages/autoconfigure |
| `MUSE_CALENDAR_PROVIDERS` | apps/cli, packages/autoconfigure |
| `MUSE_CANARY` | packages/policy |
| `MUSE_CHANNEL_ACK` | apps/api |
| `MUSE_CHANNEL_ALLOWED_CHATS` | apps/api |
| `MUSE_CHANNEL_GROUP_ENABLED` | apps/api |
| `MUSE_CHANNEL_OWNERS_FILE` | apps/api |
| `MUSE_CHAT_AUTO_REINDEX` | apps/cli |
| `MUSE_CHAT_GROUNDING` | apps/cli |
| `MUSE_CHAT_HISTORY_WINDOW` | apps/cli |
| `MUSE_CHAT_MAX_TOOLS` | apps/cli |
| `MUSE_CHECKINS_AUTOSCAN_ENABLED` | apps/cli |
| `MUSE_CHECKINS_FILE` | apps/cli, packages/autoconfigure |
| `MUSE_CHECKPOINTS_DIR` | packages/autoconfigure |
| `MUSE_CHROME_DEVTOOLS_BROWSER_URL` | packages/autoconfigure |
| `MUSE_CHROME_DEVTOOLS_ENABLED` | apps/cli, packages/autoconfigure |
| `MUSE_CHROME_HISTORY_FILE` | apps/cli, packages/recall |
| `MUSE_CHROME_PATH` | packages/browser |
| `MUSE_CHROME_PROFILE` | apps/cli, packages/recall |
| `MUSE_CIRCUIT_BREAKER_FAILURE_THRESHOLD` | packages/autoconfigure |
| `MUSE_CIRCUIT_BREAKER_RESET_TIMEOUT_MS` | packages/autoconfigure |
| `MUSE_CLI_VERSION` | apps/cli |
| `MUSE_CLOUD_MODEL` | apps/cli, packages/autoconfigure, packages/policy |
| `MUSE_COMPACTION_IMPORTANCE_THRESHOLD` | packages/autoconfigure |
| `MUSE_COMPACTION_STRATEGY` | packages/autoconfigure |
| `MUSE_COMPANION_NO_MODEL` | apps/cli |
| `MUSE_COMPANION_STATE_FILE` | apps/cli |
| `MUSE_CONFLICT_WATCH_ENABLED` | apps/api, apps/cli |
| `MUSE_CONFLICT_WATCH_INTERVAL_MS` | apps/cli |
| `MUSE_CONFLICT_WATCH_SIDECAR_FILE` | apps/cli |
| `MUSE_CONFLICT_WATCH_WITHIN_DAYS` | apps/cli |
| `MUSE_CONTACTS_FILE` | packages/autoconfigure |
| `MUSE_CONTEXT_REF_MAX_ENTRIES` | packages/autoconfigure |
| `MUSE_CONTEXT_REF_TTL_MS` | packages/autoconfigure |
| `MUSE_CONVERSATION_SUMMARY_FILE` | packages/autoconfigure, packages/memory |
| `MUSE_CONVERSATION_SUMMARY_PERSIST` | packages/autoconfigure |
| `MUSE_CORS_ALLOWED_ORIGINS` | packages/autoconfigure |
| `MUSE_CREDENTIALS_FILE` | packages/autoconfigure |
| `MUSE_CREDENTIAL_KEY` | apps/cli |
| `MUSE_CROSS_LINGUAL_COSINE_FLOOR` | packages/recall |
| `MUSE_DAEMON_CONFIG_FILE` | apps/cli |
| `MUSE_DAEMON_PLIST_FILE` | apps/cli |
| `MUSE_DAEMON_SETTINGS_FILE` | apps/api |
| `MUSE_DEFAULT_MODEL` | apps/api, apps/cli, packages/autoconfigure |
| `MUSE_DEFAULT_TIMEZONE` | packages/autoconfigure |
| `MUSE_DELTA_AT` | apps/cli |
| `MUSE_DIGEST_ENABLED` | apps/api, apps/cli |
| `MUSE_DIGEST_HOUR` | apps/api, apps/cli |
| `MUSE_DIGEST_QUEUE_FILE` | packages/autoconfigure |
| `MUSE_DIGEST_SENT_FILE` | packages/autoconfigure |
| `MUSE_DIGEST_TICK_MS` | apps/api |
| `MUSE_DISCORD_AFTER_FILE` | packages/autoconfigure |
| `MUSE_DISCORD_BOT_TOKEN` | apps/api, apps/cli, packages/autoconfigure, packages/domain-tools |
| `MUSE_DISCORD_INBOX_FILE` | packages/autoconfigure |
| `MUSE_DISCORD_POLL_CHANNELS` | apps/api, packages/autoconfigure, packages/domain-tools |
| `MUSE_DISCORD_POLL_ENABLED` | apps/api |
| `MUSE_DISCORD_POLL_INTERVAL_MS` | apps/api |
| `MUSE_DRIFT_DEVIATION_THRESHOLD` | packages/autoconfigure |
| `MUSE_DRIFT_MIN_SAMPLES` | packages/autoconfigure |
| `MUSE_DRIFT_WINDOW_SIZE` | packages/autoconfigure |
| `MUSE_EFFICACY_MODEL` | apps/cli |
| `MUSE_EMAIL_SYNC_ENABLED` | apps/cli |
| `MUSE_EMAIL_SYNC_INTERVAL_MS` | apps/cli |
| `MUSE_EMAIL_SYNC_LIMIT` | apps/cli |
| `MUSE_EMBED_MODEL` | apps/api, apps/cli, packages/autoconfigure |
| `MUSE_EPISODES_FILE` | apps/cli, packages/autoconfigure |
| `MUSE_EPISODES_INDEX_FILE` | packages/recall |
| `MUSE_EPISODIC_MEMORY_ENABLED` | apps/api, apps/cli |
| `MUSE_EPISODIC_MEMORY_MAX_ENTRIES` | apps/cli |
| `MUSE_EPISODIC_RECALL_EMBED` | packages/autoconfigure |
| `MUSE_EPISODIC_RECALL_EMBED_MODEL` | apps/cli, packages/autoconfigure |
| `MUSE_EPISODIC_RECALL_ENABLED` | packages/autoconfigure |
| `MUSE_EPISODIC_RECALL_MAX_FETCHED` | packages/autoconfigure |
| `MUSE_EPISODIC_RECALL_MIN_SCORE` | packages/autoconfigure |
| `MUSE_EPISODIC_RECALL_TOPK` | packages/autoconfigure |
| `MUSE_EVAL_FAST` | apps/cli |
| `MUSE_EXPORT_MAGIC` | apps/cli |
| `MUSE_EXPORT_PASSPHRASE` | apps/cli |
| `MUSE_EXPORT_VERSION` | apps/cli |
| `MUSE_FADED_MEMORIES_FILE` | packages/autoconfigure |
| `MUSE_FAITHFULNESS_TRIPWIRE` | apps/cli |
| `MUSE_FAST_MODEL` | apps/api, apps/cli |
| `MUSE_FEEDS_FILE` | apps/cli, packages/autoconfigure, packages/recall |
| `MUSE_FOCUS_OFF_SHORTCUT` | apps/cli, packages/macos |
| `MUSE_FOCUS_ON_SHORTCUT` | apps/cli, packages/macos |
| `MUSE_FOLLOWUPS_FILE` | apps/cli, packages/autoconfigure |
| `MUSE_FOLLOWUP_CAPTURE_ENABLED` | packages/autoconfigure |
| `MUSE_FOLLOWUP_DEFAULT_DESTINATION` | apps/api |
| `MUSE_FOLLOWUP_DEFAULT_PROVIDER` | apps/api |
| `MUSE_FOLLOWUP_LLM_BUDGET_FILE` | packages/autoconfigure |
| `MUSE_FOLLOWUP_LLM_BUDGET_PER_DAY` | packages/autoconfigure |
| `MUSE_FOLLOWUP_LLM_FALLBACK` | packages/agent-core, packages/autoconfigure, packages/stores |
| `MUSE_FOLLOWUP_LLM_MODEL` | packages/autoconfigure |
| `MUSE_FOLLOWUP_MAX_PER_TICK` | apps/api, packages/proactivity |
| `MUSE_FOLLOWUP_QUIET_HOURS` | apps/api |
| `MUSE_FOLLOWUP_SUGGESTION_MAX_EVENTS` | packages/autoconfigure |
| `MUSE_FOLLOWUP_SUGGESTION_RETENTION_MS` | packages/autoconfigure |
| `MUSE_FOLLOWUP_TICK_MS` | apps/api, packages/proactivity |
| `MUSE_FS_DENY` | apps/cli, packages/fs |
| `MUSE_FS_DOC_ROOTS` | apps/cli, packages/fs |
| `MUSE_FS_ROOTS` | apps/cli, packages/fs |
| `MUSE_FS_TOOLS` | packages/fs |
| `MUSE_GCAL_CALENDAR_ID` | packages/autoconfigure |
| `MUSE_GCAL_CLIENT_ID` | packages/autoconfigure |
| `MUSE_GCAL_CLIENT_SECRET` | packages/autoconfigure |
| `MUSE_GCAL_REFRESH_TOKEN` | packages/autoconfigure |
| `MUSE_GITHUB_MCP_ENABLED` | packages/autoconfigure |
| `MUSE_GIT_REFLOG_FILE` | apps/cli, packages/recall |
| `MUSE_GMAIL_TOKEN` | apps/api, apps/cli, packages/autoconfigure, packages/domain-tools |
| `MUSE_GROUNDING_MIN_COSINE` | apps/cli, packages/agent-core |
| `MUSE_HEAVY_MODEL` | apps/api, apps/cli |
| `MUSE_HISTORY_SEARCH_EMBED_MODEL` | packages/autoconfigure |
| `MUSE_HISTORY_SEARCH_ENABLED` | packages/autoconfigure |
| `MUSE_HISTORY_SEARCH_HYBRID` | packages/autoconfigure |
| `MUSE_HOME` | apps/cli |
| `MUSE_HOMEASSISTANT_TOKEN` | apps/api, apps/cli, packages/autoconfigure, packages/domain-tools |
| `MUSE_HOMEASSISTANT_URL` | apps/api, apps/cli, packages/autoconfigure, packages/domain-tools |
| `MUSE_HOME_WATCH_CONFIG` | apps/api, apps/cli |
| `MUSE_HOME_WATCH_DESTINATION` | apps/api |
| `MUSE_HOME_WATCH_ENABLED` | apps/api |
| `MUSE_HOME_WATCH_PROVIDER` | apps/api |
| `MUSE_HOME_WATCH_QUIET_HOURS` | apps/api |
| `MUSE_HOME_WATCH_TICK_MS` | apps/api |
| `MUSE_HOOK_TRACE_MAX_ENTRIES` | packages/autoconfigure |
| `MUSE_HUD` | apps/cli |
| `MUSE_HUD_SEGMENTS` | apps/cli |
| `MUSE_IDENTITY_CORE` | apps/api, packages/prompts |
| `MUSE_IDENTITY_VERIFY_ROUNDS` | apps/api |
| `MUSE_IDLE_LEARNING_ENABLED` | apps/cli |
| `MUSE_INBOUND_AUTO_APPROVE` | apps/api |
| `MUSE_INBOUND_REPLY_ENABLED` | apps/api, apps/web |
| `MUSE_INBOUND_REPLY_INTERVAL_MS` | apps/api |
| `MUSE_INBOX_CONTEXT_ENABLED` | packages/autoconfigure |
| `MUSE_INBOX_INJECT_LIMIT` | packages/autoconfigure |
| `MUSE_INBOX_INJECT_TOTAL_LIMIT` | packages/autoconfigure |
| `MUSE_INPUT_GUARDS_ENABLED` | packages/autoconfigure |
| `MUSE_INPUT_GUARD_INJECTION_ENABLED` | packages/autoconfigure |
| `MUSE_INPUT_GUARD_PII_ENABLED` | packages/autoconfigure |
| `MUSE_INPUT_HISTORY_FILE` | apps/cli |
| `MUSE_INTERRUPTION_DAILY_CAP` | apps/api, apps/cli |
| `MUSE_INTERRUPTION_HOURLY_CAP` | apps/api, apps/cli |
| `MUSE_INTERRUPTION_LEDGER_FILE` | packages/autoconfigure |
| `MUSE_JOBS_DIR` | apps/cli |
| `MUSE_JOBS_MAX_CONCURRENT` | apps/cli |
| `MUSE_KNOWLEDGE_SEARCH_EMBED_MODEL` | apps/api, apps/cli, packages/autoconfigure |
| `MUSE_KNOWLEDGE_SEARCH_ENABLED` | apps/api, packages/autoconfigure |
| `MUSE_LAST_PROACTIVE_FILE` | packages/autoconfigure |
| `MUSE_LEARNING_PAUSE_FILE` | packages/autoconfigure |
| `MUSE_LEARN_QUEUE_FILE` | packages/stores |
| `MUSE_LINE_CHANNEL_ACCESS_TOKEN` | apps/api, apps/cli, packages/autoconfigure, packages/domain-tools |
| `MUSE_LINE_CHANNEL_SECRET` | apps/api |
| `MUSE_LINE_INBOX_FILE` | packages/autoconfigure, packages/messaging |
| `MUSE_LLM_MAX_CONTEXT_WINDOW_TOKENS` | packages/autoconfigure |
| `MUSE_LLM_MAX_OUTPUT_TOKENS` | packages/autoconfigure |
| `MUSE_LLM_WORKING_BUDGET_TOKENS` | packages/autoconfigure |
| `MUSE_LOCAL_ONLY` | apps/cli, packages/autoconfigure, packages/model, packages/policy |
| `MUSE_LOGPROBS` | apps/cli |
| `MUSE_LOOPBACK_FETCH_HOSTS` | packages/autoconfigure |
| `MUSE_LOOPBACK_FS_ROOTS` | packages/autoconfigure |
| `MUSE_LOOPBACK_MCP_ENABLED` | packages/autoconfigure |
| `MUSE_MACOS_ACTUATORS` | apps/cli |
| `MUSE_MACOS_CALENDAR_NAME` | packages/autoconfigure |
| `MUSE_MATH_ENABLED` | packages/autoconfigure |
| `MUSE_MATRIX_ACCESS_TOKEN` | apps/api, packages/autoconfigure |
| `MUSE_MATRIX_HOMESERVER_URL` | packages/autoconfigure |
| `MUSE_MATRIX_INBOX_FILE` | packages/autoconfigure |
| `MUSE_MATRIX_LONG_POLL_SECONDS` | apps/api |
| `MUSE_MATRIX_POLL_ENABLED` | apps/api, apps/web |
| `MUSE_MATRIX_POLL_INTERVAL_MS` | apps/api |
| `MUSE_MATRIX_SINCE_FILE` | packages/autoconfigure |
| `MUSE_MAX_TOOL_OUTPUT_CHARS` | apps/cli, packages/autoconfigure |
| `MUSE_MCP_ALLOWED_SERVERS` | packages/autoconfigure |
| `MUSE_MCP_ALLOWED_STDIO_COMMANDS` | packages/autoconfigure |
| `MUSE_MCP_ALLOW_PRIVATE_ADDRESSES` | packages/autoconfigure |
| `MUSE_MCP_CLIENT_ROOTS` | packages/autoconfigure, packages/mcp |
| `MUSE_MCP_CONFIG` | apps/cli, packages/autoconfigure |
| `MUSE_MCP_CREDENTIALS_FILE` | packages/autoconfigure |
| `MUSE_MCP_MAX_SERVERS` | packages/autoconfigure |
| `MUSE_MCP_MAX_TOOL_OUTPUT_LENGTH` | packages/autoconfigure |
| `MUSE_MCP_RECONNECT_ENABLED` | packages/autoconfigure |
| `MUSE_MCP_RECONNECT_INITIAL_DELAY_MS` | packages/autoconfigure |
| `MUSE_MCP_RECONNECT_MAX_ATTEMPTS` | packages/autoconfigure |
| `MUSE_MCP_RECONNECT_MAX_DELAY_MS` | packages/autoconfigure |
| `MUSE_MCP_REQUEST_TIMEOUT_MS` | packages/autoconfigure |
| `MUSE_MEMORY_KEY` | apps/cli, packages/memory, packages/stores |
| `MUSE_MENTION` | apps/api |
| `MUSE_MESSAGING_CREDENTIALS_FILE` | packages/autoconfigure |
| `MUSE_MESSAGING_LIBNOTIFY_ENABLED` | packages/autoconfigure, packages/messaging |
| `MUSE_MESSAGING_LIBNOTIFY_TITLE` | packages/autoconfigure |
| `MUSE_MESSAGING_LIBNOTIFY_URGENCY` | packages/autoconfigure |
| `MUSE_MESSAGING_LOG_ENABLED` | packages/autoconfigure |
| `MUSE_MESSAGING_LOG_FILE` | apps/cli, packages/autoconfigure, packages/mcp |
| `MUSE_MESSAGING_MACOS_NOTIFICATION_ENABLED` | packages/autoconfigure, packages/messaging |
| `MUSE_MESSAGING_MACOS_NOTIFICATION_TITLE` | packages/autoconfigure |
| `MUSE_MESSAGING_POLL_ENABLED` | apps/cli |
| `MUSE_MESSAGING_POLL_INTERVAL_MS` | apps/cli |
| `MUSE_MODEL` | apps/api, apps/cli, apps/web, packages/autoconfigure, packages/domain-tools, packages/model |
| `MUSE_MODEL_API_KEY` | packages/autoconfigure |
| `MUSE_MODEL_BASE_URL` | apps/cli, packages/autoconfigure, packages/model |
| `MUSE_MODEL_EXTRA_HEADERS` | packages/autoconfigure |
| `MUSE_MODEL_KEYS_FILE` | packages/autoconfigure |
| `MUSE_MODEL_LIST` | packages/autoconfigure |
| `MUSE_MODEL_PROVIDER_ID` | apps/cli, apps/web, packages/autoconfigure |
| `MUSE_MODEL_REQUEST_TIMEOUT_MS` | packages/autoconfigure |
| `MUSE_MODEL_TIMEOUT_MS` | packages/autoconfigure, packages/model |
| `MUSE_MODEL_TRACE` | packages/model |
| `MUSE_MULTI_AGENT_DEFAULT_WORKERS` | packages/autoconfigure |
| `MUSE_MULTI_AGENT_WORKER_TIMEOUT_MS` | apps/api |
| `MUSE_NOTES_DIR` | apps/cli, packages/autoconfigure, packages/domain-tools, packages/mcp, packages/recall |
| `MUSE_NOTES_ENABLED` | packages/autoconfigure |
| `MUSE_NOTES_INDEX_FILE` | apps/cli, packages/autoconfigure |
| `MUSE_NOTES_PROVIDERS` | packages/autoconfigure |
| `MUSE_NOTES_SEARCH_END` | packages/domain-tools |
| `MUSE_NOTE_PROVENANCE_FILE` | packages/autoconfigure |
| `MUSE_NOTION_DATABASE_ID` | packages/autoconfigure |
| `MUSE_NOTION_MCP_ENABLED` | packages/autoconfigure |
| `MUSE_NOTION_TASKS_DATABASE_ID` | packages/autoconfigure |
| `MUSE_NOTION_TASKS_STATUS_DONE` | packages/autoconfigure |
| `MUSE_NOTION_TASKS_STATUS_OPEN` | packages/autoconfigure |
| `MUSE_NOTION_TASKS_STATUS_PROPERTY` | packages/autoconfigure |
| `MUSE_NOTION_TASKS_TITLE_PROPERTY` | packages/autoconfigure |
| `MUSE_NOTION_TASKS_TOKEN` | packages/autoconfigure |
| `MUSE_NOTION_TITLE_PROPERTY` | packages/autoconfigure |
| `MUSE_NOTION_TOKEN` | packages/autoconfigure |
| `MUSE_NO_ANIM` | apps/cli |
| `MUSE_OBJECTIVES_DESTINATION` | apps/api |
| `MUSE_OBJECTIVES_FILE` | apps/cli, packages/autoconfigure |
| `MUSE_OBJECTIVES_MAX_PER_TICK` | apps/api, packages/proactivity |
| `MUSE_OBJECTIVES_PROPOSE` | apps/cli |
| `MUSE_OBJECTIVES_PROVIDER` | apps/api |
| `MUSE_OBJECTIVES_QUIET_HOURS` | apps/api |
| `MUSE_OBJECTIVES_TICK_MS` | apps/api |
| `MUSE_OLLAMA_KEEP_ALIVE` | apps/cli, packages/autoconfigure, packages/model |
| `MUSE_OLLAMA_LEASE_FILE` | packages/stores |
| `MUSE_OLLAMA_NUM_BATCH` | apps/cli, packages/autoconfigure, packages/model |
| `MUSE_OLLAMA_NUM_CTX` | apps/cli, packages/autoconfigure, packages/model |
| `MUSE_OLLAMA_NUM_GPU` | packages/autoconfigure, packages/model |
| `MUSE_OLLAMA_NUM_PREDICT` | apps/cli, packages/autoconfigure, packages/model |
| `MUSE_OLLAMA_NUM_THREAD` | packages/autoconfigure, packages/model |
| `MUSE_OLLAMA_PROBE_CONTEXT` | packages/autoconfigure, packages/model |
| `MUSE_OUTPUT_GUARDS_ENABLED` | packages/autoconfigure |
| `MUSE_OUTPUT_GUARD_PII_MASK_ENABLED` | packages/autoconfigure |
| `MUSE_OUTPUT_GUARD_SYSTEM_PROMPT_CANARY_TOKENS` | packages/autoconfigure |
| `MUSE_OUTPUT_GUARD_SYSTEM_PROMPT_LEAK_ENABLED` | packages/autoconfigure |
| `MUSE_PARENT_PID` | apps/api |
| `MUSE_PATTERNS_FIRED_FILE` | apps/cli, packages/autoconfigure |
| `MUSE_PEER_ALICE` | packages/a2a |
| `MUSE_PENDING_APPROVALS_FILE` | packages/autoconfigure |
| `MUSE_PERSONA` | apps/cli |
| `MUSE_PERSONA_FILE` | apps/cli |
| `MUSE_PERSONA_MAX_ENTRIES` | apps/cli |
| `MUSE_PERSONA_MD_FILE` | packages/autoconfigure, packages/recall |
| `MUSE_PIPER_PATH` | packages/autoconfigure |
| `MUSE_PIPER_VOICE` | apps/cli, packages/autoconfigure |
| `MUSE_PLAN_CACHE` | packages/autoconfigure |
| `MUSE_PLAN_CACHE_FILE` | packages/autoconfigure |
| `MUSE_PLAYBOOK` | packages/autoconfigure |
| `MUSE_PLAYBOOK_DISTILL` | apps/cli |
| `MUSE_PLAYBOOK_DISTILL_ENABLED` | apps/cli |
| `MUSE_PLAYBOOK_EMBED_MODEL` | apps/cli |
| `MUSE_PLAYBOOK_EMBED_RANK` | apps/cli |
| `MUSE_PLAYBOOK_FILE` | apps/cli, packages/autoconfigure |
| `MUSE_PLAYBOOK_INJECTIONS_FILE` | apps/cli |
| `MUSE_PLAYBOOK_INJECT_TOPK` | apps/cli |
| `MUSE_PREFERENCE_AUTOINFER_ENABLED` | apps/cli |
| `MUSE_PRIVACY_ROUTING` | apps/cli, packages/policy |
| `MUSE_PROACTIVE_` | apps/cli |
| `MUSE_PROACTIVE_ACTIVE_SESSION_WINDOW_MS` | apps/api |
| `MUSE_PROACTIVE_AGENT_TURN` | apps/api, packages/autoconfigure |
| `MUSE_PROACTIVE_DAILY_CAP` | apps/api, apps/cli |
| `MUSE_PROACTIVE_DESTINATION` | apps/api, apps/cli, packages/autoconfigure |
| `MUSE_PROACTIVE_HISTORY_FILE` | apps/cli, packages/autoconfigure, packages/mcp |
| `MUSE_PROACTIVE_LEAD_MINUTES` | apps/api, apps/cli, packages/autoconfigure |
| `MUSE_PROACTIVE_PATTERN_` | packages/memory |
| `MUSE_PROACTIVE_PATTERN_COOLDOWN_MS` | apps/api |
| `MUSE_PROACTIVE_PATTERN_DESTINATION` | apps/api |
| `MUSE_PROACTIVE_PATTERN_ENABLED` | apps/api, apps/cli |
| `MUSE_PROACTIVE_PATTERN_MAX_PER_TICK` | apps/api |
| `MUSE_PROACTIVE_PATTERN_MIN_CONFIDENCE` | apps/api |
| `MUSE_PROACTIVE_PATTERN_PROVIDER` | apps/api |
| `MUSE_PROACTIVE_PATTERN_QUIET_HOURS` | apps/api |
| `MUSE_PROACTIVE_PATTERN_TICK_MS` | apps/api |
| `MUSE_PROACTIVE_PRESENCE_FILE` | apps/api |
| `MUSE_PROACTIVE_PROVIDER` | apps/api, apps/cli, packages/autoconfigure |
| `MUSE_PROACTIVE_QUIET_HOURS` | apps/api, apps/cli, packages/autoconfigure, packages/proactivity |
| `MUSE_PROACTIVE_SIDECAR_FILE` | apps/api, apps/cli, packages/autoconfigure, packages/stores |
| `MUSE_PROACTIVE_TICK_MS` | apps/api, packages/autoconfigure |
| `MUSE_PROACTIVE_TRUST_FILE` | apps/api, apps/cli |
| `MUSE_PROMPT_TOKEN_BUDGET` | packages/autoconfigure |
| `MUSE_PROPOSED_ACTIONS_FILE` | apps/cli |
| `MUSE_PRUNE_META_FILE` | apps/cli |
| `MUSE_QUORUM_HEDGE` | apps/cli |
| `MUSE_RATE_LIMIT_CHAT_DISABLED` | apps/api |
| `MUSE_RATE_LIMIT_CHAT_PER_MINUTE` | apps/api |
| `MUSE_RECALL_BM25` | packages/autoconfigure |
| `MUSE_RECALL_EMBED_MODEL` | apps/cli |
| `MUSE_RECALL_HITS_FILE` | packages/autoconfigure |
| `MUSE_RECALL_SECOND_HOP` | packages/autoconfigure, packages/recall |
| `MUSE_RECALL_TEST_QUERY_EMBEDDING` | apps/cli |
| `MUSE_RECALL_TRAILS_FILE` | apps/cli |
| `MUSE_RECAP_ENABLED` | apps/cli |
| `MUSE_RECAP_HOUR` | apps/cli |
| `MUSE_RECAP_SIDECAR_FILE` | apps/cli |
| `MUSE_REFLECTIONS_FILE` | packages/autoconfigure |
| `MUSE_REFLECTION_ENABLED` | apps/cli |
| `MUSE_REFLECTION_INTERVAL_MS` | apps/cli |
| `MUSE_REMINDERS_FILE` | apps/cli, packages/autoconfigure, packages/mcp |
| `MUSE_REMINDERS_LIST_MAX` | packages/autoconfigure |
| `MUSE_REMINDERS_SEARCH_END` | packages/domain-tools |
| `MUSE_REMINDER_ACTIVE_SESSION_WINDOW_MS` | apps/api |
| `MUSE_REMINDER_AGENT_TURN` | apps/api, packages/autoconfigure |
| `MUSE_REMINDER_DEFAULT_DESTINATION` | apps/api, packages/autoconfigure |
| `MUSE_REMINDER_DEFAULT_PROVIDER` | apps/api, packages/autoconfigure |
| `MUSE_REMINDER_HISTORY_FILE` | apps/cli, packages/autoconfigure, packages/mcp |
| `MUSE_REMINDER_QUIET_HOURS` | apps/api, apps/cli, packages/autoconfigure, packages/proactivity |
| `MUSE_REMINDER_TICK_MS` | apps/api, packages/autoconfigure |
| `MUSE_REQUIRE_AUTH` | packages/autoconfigure |
| `MUSE_RESPONSE_CASUAL_LURE_STRIP_ENABLED` | packages/autoconfigure |
| `MUSE_RESPONSE_COUNT_CONSISTENCY_ENABLED` | packages/autoconfigure |
| `MUSE_RESPONSE_COUNT_INJECTION_ENABLED` | packages/autoconfigure |
| `MUSE_RESPONSE_FABRICATION_REFUSAL_ENABLED` | packages/autoconfigure |
| `MUSE_RESPONSE_GREETING_STRIP_ENABLED` | packages/autoconfigure |
| `MUSE_RESPONSE_LOCALES` | apps/api, packages/autoconfigure |
| `MUSE_RESPONSE_MARKDOWN_STRIP_FILTER_ENABLED` | packages/autoconfigure |
| `MUSE_RESPONSE_MAX_LENGTH` | packages/autoconfigure |
| `MUSE_RESPONSE_SANITIZED_TEXT_FILTER_ENABLED` | packages/autoconfigure |
| `MUSE_RESPONSE_SANITIZED_TEXT_REPLACEMENT` | packages/autoconfigure |
| `MUSE_RESPONSE_SOURCE_FILTER_ENABLED` | packages/autoconfigure |
| `MUSE_RESPONSE_STRUCTURED_OUTPUT_FILTER_ENABLED` | packages/autoconfigure |
| `MUSE_RESPONSE_TOOL_RESULT_QUALITY_AUDIT_ENABLED` | packages/autoconfigure |
| `MUSE_RESPONSE_VERIFIED_SOURCES_ENABLED` | packages/autoconfigure |
| `MUSE_RESPONSE_ZERO_RESULT_OVERCLAIM_FILTER_ENABLED` | packages/autoconfigure |
| `MUSE_RETRY_INITIAL_DELAY_MS` | packages/autoconfigure |
| `MUSE_RETRY_MAX_ATTEMPTS` | packages/autoconfigure |
| `MUSE_RUNNER_ENABLED` | packages/autoconfigure |
| `MUSE_RUNNER_PATH` | packages/autoconfigure |
| `MUSE_RUNNER_SANDBOX` | apps/cli, packages/tools |
| `MUSE_RUNTIME_SPEC` | apps/cli |
| `MUSE_RUNTIME_SPEC_TEXT` | apps/cli |
| `MUSE_RUN_LOG_MAX_FILES` | apps/cli |
| `MUSE_SCHEDULER_CRON_ENABLED` | packages/autoconfigure |
| `MUSE_SCHEDULER_MAX_EXECUTIONS` | packages/autoconfigure |
| `MUSE_SCHEDULER_MAX_JOBS` | packages/autoconfigure |
| `MUSE_SCHEDULER_OWNER_ID` | packages/autoconfigure |
| `MUSE_SCHEDULER_PAUSE_FILE` | packages/stores |
| `MUSE_SEARCH_ENABLED` | packages/autoconfigure |
| `MUSE_SEARXNG_ENGINES` | apps/cli, packages/autoconfigure |
| `MUSE_SEARXNG_URL` | apps/cli, packages/autoconfigure, packages/domain-tools |
| `MUSE_SECRET_` | apps/cli, packages/calendar, packages/secrets |
| `MUSE_SECRET_TELEGRAM_BOT_TOKEN` | packages/secrets |
| `MUSE_SECTION_MARKER` | packages/agent-core |
| `MUSE_SELFLEARN` | apps/cli, packages/stores |
| `MUSE_SELFLEARN_CONSOLIDATE_INTERVAL_MS` | apps/cli |
| `MUSE_SELFLEARN_DECAY_INTERVAL_MS` | apps/cli |
| `MUSE_SELFLEARN_ENABLED` | apps/cli |
| `MUSE_SELFLEARN_INTERVAL_MS` | apps/cli |
| `MUSE_SESSION_LOCK_FILE` | apps/cli, packages/autoconfigure |
| `MUSE_SHELL_HISTORY_FILE` | apps/cli, packages/recall |
| `MUSE_SITE_URL` | packages/autoconfigure |
| `MUSE_SKILLS_DIR` | apps/cli, packages/autoconfigure |
| `MUSE_SKILLS_ENABLED` | packages/autoconfigure |
| `MUSE_SKILL_AUTHOR_ENABLED` | apps/cli |
| `MUSE_SKILL_CONSOLIDATE_ENABLED` | apps/api, apps/cli |
| `MUSE_SKILL_CONSOLIDATE_IDLE_ENABLED` | apps/api |
| `MUSE_SKILL_CONSOLIDATE_IDLE_MS` | apps/api |
| `MUSE_SKILL_CONSOLIDATE_QUIET_HOURS` | apps/api |
| `MUSE_SKILL_CONSOLIDATE_TICK_MS` | apps/api |
| `MUSE_SKILL_COOLDOWN_FILE` | apps/api |
| `MUSE_SKILL_CURATE_IDLE_DAYS` | apps/api |
| `MUSE_SKILL_REWARDS_FILE` | packages/autoconfigure |
| `MUSE_SKIP_FIRST_RUN` | apps/cli |
| `MUSE_SLACK_AFTER_FILE` | packages/autoconfigure |
| `MUSE_SLACK_BOT_TOKEN` | apps/api, apps/cli, packages/autoconfigure, packages/domain-tools |
| `MUSE_SLACK_INBOX_FILE` | packages/autoconfigure |
| `MUSE_SLACK_POLL_CHANNELS` | apps/api, packages/autoconfigure, packages/domain-tools |
| `MUSE_SLACK_POLL_ENABLED` | apps/api |
| `MUSE_SLACK_POLL_INTERVAL_MS` | apps/api |
| `MUSE_SLEEP_PROMOTE` | apps/cli |
| `MUSE_SLO_COOLDOWN_SECONDS` | packages/autoconfigure |
| `MUSE_SLO_ERROR_RATE_THRESHOLD` | packages/autoconfigure |
| `MUSE_SLO_LATENCY_THRESHOLD_MS` | packages/autoconfigure |
| `MUSE_SLO_MIN_SAMPLES` | packages/autoconfigure |
| `MUSE_SLO_WINDOW_SECONDS` | packages/autoconfigure |
| `MUSE_SNAPSHOT_UNAVAILABLE` | apps/api |
| `MUSE_STATUS_SCHEMA_VERSION` | apps/cli |
| `MUSE_STREAM_IDLE_TIMEOUT_MS` | packages/agent-core, packages/autoconfigure |
| `MUSE_SUPPRESSED_LESSONS_FILE` | packages/autoconfigure |
| `MUSE_SWARM_QUARANTINE_FILE` | apps/cli |
| `MUSE_TAGLINE` | apps/cli |
| `MUSE_TAGLINE_NO_MODEL` | apps/api |
| `MUSE_TAGLINE_STATE_FILE` | apps/api |
| `MUSE_TASKS_ENABLED` | packages/autoconfigure |
| `MUSE_TASKS_FILE` | apps/cli, packages/autoconfigure, packages/mcp |
| `MUSE_TASKS_LIST_MAX` | packages/autoconfigure |
| `MUSE_TASKS_PROVIDERS` | packages/autoconfigure, packages/domain-tools |
| `MUSE_TASK_MEMORY_FILE` | packages/autoconfigure, packages/memory |
| `MUSE_TASK_MEMORY_MAX_TASKS` | packages/autoconfigure |
| `MUSE_TASK_MEMORY_PERSIST` | packages/autoconfigure |
| `MUSE_TASK_MEMORY_RETENTION_MS` | packages/autoconfigure |
| `MUSE_TELEGRAM_ACK_REACTION` | apps/api |
| `MUSE_TELEGRAM_BOT_TOKEN` | apps/api, apps/cli, packages/autoconfigure, packages/domain-tools |
| `MUSE_TELEGRAM_INBOX_FILE` | packages/autoconfigure |
| `MUSE_TELEGRAM_LONG_POLL_SECONDS` | apps/api |
| `MUSE_TELEGRAM_OFFSET_FILE` | packages/autoconfigure |
| `MUSE_TELEGRAM_POLL_ENABLED` | apps/api, apps/web |
| `MUSE_TELEGRAM_POLL_INTERVAL_MS` | apps/api, apps/web |
| `MUSE_TELEMETRY_AGGREGATOR_CAPACITY` | packages/autoconfigure |
| `MUSE_TELEMETRY_AGGREGATOR_ENABLED` | apps/api, apps/cli, packages/autoconfigure |
| `MUSE_TIERED_CASCADE` | apps/api |
| `MUSE_TIER_SINGLE_MODEL_HOST` | apps/api |
| `MUSE_TIMINGS` | apps/cli |
| `MUSE_TOKEN_COST_TODAY_FILE` | apps/cli |
| `MUSE_TOKEN_USAGE_FILE` | packages/autoconfigure |
| `MUSE_TOOLS_ENABLED` | packages/autoconfigure |
| `MUSE_TOOL_EXEMPLARS` | packages/agent-core, packages/autoconfigure |
| `MUSE_TOOL_FILTER_ENABLED` | packages/autoconfigure |
| `MUSE_TRUST_FILE` | apps/cli, packages/mcp |
| `MUSE_USER_ID` | apps/cli, packages/autoconfigure, packages/domain-tools, packages/memory |
| `MUSE_USER_MEMORY_AUTO_EXTRACT` | apps/cli, packages/autoconfigure, packages/memory |
| `MUSE_USER_MEMORY_AUTO_EXTRACT_MODEL` | packages/autoconfigure |
| `MUSE_USER_MEMORY_FILE` | apps/cli, packages/autoconfigure, packages/mcp |
| `MUSE_USER_MEMORY_INJECTION` | packages/autoconfigure |
| `MUSE_USER_MEMORY_PERSIST` | apps/cli, packages/autoconfigure |
| `MUSE_VETOES_FILE` | packages/autoconfigure |
| `MUSE_VETO_AVOIDANCE` | packages/autoconfigure |
| `MUSE_VISION_MODEL` | apps/cli, packages/autoconfigure |
| `MUSE_VOICE_OPENAI_API_KEY` | apps/cli, packages/autoconfigure |
| `MUSE_VOICE_STT` | apps/cli, packages/autoconfigure |
| `MUSE_VOICE_STT_MODEL` | packages/autoconfigure |
| `MUSE_VOICE_TTS` | apps/cli, packages/autoconfigure |
| `MUSE_VOICE_TTS_MODEL` | packages/autoconfigure |
| `MUSE_VOICE_TTS_VOICE` | packages/autoconfigure |
| `MUSE_WARMUP_MODEL` | apps/api |
| `MUSE_WEAKNESSES_FILE` | packages/autoconfigure |
| `MUSE_WEATHER_LOCATION` | apps/api, apps/cli, packages/autoconfigure |
| `MUSE_WEB_DIR` | apps/api |
| `MUSE_WEB_EGRESS` | apps/cli, packages/autoconfigure, packages/model |
| `MUSE_WEB_READ_ENABLED` | packages/autoconfigure |
| `MUSE_WEB_SEARCH` | packages/autoconfigure, packages/model |
| `MUSE_WEB_SEARCH_MAX_USES` | packages/autoconfigure, packages/model |
| `MUSE_WEB_WATCH_CONFIG` | apps/api, apps/cli |
| `MUSE_WEB_WATCH_DESTINATION` | apps/api |
| `MUSE_WEB_WATCH_ENABLED` | apps/api |
| `MUSE_WEB_WATCH_PROVIDER` | apps/api |
| `MUSE_WEB_WATCH_QUIET_HOURS` | apps/api |
| `MUSE_WEB_WATCH_TICK_MS` | apps/api |
| `MUSE_WHISPER_CPP_MODEL` | apps/cli, packages/autoconfigure, packages/voice |
| `MUSE_WHISPER_CPP_PATH` | apps/cli, packages/autoconfigure, packages/voice |
| `MUSE_WINDOWS_ACTUATORS` | apps/cli |
| `MUSE_WORDMARK` | apps/cli |
| `MUSE_WORKSPACE_SKILLS_DIR` | packages/autoconfigure |
