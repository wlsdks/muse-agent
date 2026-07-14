/**
 * Deterministic in-channel slash commands (`/new` `/status` `/model`
 * `/help`) — the house pattern from `inbound-veto-handler.ts`: a small
 * pure-ish handler `createInboundAgentRun` calls BEFORE any model
 * dispatch. A message whose TRIMMED text starts with "/" is always
 * handled here (fail-close: an unknown command gets the help text, never
 * the agent) — a slash mid-text ("see a/b tests") never matches, only a
 * leading "/".
 *
 * Replies are bilingual-by-design (English + Korean label in the SAME
 * string) rather than branching on `containsHangul(text)` like the
 * natural-language handlers do — a slash command carries no language
 * signal to detect (`/new` reads the same in either language), so there
 * is nothing to branch on.
 */

import { listPendingApprovals } from "@muse/messaging";

/** Structural slice of `FileConversationStore` — the whole class is
 *  never referenced here, only the two methods `/new` and `/status` use. */
export interface SlashConversationStore {
  get(id: string): Promise<{ readonly turns: readonly unknown[] } | undefined>;
  replaceTurns(id: string, turns: readonly unknown[]): Promise<unknown>;
}

export interface HandleInboundSlashCommandOptions {
  readonly text: string;
  readonly providerId: string;
  readonly source: string;
  readonly model: string;
  readonly pendingApprovalsFile: string;
  /** Omitted only in a caller that never wired the conversation store —
   *  `/new` and the turn-count line of `/status` degrade to a safe
   *  "not available" reply rather than throwing. */
  readonly conversationStore?: SlashConversationStore;
}

const HELP_TEXT = [
  "Muse commands (뮤즈 명령어):",
  "/new — start a fresh conversation, clearing this chat's history (새 대화 시작 · 이전 기록 초기화)",
  "/status — show the model, pending approvals, and turn count for this chat (현재 상태 보기)",
  "/model — show the current default model (기본 모델 확인)",
  "/help — show this list (도움말)"
].join("\n");

function conversationIdFor(providerId: string, source: string): string {
  return `${providerId}:${source}`;
}

/** Telegram sends "/status@my_bot" in group chats — strip the "@handle"
 *  suffix so group posture doesn't need its own command table. */
function normalizeCommand(rawFirstToken: string): string {
  const atIndex = rawFirstToken.indexOf("@");
  return (atIndex === -1 ? rawFirstToken : rawFirstToken.slice(0, atIndex)).toLowerCase();
}

async function handleNew(providerId: string, source: string, store: SlashConversationStore | undefined): Promise<string> {
  if (!store) {
    return "Conversation reset isn't available right now (지금은 대화 초기화를 할 수 없어요).";
  }
  const id = conversationIdFor(providerId, source);
  const existing = await store.get(id);
  if (!existing || existing.turns.length === 0) {
    return "This conversation is already empty — nothing to clear (이미 비어 있어서 지울 게 없어요).";
  }
  // Clear turns, keep the conversation itself addressable (id/title
  // survive) — a delete-and-recreate would also work, but this avoids
  // orphaning the id anywhere it was already referenced (e.g. the web UI).
  await store.replaceTurns(id, []);
  return "Started a fresh conversation — previous context cleared (새 대화를 시작했어요, 이전 맥락은 지워졌어요).";
}

async function handleStatus(options: HandleInboundSlashCommandOptions): Promise<string> {
  const pending = await listPendingApprovals(options.pendingApprovalsFile, undefined, {
    providerId: options.providerId,
    source: options.source
  });
  const id = conversationIdFor(options.providerId, options.source);
  const record = options.conversationStore ? await options.conversationStore.get(id) : undefined;
  const turnCount = record?.turns.length ?? 0;
  return (
    `Muse status (상태): model=${options.model} · pending approvals=${pending.length.toString()} (승인 대기) `
    + `· turns=${turnCount.toString()} (대화 기록)`
  );
}

function handleModel(model: string): string {
  return (
    `Default model (기본 모델): ${model}. `
    + "Switching from chat: not yet — change the default in your Muse config (아직 채팅에서 모델 변경은 지원하지 않아요 — 설정 파일에서 바꿔주세요)."
  );
}

/**
 * Returns the reply string when `options.text` is a slash command, or
 * `undefined` to fall through to the normal pre-handler chain (not a
 * slash command at all).
 */
export async function handleInboundSlashCommand(options: HandleInboundSlashCommandOptions): Promise<string | undefined> {
  const trimmed = options.text.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }
  const [rawFirstToken] = trimmed.split(/\s+/u);
  const command = normalizeCommand(rawFirstToken ?? "");
  switch (command) {
    case "/new":
      return handleNew(options.providerId, options.source, options.conversationStore);
    case "/status":
      return handleStatus(options);
    case "/model":
      return handleModel(options.model);
    case "/help":
    case "/start":
      return HELP_TEXT;
    default:
      return `Unknown command: ${command} (알 수 없는 명령어)\n\n${HELP_TEXT}`;
  }
}
