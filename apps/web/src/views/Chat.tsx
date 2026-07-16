import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { useChatStream } from "../api/useChatStream.js";
import { useVoice } from "../api/useVoice.js";
import { DeskPet } from "../components/DeskPet.js";
import { Markdown } from "../components/markdown.js";
import { Button, Icon } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";
import { readLocationSeed, stripCompanionSeed } from "../lib/companion-seed.js";
import { modelChip } from "../lib/model-chip.js";
import { readToken } from "../lib/token-storage.js";
import { shouldStickToBottom } from "./chat-autoscroll.js";
import { ChatsView } from "./Chats.js";

import type { ApiClient } from "../api/client.js";
import type { ModelsResponse } from "../api/types.js";
import type { PendingApproval } from "../api/useChatStream.js";
import type { StringKey, Translate } from "../i18n/index.js";
import type { RefObject } from "react";

/** Starter prompts grounded in Muse's real capabilities (tasks, calendar,
 * notes, and a meta "what can you do" — see `chat.askSub`). Each entry pairs
 * a short chip label with the actual prompt text it fills into the composer. */
export const STARTER_PROMPTS: readonly { labelKey: StringKey; promptKey: StringKey }[] = [
  { labelKey: "chat.starter.day.label", promptKey: "chat.starter.day.prompt" },
  { labelKey: "chat.starter.tasks.label", promptKey: "chat.starter.tasks.prompt" },
  { labelKey: "chat.starter.notes.label", promptKey: "chat.starter.notes.prompt" },
  { labelKey: "chat.starter.help.label", promptKey: "chat.starter.help.prompt" }
];

/** Fills the composer with a starter prompt and focuses it — never sends it.
 * The user stays in control and confirms with Enter, same as any typed draft. */
export function applyStarterPrompt(
  prompt: string,
  setDraft: (value: string) => void,
  textareaRef: RefObject<HTMLTextAreaElement | null>
): void {
  setDraft(prompt);
  textareaRef.current?.focus();
}

/** Takes `t` as a prop (not `useI18n()`) so it calls no hooks — a plain
 * function of its props, callable directly in tests without a React render. */
export function StarterChips({ onPick, t }: { onPick: (prompt: string) => void; t: Translate }) {
  return (
    <div className="starter-chips" role="group" aria-label={t("chat.starter.groupLabel")}>
      {STARTER_PROMPTS.map((s) => (
        <button
          className="starter-chip"
          key={s.labelKey}
          onClick={() => onPick(t(s.promptKey))}
          type="button"
        >
          {t(s.labelKey)}
        </button>
      ))}
    </div>
  );
}

/** Draft-first write approvals surfaced under an assistant turn. Takes `t`
 * and the approve callback as props (no hooks) so it renders directly in a
 * test, mirroring `StarterChips`. Each card shows the drafted content and a
 * per-approval Approve button; the button is disabled while its own confirm
 * request is in flight, and `errorText` surfaces a failed confirm near it. */
