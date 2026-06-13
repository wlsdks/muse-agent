/** Response shapes for the Muse API endpoints the web consumes. */

export interface HealthResponse {
  readonly service?: string;
  readonly status?: string;
}

export interface Citation {
  readonly url: string;
  readonly title: string;
}

export interface ChatResponse {
  readonly content?: string;
  readonly response?: string;
  readonly runId?: string;
  readonly model?: string;
  readonly citations?: readonly Citation[];
  readonly toolsUsed?: readonly string[];
}

export interface TaskRow {
  readonly id: string;
  readonly title: string;
  readonly status: "open" | "done";
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly notes?: string;
  readonly tags?: readonly string[];
}
export interface TasksResponse {
  readonly tasks: readonly TaskRow[];
  readonly status: "open" | "done" | "all";
  readonly total: number;
}

export interface ReminderRow {
  readonly id: string;
  readonly text: string;
  readonly dueAt: string;
  readonly status: "pending" | "fired";
  readonly firedAt?: string;
  readonly createdAt: string;
}
export interface RemindersResponse {
  readonly reminders: readonly ReminderRow[];
  readonly status: "pending" | "fired" | "all" | "due";
  readonly total: number;
}

interface CalendarEventRow {
  readonly id: string;
  readonly providerId: string;
  readonly title: string;
  readonly startsAtIso: string;
  readonly endsAtIso: string;
  readonly allDay: boolean;
  readonly location: string | null;
  readonly notes: string | null;
  readonly tags: readonly string[];
  readonly url: string | null;
}
export interface CalendarEventsResponse {
  readonly events: readonly CalendarEventRow[];
  readonly total: number;
}

interface NotesEntryRow {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly sizeBytes?: number;
}
export interface NotesListResponse {
  readonly dir: string;
  readonly entries: readonly NotesEntryRow[];
  readonly truncated: boolean;
}
export interface NotesReadResponse {
  readonly name: string;
  readonly content: string;
}
interface NotesSearchHit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}
export interface NotesSearchResponse {
  readonly query: string;
  readonly hits: readonly NotesSearchHit[];
}

export interface TodayBriefingResponse {
  readonly generatedAt: string;
  readonly lookaheadHours: number;
  readonly tasks?: readonly { readonly id: string; readonly title: string }[];
  readonly events?: readonly {
    readonly id: string;
    readonly title: string;
    readonly startsAtIso: string;
  }[];
  readonly notes?: readonly string[];
  readonly reminders?: readonly { readonly id: string; readonly text: string; readonly dueAt: string }[];
}

export interface ToolCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly risk: "read" | "write" | "execute";
  readonly keywords?: readonly string[];
}
export interface ToolCatalogResponse {
  readonly tools: readonly ToolCatalogEntry[];
  readonly total: number;
}

interface HistoryEntry {
  readonly runId?: string;
  readonly inputPreview?: string;
  readonly outputPreview?: string;
  readonly model?: string;
  readonly status?: string;
  readonly startedAt?: string;
}
export interface HistoryResponse {
  readonly entries?: readonly HistoryEntry[];
  readonly items?: readonly HistoryEntry[];
}

export interface ProactiveNotice {
  readonly id?: string;
  readonly message?: string;
  readonly text?: string;
  readonly kind?: string;
  readonly createdAt?: string;
}
export interface ProactiveHistoryResponse {
  readonly entries?: readonly ProactiveNotice[];
  readonly items?: readonly ProactiveNotice[];
}

interface ModelInfo {
  readonly id?: string;
  readonly name?: string;
  readonly provider?: string;
}
export interface ModelsResponse {
  readonly models?: readonly ModelInfo[];
  readonly active?: string;
}

export interface TokenCostDailyRow {
  readonly day: string;
  readonly model?: string;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly totalCostUsd?: number;
}

interface ToolByName {
  readonly tool: string;
  readonly server?: string;
  readonly outcome?: string;
  readonly count: number;
}
export interface ToolStatsResponse {
  readonly total?: number;
  readonly accuracy?: number;
  readonly byOutcome?: Record<string, number>;
  readonly byTool?: readonly ToolByName[];
}

export interface LatencySummary {
  readonly count?: number;
  readonly p50Ms?: number;
  readonly p95Ms?: number;
  readonly p99Ms?: number;
}

interface ObjectiveRow {
  readonly id: string;
  readonly spec: string;
  readonly kind: string;
  readonly status: string;
  readonly createdAt: string;
  readonly lastEvaluatedAt?: string;
  readonly resolution?: string;
}
export interface ObjectivesResponse {
  readonly objectives: readonly ObjectiveRow[];
  readonly total: number;
}

interface ActionRow {
  readonly id: string;
  readonly when: string;
  readonly what: string;
  readonly why: string;
  readonly result: "performed" | "refused" | "failed" | string;
  readonly objectiveId?: string;
  readonly detail?: string;
}
export interface ActionsResponse {
  readonly actions: readonly ActionRow[];
  readonly total: number;
}

interface ContactRow {
  readonly id: string;
  readonly name: string;
  readonly email?: string;
  readonly handle?: string;
  readonly phone?: string;
}
export interface ContactsResponse {
  readonly contacts: readonly ContactRow[];
  readonly total: number;
}

interface VetoRow {
  readonly id: string;
  readonly objectiveId: string;
  readonly scope: string;
  readonly vetoedAt: string;
  readonly reason?: string;
}
export interface VetoesResponse {
  readonly vetoes: readonly VetoRow[];
  readonly total: number;
}

export interface UserMemoryResponse {
  readonly facts?: Record<string, string>;
  readonly preferences?: Record<string, string>;
  readonly recentTopics?: readonly string[];
  readonly updatedAt?: string;
}

interface MessagingProvider {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly local?: boolean;
}
export interface MessagingProvidersResponse {
  readonly providers: readonly MessagingProvider[];
}
interface InboundMessage {
  readonly id?: string;
  readonly from?: string;
  readonly text?: string;
  readonly receivedAt?: string;
}
export interface InboxResponse {
  readonly inbound: readonly InboundMessage[];
  readonly providerId: string;
  readonly total: number;
}
