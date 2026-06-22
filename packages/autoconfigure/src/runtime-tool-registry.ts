/**
 * Runtime tool-registry builder — extracted from
 * `createMuseRuntimeAssembly` so the composition root no longer carries
 * the knowledge/home/email tool IIFEs and the long `DynamicToolRegistry`
 * tool-source array inline. Takes an explicit deps object the assembly
 * threads through (the loopback tool bundles, stores, registries,
 * scheduler handle, and the `let`-mutated context-reference getter);
 * behaviour is preserved line-for-line.
 */

import { createCachingEmbedder } from "@muse/agent-core";
import type { CalendarProviderRegistry } from "@muse/calendar";
import { withChromeDevToolsRisk, withOfficialMcpRisk, type McpManager } from "@muse/mcp";
import { addContact, queryContacts, readActionLog, readFollowups, readObjectives, readReminders, readTasks, removeContact, resolveUpcomingBirthdays } from "@muse/stores";
import { collectDatedNotes, createContactsAddTool, createContactsFindTool, createContactsRemoveTool, createEmailReadMessageTool, createEmailReadTool, createEmailSearchTool, createFeedsSearchTool, createHomeEntitiesTool, createHomeStateTool, createObjectivesListTool, createOnThisDayTool, createRecentActionsTool, createRememberFactTool, createUpcomingBirthdaysTool, createWeatherTool, createWorldTimeTool, GmailEmailProvider, type NotesProviderRegistry, type TasksProviderRegistry } from "@muse/domain-tools";
import type { UserMemoryStore } from "@muse/memory";
import { createSchedulerTools, DynamicScheduler } from "@muse/scheduler";
import type { MuseTool } from "@muse/tools";

import { createOllamaEmbedder } from "./context-engineering-builders.js";
import { readEpisodeKnowledgeEntries } from "./episodes-knowledge-source.js";
import { parseBoolean } from "./env-parsers.js";
import { readFeedKnowledgeEntries } from "./feeds-knowledge-source.js";
import { createNotesKnowledgeSearchTool } from "./knowledge-corpus.js";
import {
  resolveActionLogFile,
  resolveContactsFile,
  resolveFeedsFile,
  resolveObjectivesFile,
  resolveRemindersFile,
  resolveFollowupsFile
} from "./personal-providers.js";
import { createDayRecapTool } from "./day-recap-tool.js";
import { createFindItemsTool } from "./find-items-tool.js";
import { createOverdueContactsTool, interactionsFromEvents } from "./relationship-tool.js";
import { createTodayBriefTool } from "./today-brief-tool.js";
import { createUserMemoryKnowledgeSource } from "./user-memory-knowledge-source.js";
import { createWeekAgendaTool } from "./week-agenda-tool.js";
import { resolveDefaultUserId } from "./user-id.js";
import { DynamicToolRegistry } from "./dynamic-tool-registry.js";
import type { ApiServerAssemblyOptions, MuseEnvironment } from "./index.js";

export interface RuntimeToolRegistryDeps {
  readonly env: MuseEnvironment;
  readonly options: ApiServerAssemblyOptions;
  readonly calendarRegistry?: CalendarProviderRegistry;
  readonly notesRegistry?: NotesProviderRegistry;
  readonly tasksRegistry?: TasksProviderRegistry;
  readonly userMemoryStore: UserMemoryStore;
  readonly notesDir: string;
  readonly tasksFile: string;
  readonly episodesFile: string;
  readonly mcp: { readonly manager: McpManager };
  readonly schedulerHandle: { current: DynamicScheduler | undefined };
  readonly runnerTools: readonly MuseTool[];
  readonly skillTools: readonly MuseTool[];
  readonly museTools: readonly MuseTool[];
  readonly loopbackMcpTools: readonly MuseTool[];
  /** `let`-mutated in the assembly (assigned after `activeContextProvider`); read lazily. */
  readonly getContextReferenceLoopbackTools: () => readonly MuseTool[];
  readonly loopback: {
    readonly notes: readonly MuseTool[];
    readonly notesRegistry: readonly MuseTool[];
    readonly calendar: readonly MuseTool[];
    readonly tasks: readonly MuseTool[];
    readonly tasksRegistry: readonly MuseTool[];
    readonly messaging: readonly MuseTool[];
    readonly reminders: readonly MuseTool[];
    readonly proactive: readonly MuseTool[];
    readonly followups: readonly MuseTool[];
    readonly episodes: readonly MuseTool[];
    readonly patterns: readonly MuseTool[];
    readonly history: readonly MuseTool[];
    readonly status: readonly MuseTool[];
    readonly webRead: readonly MuseTool[];
    readonly math: readonly MuseTool[];
    readonly search: readonly MuseTool[];
  };
}

