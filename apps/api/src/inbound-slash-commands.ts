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
 *
 * R3-3: `/model <name>` switches Muse's default model, validated against
 * what Ollama actually has installed — through the SAME
 * `resolveModelSwitchTarget` / `writeMuseCliDefaultModel` implementation
 * `muse model use` (apps/cli) calls, via `@muse/autoconfigure`'s
 * model-registry (apps/api cannot import apps/cli, a separate app — see
 * that module's doc comment for why the shared piece lives there, and for
 * the "this does not hot-apply to the running daemon" ground truth).
 */

import {
  activeModelEnvOverride,
  resolveModelSwitchTarget,
  resolveMuseCliConfigFilePath,
  resolveOllamaBaseUrl,
  writeMuseCliDefaultModel,
  type MuseEnvironment
} from "@muse/autoconfigure";
import { listPendingApprovals } from "@muse/messaging";
import { isLocalOnlyEnabled } from "@muse/model";

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
  /**
   * Backs `/model <name>` (R3-3): env for the local-only refusal gate and
   * the "an env var wins over this write" caveat. Omitted (bare `/model`,
   * or a caller that predates R3-3) degrades to `{}` — `/model <name>` still
   * validates + writes, it just can't report an env override or honour a
   * non-default Ollama host.
   */
  readonly env?: MuseEnvironment;
  /** Injected — defaults to the real `globalThis.fetch`. Test seam so `pnpm test` never hits real Ollama. */
  readonly fetchImpl?: typeof globalThis.fetch;
  /** Test seam — defaults to `resolveMuseCliConfigFilePath(env)` (`~/.config/muse/config.json`). */
  readonly configFilePath?: string;
}

const HELP_TEXT = [
  "Muse commands (뮤즈 명령어):",
  "/new — start a fresh conversation, clearing this chat's history (새 대화 시작 · 이전 기록 초기화)",
  "/status — show the model, pending approvals, and turn count for this chat (현재 상태 보기)",
  "/model — show the current default model, or `/model <name>` to switch it (기본 모델 확인 · 전환은 `/model <이름>`)",
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

/**
 * `/model` (bare) shows the resolved default + how to switch; `/model
 * <name>` (R3-3) validates the request against what Ollama actually has
 * installed and writes it — through the SAME `resolveModelSwitchTarget` /
 * `writeMuseCliDefaultModel` implementation `muse model use` calls (see
 * this file's module doc + model-registry.ts's doc comment for why the
 * write does NOT hot-apply to this very running process).
 */
async function handleModel(options: HandleInboundSlashCommandOptions, argument: string | undefined): Promise<string> {
  if (!argument) {
    return (
      `Default model (기본 모델): ${options.model}. `
      + "Switch with `/model <name>` (e.g. `/model gemma4:12b`) — validated against what's installed in Ollama "
      + "(한국어: `/model <이름>`으로 전환, 설치된 Ollama 모델만 가능해요)."
    );
  }

  const env = options.env ?? {};
  const resolution = await resolveModelSwitchTarget({
    baseUrl: resolveOllamaBaseUrl(env),
    fetchImpl: options.fetchImpl,
    localOnly: isLocalOnlyEnabled(env),
    requestedModel: argument
  });
  if (!resolution.ok) {
    if (resolution.reason === "unknown") {
      const lines = [resolution.message];
      if (resolution.suggestion) lines.push(`Did you mean '${resolution.suggestion}'? (혹시 '${resolution.suggestion}'?)`);
      if (resolution.installedSample.length > 0) lines.push(`Installed (설치된 모델): ${resolution.installedSample.join(", ")}`);
      return lines.join("\n");
    }
    return resolution.message;
  }

  await writeMuseCliDefaultModel(options.configFilePath ?? resolveMuseCliConfigFilePath(env), resolution.modelId);
  const lines = [`Switched default model (모델 전환): ${options.model} → ${resolution.modelId}.`];
  const override = activeModelEnvOverride(env);
  if (override) {
    lines.push(
      `Note: ${override.key}=${override.value} is set in this server's OWN environment and wins over the config file — `
      + `this process keeps using it until it's restarted with the new value `
      + `(${override.key} 환경변수가 우선 적용돼요, 이 프로세스는 재시작 전까지 그대로예요).`
    );
  } else {
    lines.push(
      "New `muse chat`/`muse tui` CLI runs on this machine will use it immediately. This chat's OWN running Muse "
      + "process does NOT hot-apply the switch — it reads MUSE_MODEL/MUSE_DEFAULT_MODEL from its own environment at "
      + `startup and never reads this config file. Restart it with MUSE_DEFAULT_MODEL=${resolution.modelId} to change `
      + "what THIS chat uses (이 채팅이 실제로 쓰는 모델을 바꾸려면 서버 재시작이 필요해요)."
    );
  }
  return lines.join("\n");
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
  const [rawFirstToken, ...rest] = trimmed.split(/\s+/u);
  const command = normalizeCommand(rawFirstToken ?? "");
  switch (command) {
    case "/new":
      return handleNew(options.providerId, options.source, options.conversationStore);
    case "/status":
      return handleStatus(options);
    case "/model":
      return handleModel(options, rest.join(" ").trim() || undefined);
    case "/help":
    case "/start":
      return HELP_TEXT;
    default:
      return `Unknown command: ${command} (알 수 없는 명령어)\n\n${HELP_TEXT}`;
  }
}