export function PendingApprovals({
  approvals,
  approving,
  onApprove,
  onDeny,
  errorText,
  t
}: {
  approvals: readonly PendingApproval[];
  approving: readonly string[];
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  errorText?: string | null;
  t: Translate;
}) {
  return (
    <div className="pending-approvals" role="group" aria-live="polite" aria-label={t("chat.approval.heading")}>
      <div className="pending-approvals-head">{t("chat.approval.heading")}</div>
      {approvals.map((a) => {
        const inFlight = approving.includes(a.id);
        return (
          <div className="approval-card" key={a.id}>
            <span className="tool-chip">
              <Icon.tool className="nav-icon" /> {a.tool}
            </span>
            <div className="approval-draft">
              <Markdown text={a.draft} />
            </div>
            <div className="approval-actions">
              <Button
                variant="primary"
                size="sm"
                disabled={inFlight}
                onClick={() => onApprove(a.id)}
                ariaLabel={t("chat.approval.approveAria", { tool: a.tool })}
              >
                {inFlight ? <span className="spinner" /> : null}
                {t("chat.approval.approve")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={inFlight}
                onClick={() => onDeny(a.id)}
                ariaLabel={t("chat.approval.denyAria", { tool: a.tool })}
              >
                {t("chat.approval.deny")}
              </Button>
            </div>
          </div>
        );
      })}
      {errorText ? <div className="banner err">{errorText}</div> : null}
    </div>
  );
}

/** The always-visible current-model badge next to the composer. Local vs
 * cloud is the trust floor, so it lives in chrome, not Settings. Takes `t`
 * and the classified chip as props (no hooks) so it renders directly in a
 * test, mirroring `StarterChips`. An unknown locality shows only the model
 * name — the badge never guesses where tokens go. */
export function ModelChipBadge({ chip, t }: { chip: { name: string; locality: "local" | "cloud" | "unknown" }; t: Translate }) {
  return (
    <span className="model-chip" title={t("chat.model.tip")}>
      <span className={`model-chip-dot ${chip.locality}`} aria-hidden="true" />
      <span className="mono">{chip.name}</span>
      {chip.locality !== "unknown" && <span>· {t(chip.locality === "local" ? "chat.model.local" : "chat.model.cloud")}</span>}
    </span>
  );
}

/** The chat empty state: welcome copy + starter chips. Hidden once a
 * conversation has messages (`hasMessages`), so a returning user with a
 * transcript never sees onboarding chips. */
export function ChatEmptyState({
  hasMessages,
  onPickStarter
}: {
  hasMessages: boolean;
  onPickStarter: (prompt: string) => void;
}) {
  const { t } = useI18n();
  if (hasMessages) {
    return null;
  }
  return (
    <div className="empty chat-welcome" style={{ marginTop: 96 }}>
      <div className="empty-ic chat-welcome-ic" aria-hidden="true">
        <Icon.chat />
      </div>
      <div className="empty-title" style={{ fontSize: "var(--text-xl)" }}>{t("chat.askAnything")}</div>
      <div className="empty-hint">{t("chat.askSub")}</div>
      <StarterChips onPick={onPickStarter} t={t} />
    </div>
  );
}

/** The 대화 surface: a conversation session plus a 기록 (history) tab — the
 * read-only conversation list lives INSIDE chat, not as a separate sidebar
 * destination. Resuming from history bumps `epoch` so the remounted session
 * picks up the stored conversation id (useChatStream reads it at mount). */
export function ChatView({ client, onNavigate }: { client: ApiClient; onNavigate?: (view: string) => void }) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"chat" | "history">("chat");
  const [epoch, setEpoch] = useState(0);

  const handleHistoryNavigate = (view: string) => {
    if (view === "chat") {
      setEpoch((e) => e + 1);
      setTab("chat");
      return;
    }
    onNavigate?.(view);
  };

  return (
    <div className="chat-shell">
      <div className="chat-tabs" role="tablist" aria-label={t("nav.chat")}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "chat"}
          className={`chat-tab${tab === "chat" ? " active" : ""}`}
          onClick={() => setTab("chat")}
        >
          {t("nav.chat")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "history"}
          className={`chat-tab${tab === "history" ? " active" : ""}`}
          onClick={() => setTab("history")}
        >
          {t("nav.chats")}
        </button>
      </div>
      {tab === "chat" ? (
        <ChatSession key={epoch} client={client} />
      ) : (
        <ChatsView client={client} onNavigate={handleHistoryNavigate} />
      )}
    </div>
  );
}