export function buildRuntimeToolRegistry(deps: RuntimeToolRegistryDeps): DynamicToolRegistry {
  const {
    env,
    options,
    calendarRegistry,
    notesRegistry,
    tasksRegistry,
    userMemoryStore,
    notesDir,
    tasksFile,
    episodesFile,
    mcp,
    schedulerHandle,
    runnerTools,
    skillTools,
    museTools,
    loopbackMcpTools,
    getContextReferenceLoopbackTools,
    loopback
  } = deps;
  const notesLoopbackTools = loopback.notes;
  const notesRegistryLoopbackTools = loopback.notesRegistry;
  const calendarLoopbackTools = loopback.calendar;
  const tasksLoopbackTools = loopback.tasks;
  const tasksRegistryLoopbackTools = loopback.tasksRegistry;
  const messagingLoopbackTools = loopback.messaging;
  const remindersLoopbackTools = loopback.reminders;
  const proactiveLoopbackTools = loopback.proactive;
  const followupsLoopbackTools = loopback.followups;
  const episodesLoopbackTools = loopback.episodes;
  const patternsLoopbackTools = loopback.patterns;
  const historyLoopbackTools = loopback.history;
  const statusLoopbackTools = loopback.status;
  const webReadLoopbackTools = loopback.webRead;
  const mathLoopbackTools = loopback.math;
  const searchLoopbackTools = loopback.search;

  // Expose `knowledge_search` over the user's live
  // notes when opted in. Off by default — it embeds the corpus per
  // query (local Ollama), so it stays opt-in like episodic embedding.
  const knowledgeSearchTools: MuseTool[] = (() => {
    const notesProvider = notesRegistry?.primary();
    if (!parseBoolean(env.MUSE_KNOWLEDGE_SEARCH_ENABLED, false) || !notesProvider) {
      return [];
    }
    const embedModel = env.MUSE_KNOWLEDGE_SEARCH_EMBED_MODEL?.trim() || "nomic-embed-text-v2-moe";
    const tasksProvider = tasksRegistry?.primary();
    const gmailToken = env.MUSE_GMAIL_TOKEN?.trim();
    const emailSource = gmailToken ? new GmailEmailProvider(gmailToken) : undefined;
    return [createNotesKnowledgeSearchTool({
      embed: createCachingEmbedder(createOllamaEmbedder(embedModel)),
      notesProvider,
      ...(tasksProvider ? { tasksProvider } : {}),
      ...(calendarRegistry ? { calendarSource: calendarRegistry } : {}),
      ...(emailSource ? { emailSource } : {}),
      contactsSource: { list: () => queryContacts(resolveContactsFile(env)) },
      remindersSource: {
        list: async () => (await readReminders(resolveRemindersFile(env)))
          .filter((reminder) => reminder.status === "pending")
          .map((reminder) => ({ dueAt: reminder.dueAt, id: reminder.id, text: reminder.text }))
      },
      followupsSource: {
        list: async () => (await readFollowups(resolveFollowupsFile(env)))
          .filter((followup) => followup.status === "scheduled")
          .map((followup) => ({ id: followup.id, summary: followup.summary }))
      },
      objectivesSource: {
        list: async () => (await readObjectives(resolveObjectivesFile(env)))
          .filter((objective) => objective.status === "active" || objective.status === "escalated")
          .map((objective) => ({ id: objective.id, spec: objective.spec }))
      },
      feedsSource: {
        recentEntries: (limit) => readFeedKnowledgeEntries(resolveFeedsFile(env), limit)
      },
      episodesSource: {
        recentEpisodes: (limit) => readEpisodeKnowledgeEntries(episodesFile, resolveDefaultUserId(env), limit)
      },
      userMemorySource: createUserMemoryKnowledgeSource(userMemoryStore, resolveDefaultUserId(env))
    })];
  })();

  // Smart-home READ tools (home_state / home_entities) — perception, no
  // approval gate (unlike the gated home_action write). Opt-in via the
  // Home Assistant base URL + long-lived token.
  const homeReadTools: MuseTool[] = (() => {
    const haUrl = env.MUSE_HOMEASSISTANT_URL?.trim();
    const haToken = env.MUSE_HOMEASSISTANT_TOKEN?.trim();
    if (!haUrl || !haToken) {
      return [];
    }
    return [
      createHomeStateTool({ baseUrl: haUrl, token: haToken }),
      createHomeEntitiesTool({ baseUrl: haUrl, token: haToken })
    ];
  })();

  // Email READ tool (email_recent) — perception, read-only. Opt-in via
  // the Gmail token (the same gate the email knowledge source uses).
  const emailReadTools: MuseTool[] = (() => {
    const gmailToken = env.MUSE_GMAIL_TOKEN?.trim();
    if (!gmailToken) {
      return [];
    }
    const provider = new GmailEmailProvider(gmailToken);
    return [
      createEmailReadTool({ provider }),
      createEmailReadMessageTool({ reader: provider }),
      createEmailSearchTool({ searcher: provider })
    ];
  })();

  return new DynamicToolRegistry([
    () => museTools,
    () => loopbackMcpTools,
    () => getContextReferenceLoopbackTools(),
    () => notesLoopbackTools,
    () => notesRegistryLoopbackTools,
    () => calendarLoopbackTools,
    () => tasksLoopbackTools,
    () => tasksRegistryLoopbackTools,
    () => messagingLoopbackTools,
    () => remindersLoopbackTools,
    () => proactiveLoopbackTools,
    () => followupsLoopbackTools,
    () => episodesLoopbackTools,
    () => patternsLoopbackTools,
    () => historyLoopbackTools,
    () => statusLoopbackTools,
    () => webReadLoopbackTools,
    () => mathLoopbackTools,
    () => searchLoopbackTools,
    () => runnerTools,
    () => skillTools,
    () => knowledgeSearchTools,
    () => homeReadTools,
    () => emailReadTools,
    () => [createWeatherTool(env.MUSE_WEATHER_LOCATION?.trim() ? { defaultLocation: env.MUSE_WEATHER_LOCATION.trim() } : {})],
    () => [createWorldTimeTool()],
    () => [createRememberFactTool({ store: userMemoryStore })],
    () => [createObjectivesListTool({ objectives: () => readObjectives(resolveObjectivesFile(env)) })],
    () => [createRecentActionsTool({ actions: () => readActionLog(resolveActionLogFile(env)) })],
    () => [createOnThisDayTool({ datedNotes: () => collectDatedNotes(notesDir) })],
    () => [createFeedsSearchTool({ feedEntries: () => readFeedKnowledgeEntries(resolveFeedsFile(env), 200) })],
    () => [createOverdueContactsTool({
      interactions: async () => {
        const contacts = await queryContacts(resolveContactsFile(env));
        const events = calendarRegistry
          ? (await calendarRegistry.listEvents({ from: new Date(0), to: new Date() })).map((e) => ({ notes: e.notes, startsAt: e.startsAt.toISOString(), title: e.title }))
          : [];
        return interactionsFromEvents(contacts, events);
      }
    })],
    () => [createWeekAgendaTool({
      weekInput: async () => {
        const horizon = new Date();
        const events = calendarRegistry
          ? (await calendarRegistry.listEvents({ from: horizon, to: new Date(horizon.getTime() + 14 * 86_400_000) })).map((e) => ({ startsAtIso: e.startsAt.toISOString(), title: e.title, ...(e.allDay ? { allDay: true } : {}) }))
          : [];
        const tasks = (await readTasks(tasksFile).catch(() => []))
          .filter((task) => task.status === "open" && typeof task.dueAt === "string")
          .map((task) => ({ dueAt: task.dueAt!, title: task.title }));
        const reminders = (await readReminders(resolveRemindersFile(env)).catch(() => []))
          .filter((reminder) => reminder.status === "pending" && typeof reminder.dueAt === "string")
          .map((reminder) => ({ dueAt: reminder.dueAt, text: reminder.text }));
        const birthdays = resolveUpcomingBirthdays(await queryContacts(resolveContactsFile(env)), { withinDays: 14 })
          .map((b) => ({ daysUntil: b.daysUntil, name: b.contact.name }));
        return { birthdays, events, reminders, tasks };
      }
    })],
    () => [createTodayBriefTool({
      todayInput: async () => {
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
        const events = calendarRegistry
          ? (await calendarRegistry.listEvents({ from: startOfToday, to: endOfToday }).catch(() => [])).map((e) => ({ startsAtIso: e.startsAt.toISOString(), title: e.title, ...(e.endsAt ? { endsAtIso: e.endsAt.toISOString() } : {}), ...(e.allDay ? { allDay: true } : {}) }))
          : [];
        const tasks = (await readTasks(tasksFile).catch(() => []))
          .filter((task) => task.status === "open" && typeof task.dueAt === "string")
          .map((task) => ({ dueAt: task.dueAt!, title: task.title }));
        const reminders = (await readReminders(resolveRemindersFile(env)).catch(() => []))
          .filter((reminder) => reminder.status === "pending" && typeof reminder.dueAt === "string")
          .map((reminder) => ({ dueAt: reminder.dueAt, text: reminder.text }));
        const followups = (await readFollowups(resolveFollowupsFile(env)).catch(() => []))
          .filter((followup) => followup.status === "scheduled" && typeof followup.scheduledFor === "string")
          .map((followup) => ({ scheduledFor: followup.scheduledFor, summary: followup.summary }));
        return { events, followups, reminders, tasks };
      }
    })],
    () => [createDayRecapTool({
      recapInput: async () => {
        const now = new Date();
        const nowMs = now.getTime();
        const startOfTodayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const isToday = (iso: string): boolean => { const ms = Date.parse(iso); return Number.isFinite(ms) && ms >= startOfTodayMs && ms <= nowMs; };
        const allTasks = await readTasks(tasksFile).catch(() => []);
        const allReminders = await readReminders(resolveRemindersFile(env)).catch(() => []);
        const completedTasks = allTasks
          .filter((task) => task.status === "done" && typeof task.completedAt === "string" && isToday(task.completedAt))
          .map((task) => ({ completedAt: task.completedAt!, title: task.title }));
        const firedReminders = allReminders
          .filter((reminder) => reminder.status === "fired" && typeof reminder.firedAt === "string" && isToday(reminder.firedAt!))
          .map((reminder) => ({ firedAt: reminder.firedAt!, text: reminder.text }));
        const overdueTasks = allTasks
          .filter((task) => task.status === "open" && typeof task.dueAt === "string" && Date.parse(task.dueAt) < nowMs)
          .map((task) => ({ dueAt: task.dueAt!, title: task.title }));
        const overdueReminders = allReminders
          .filter((reminder) => reminder.status === "pending" && typeof reminder.dueAt === "string" && Date.parse(reminder.dueAt) < nowMs)
          .map((reminder) => ({ dueAt: reminder.dueAt, text: reminder.text }));
        return { completedTasks, firedReminders, overdueReminders, overdueTasks };
      }
    })],
    () => [createFindItemsTool({
      find: async () => {
        const now = Date.now();
        const events = calendarRegistry
          ? await calendarRegistry.listEvents({ from: new Date(now - 365 * 86_400_000), to: new Date(now + 365 * 86_400_000) }).catch(() => [])
          : [];
        const [tasks, reminders, contacts] = await Promise.all([
          readTasks(tasksFile).catch(() => []),
          readReminders(resolveRemindersFile(env)).catch(() => []),
          queryContacts(resolveContactsFile(env)).catch(() => [])
        ]);
        return { contacts, events, reminders, tasks };
      }
    })],
    () => [
      createContactsFindTool({ contacts: () => queryContacts(resolveContactsFile(env)) }),
      createUpcomingBirthdaysTool({ contacts: () => queryContacts(resolveContactsFile(env)) }),
      createContactsAddTool({ contacts: () => queryContacts(resolveContactsFile(env)), save: (contact) => addContact(resolveContactsFile(env), contact) }),
      createContactsRemoveTool({ contacts: () => queryContacts(resolveContactsFile(env)), remove: (id) => removeContact(resolveContactsFile(env), id) })
    ],
    () => options.extraTools ?? [],
    () => withOfficialMcpRisk(withChromeDevToolsRisk(mcp.manager.toMuseTools())),
    () => schedulerHandle.current ? createSchedulerTools(schedulerHandle.current) : []
  ]);
}
