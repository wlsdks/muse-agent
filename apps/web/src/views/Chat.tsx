import { useEffect, useRef, useState } from "react";

import { useChatStream } from "../api/useChatStream.js";
import { Button, Icon } from "../components/ui.js";

import type { ApiClient } from "../api/client.js";

export function ChatView({ client }: { client: ApiClient }) {
  const { activeTool, pending, reset, send, turns } = useChatStream(client.baseUrl, readToken());
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ behavior: "smooth", top: scrollRef.current.scrollHeight });
  }, [turns, activeTool]);

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
              <div style={{ color: "var(--ink-muted)", fontSize: 18, marginBottom: 6 }}>Ask Muse anything</div>
              <div>It can check your tasks, calendar, notes, the web, and more.</div>
            </div>
          )}
          {turns.map((t, i) => (
            <div className={`msg ${t.role}`} key={i}>
              <div className="avatar">{t.role === "user" ? "You" : "M"}</div>
              <div className="bubble">
                {t.text || (t.role === "assistant" && pending ? <span className="spinner" /> : null)}
                {t.role === "assistant" && (t.tools?.length ?? 0) > 0 && (
                  <div style={{ marginTop: 8, display: "flex", gap: 10, flexWrap: "wrap" }}>
                    {[...new Set(t.tools)].map((name) => (
                      <span className="tool-chip" key={name}>
                        <Icon.tool className="nav-icon" /> {name}
                      </span>
                    ))}
                  </div>
                )}
                {(t.citations?.length ?? 0) > 0 && (
                  <div className="citations">
                    {t.citations?.map((c, ci) => (
                      <a className="citation" key={ci} href={c.url} target="_blank" rel="noreferrer">
                        ↗ {c.title || c.url}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
          {activeTool && (
            <div className="msg assistant">
              <div className="avatar">M</div>
              <div className="bubble">
                <span className="tool-chip">
                  <span className="spinner" /> calling {activeTool}…
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="chat-composer">
        <div className="composer-box">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Message Muse…  (Enter to send, Shift+Enter for newline)"
            rows={1}
          />
          <Button variant="primary" onClick={submit} disabled={pending || !draft.trim()} title="Send">
            <Icon.send className="nav-icon" />
          </Button>
        </div>
        {turns.length > 0 && (
          <div style={{ maxWidth: 760, margin: "8px auto 0", textAlign: "right" }}>
            <Button variant="ghost" size="sm" onClick={reset}>
              Clear conversation
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function readToken(): string {
  try {
    return window.localStorage.getItem("muse.token") ?? "";
  } catch {
    return "";
  }
}