export function ChatSession({ client }: { client: ApiClient }) {
  const { t } = useI18n();
  const token = readToken();
  const { activeTool, approve, approving, deny, error, pending, reset, send, thinking, turns } = useChatStream(
    client.baseUrl,
    token
  );
  const [elapsedS, setElapsedS] = useState(0);
  useEffect(() => {
    if (!pending) {
      setElapsedS(0);
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => setElapsedS(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [pending]);
  const voice = useVoice(client.baseUrl, token);
  // The native companion deep-links here with ?companion_seed=<topic>;
  // the seed pre-fills the composer (draft-first — never auto-sent).
  const [draft, setDraft] = useState(() => readLocationSeed() ?? "");
  const [autoSpeak, setAutoSpeak] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerWrapRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (readLocationSeed() === undefined) {
      return;
    }
    // Consume the seed: focus so Enter sends, and strip the param so a
    // refresh doesn't re-seed a composer the user already cleared.
    textareaRef.current?.focus();
    try {
      window.history.replaceState(null, "", stripCompanionSeed(new URL(window.location.href)).toString());
    } catch {
      /* history unavailable */
    }
  }, []);
  const models = useQuery({
    queryFn: () => client.get<ModelsResponse>("/api/models"),
    queryKey: ["models", client.baseUrl],
    staleTime: 60_000
  });
  const chip = modelChip(models.data?.defaultModel ?? models.data?.active);
  const spokenRef = useRef<number>(turns.length);
  const stickToBottomRef = useRef(true);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    stickToBottomRef.current = shouldStickToBottom({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight
    });
  };

  useEffect(() => {
    if (!stickToBottomRef.current) {
      return;
    }
    // Instant, not smooth: this fires on every streamed token, and a smooth
    // animation dispatches intermediate `scroll` events at positions short of
    // the (still-growing) bottom — `onScroll` would sample one past the
    // threshold, latch stick OFF mid-stream, and never recover (no further
    // scroll events fire once parked). An instant jump lands one event AT the
    // bottom, keeping the tail engaged. It also removes the load-time whoosh.
    scrollRef.current?.scrollTo({ behavior: "auto", top: scrollRef.current.scrollHeight });
  }, [turns, activeTool]);

  // Auto-speak the last assistant turn once it finishes streaming.
  useEffect(() => {
    if (!autoSpeak || pending) {
      return;
    }
    const last = turns[turns.length - 1];
    if (last?.role === "assistant" && last.text && turns.length > spokenRef.current) {
      spokenRef.current = turns.length;
      void voice.speak(last.text);
    }
  }, [autoSpeak, pending, turns, voice]);

  const submit = () => {
    if (!draft.trim() || pending) {
      return;
    }
    void send(draft);
    setDraft("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const pickStarter = (prompt: string) => applyStarterPrompt(prompt, setDraft, textareaRef);

  return (
    <div className="chat">
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-thread">
          <ChatEmptyState hasMessages={turns.length > 0} onPickStarter={pickStarter} />
          {turns.map((turn, i) => (
            <div className={`msg ${turn.role}`} key={i}>
              <div className="avatar">{turn.role === "user" ? "You" : "M"}</div>
              <div className="bubble">
                {turn.role === "assistant" ? (
                  turn.text ? (
                    <Markdown text={turn.text} />
                  ) : pending ? (
                    <span className="thinking-line">
                      <span className="spinner" />
                      {thinking || elapsedS > 0 ? (
                        <span className="subtle" style={{ fontSize: 13 }}>
                          {t("chat.thinking")}{elapsedS >= 3 ? ` · ${elapsedS}s` : ""}
                        </span>
                      ) : null}
                    </span>
                  ) : null
                ) : (
                  turn.text
                )}
                {turn.role === "assistant" && (turn.tools?.length ?? 0) > 0 && (
                  <div style={{ marginTop: 8, display: "flex", gap: 10, flexWrap: "wrap" }}>
                    {[...new Set(turn.tools)].map((name) => (
                      <span className="tool-chip" key={name}>
                        <Icon.tool className="nav-icon" /> {name}
                      </span>
                    ))}
                  </div>
                )}
                {turn.role === "assistant" && (turn.pendingApprovals?.length ?? 0) > 0 && (
                  <PendingApprovals
                    approvals={turn.pendingApprovals ?? []}
                    approving={approving}
                    onApprove={(id) => void approve(id)}
                    onDeny={(id) => void deny(id)}
                    errorText={error}
                    t={t}
                  />
                )}
                {(turn.citations?.length ?? 0) > 0 && (
                  <div className="citations">
                    {turn.citations?.map((c, ci) => (
                      <a className="citation" key={ci} href={c.url} target="_blank" rel="noreferrer">
                        ↗ {c.title || c.url}
                      </a>
                    ))}
                  </div>
                )}
                {turn.role === "assistant" && turn.text && (
                  <button className="speak-btn" title={t("chat.speak")} aria-label={t("chat.speak")} onClick={() => void voice.speak(turn.text)}>
                    <Icon.volume className="nav-icon" />
                  </button>
                )}
              </div>
            </div>
          ))}
          {activeTool && (
            <div className="msg assistant">
              <div className="avatar">M</div>
              <div className="bubble">
                <span className="tool-chip">
                  <span className="spinner" /> {t("chat.calling", { tool: activeTool })}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="chat-composer">
        {voice.error && <div className="banner err" style={{ maxWidth: 760, margin: "0 auto 8px" }}>{voice.error}</div>}
        <div className="composer-wrap" ref={composerWrapRef}>
          <DeskPet boundsRef={composerWrapRef} inFlight={pending} error={error} />
          <div className="composer-box">
          <button
            className={`mic-btn${voice.recording ? " recording" : ""}`}
            title={voice.recording ? t("chat.micStop") : t("chat.mic")}
            aria-label={voice.recording ? t("chat.micStop") : t("chat.mic")}
            onClick={() => void voice.toggleRecording((text) => setDraft((d) => (d ? `${d} ${text}` : text)))}
          >
            {voice.transcribing ? <span className="spinner" /> : <Icon.mic className="nav-icon" />}
          </button>
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={voice.transcribing ? t("chat.transcribing") : t("chat.placeholder")}
            rows={1}
          />
          <Button variant="primary" onClick={submit} disabled={pending || !draft.trim()} title={t("common.send")} ariaLabel={t("common.send")}>
            <Icon.send className="nav-icon" />
          </Button>
          </div>
        </div>
        <div style={{ maxWidth: 760, margin: "8px auto 0", display: "flex", alignItems: "center", gap: 12 }}>
          <label className="autospeak-toggle">
            <input type="checkbox" checked={autoSpeak} onChange={(e) => setAutoSpeak(e.target.checked)} />
            <span>{t("chat.autospeak")}</span>
          </label>
          {chip && <ModelChipBadge chip={chip} t={t} />}
          <span className="spacer" style={{ flex: 1 }} />
          {turns.length > 0 && (
            <Button variant="ghost" size="sm" onClick={reset}>
              {t("chat.clear")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
