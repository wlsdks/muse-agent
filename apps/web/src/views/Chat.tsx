import { useEffect, useRef, useState } from "react";

import { useChatStream } from "../api/useChatStream.js";
import { useVoice } from "../api/useVoice.js";
import { Markdown } from "../components/markdown.js";
import { Button, Icon } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";

import type { ApiClient } from "../api/client.js";

function readToken(): string {
  try {
    return window.localStorage.getItem("muse.token") ?? "";
  } catch {
    return "";
  }
}

export function ChatView({ client }: { client: ApiClient }) {
  const { t } = useI18n();
  const token = readToken();
  const { activeTool, pending, reset, send, turns } = useChatStream(client.baseUrl, token);
  const voice = useVoice(client.baseUrl, token);
  const [draft, setDraft] = useState("");
  const [autoSpeak, setAutoSpeak] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const spokenRef = useRef<number>(turns.length);

  useEffect(() => {
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

  return (
    <div className="chat" style={{ margin: "-24px", height: "calc(100% + 48px)" }}>
      <div className="chat-scroll" ref={scrollRef}>
        <div className="chat-thread">
          {turns.length === 0 && (
            <div className="empty" style={{ marginTop: 80 }}>
              <div style={{ color: "var(--ink-muted)", fontSize: 18, marginBottom: 6 }}>{t("chat.askAnything")}</div>
              <div>{t("chat.askSub")}</div>
            </div>
          )}
          {turns.map((turn, i) => (
            <div className={`msg ${turn.role}`} key={i}>
              <div className="avatar">{turn.role === "user" ? "You" : "M"}</div>
              <div className="bubble">
                {turn.role === "assistant" ? (
                  turn.text ? (
                    <Markdown text={turn.text} />
                  ) : pending ? (
                    <span className="spinner" />
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
