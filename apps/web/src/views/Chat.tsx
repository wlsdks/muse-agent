import { useEffect, useRef, useState } from "react";

import { useChatStream } from "../api/useChatStream.js";
import { useVoice } from "../api/useVoice.js";
import { DeskPet } from "../components/DeskPet.js";
import { Markdown } from "../components/markdown.js";
import { Button, Icon } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";
import { readToken } from "../lib/token-storage.js";
import { shouldStickToBottom } from "./chat-autoscroll.js";

import type { ApiClient } from "../api/client.js";
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

export function ChatView({ client }: { client: ApiClient }) {
  const { t } = useI18n();
  const token = readToken();
  const { activeTool, error, pending, reset, send, thinking, turns } = useChatStream(client.baseUrl, token);
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
  const [draft, setDraft] = useState("");
  const [autoSpeak, setAutoSpeak] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerWrapRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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
    scrollRef.current?.scrollTo({ behavior: "smooth", top: scrollRef.current.scrollHeight });
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
    <div className="chat" style={{ margin: "-24px", height: "calc(100% + 48px)" }}>
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
