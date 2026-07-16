import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { setStoredConversationId } from "../api/useChatStream.js";
import { AsyncBlock, Badge, Button, Card, Icon } from "../components/ui.js";
import { Markdown } from "../components/markdown.js";
import { useI18n } from "../i18n/index.js";
import { filterConversations, originBadgeLabelKey, relativeAgo } from "./chats-logic.js";

import type { ApiClient } from "../api/client.js";
import type { Translate } from "../i18n/index.js";
import type { ConversationDetail, ConversationsListResponse, ConversationSummary } from "../api/types.js";

/** One conversation row — a plain button (no hooks) so `onSelect` can be
 * asserted directly in a test without a DOM click. */
export function ConversationRow({
  summary,
  t,
  onSelect
}: {
  summary: ConversationSummary;
  t: Translate;
  onSelect: (id: string) => void;
}) {
  return (
    <button type="button" className="row conversation-row" onClick={() => onSelect(summary.id)}>
      <div className="row-main">
        <div className="row-title">{summary.title}</div>
        <div className="row-meta">
          <Badge tone="neutral">{t(originBadgeLabelKey(summary.origin))}</Badge>{" "}
          {relativeAgo(summary.updatedAt, t)} · {t("chats.turnCount", { n: summary.turnCount })}
        </div>
      </div>
    </button>
  );
}

/** Newest-first list of conversation rows — the store's `list()` already
 * sorts newest-first, so this renders in whatever order it receives. */
export function ConversationList({
  conversations,
  t,
  onSelect
}: {
  conversations: readonly ConversationSummary[];
  t: Translate;
  onSelect: (id: string) => void;
}) {
  return (
    <div>
      {conversations.map((c) => (
        <ConversationRow key={c.id} summary={c} t={t} onSelect={onSelect} />
      ))}
    </div>
  );
}

/** A single conversation's transcript, capped server-side. User turns render
 * as PLAIN TEXT (a raw JSX text child — React escapes it, same as `Chat.tsx`);
 * assistant turns go through `Markdown`, which never uses
 * `dangerouslySetInnerHTML`. Neither path can turn model/user content into
 * live markup. */
export function TranscriptView({
  conversation,
  t,
  onBack,
  onResume
}: {
  conversation: ConversationDetail;
  t: Translate;
  onBack: () => void;
  onResume: () => void;
}) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <Button variant="ghost" size="sm" onClick={onBack}>
          {t("chats.back")}
        </Button>
        <Button variant="primary" size="sm" onClick={onResume}>
          {t("chats.resume")}
        </Button>
      </div>
      <div className="chat-thread">
        {conversation.turns
          .filter((turn) => turn.role === "user" || turn.role === "assistant")
          .map((turn, i) => (
            <div className={`msg ${turn.role}`} key={i}>
              <div className="avatar">{turn.role === "user" ? "You" : "M"}</div>
              <div className="bubble">{turn.role === "assistant" ? <Markdown text={turn.content} /> : turn.content}</div>
            </div>
          ))}
      </div>
    </div>
  );
}

/**
 * The web "Chats" panel — list + resume conversations from the browser,
 * the phone use-case via `muse remote`. Read-only besides the resume
 * pointer: renaming and deleting stay CLI-only verbs (`muse chats`), so
 * there's no destructive action here to gate.
 *
 * "Continue this chat" seeds `useChatStream`'s stored conversation id
 * (`setStoredConversationId`) and hands off to the Chat panel via
 * `onNavigate` — the NEXT message sent there threads onto this same
 * server-side conversation, including a telegram-origin one (`telegram:123`
 * round-trips through the `:id` route's URL encoding untouched).
 */
export function ChatsView({ client, onNavigate }: { client: ApiClient; onNavigate?: (view: string) => void }) {
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const list = useQuery({
    queryFn: () => client.get<ConversationsListResponse>("/api/conversations"),
    queryKey: ["conversations", client.baseUrl]
  });

  const detail = useQuery({
    enabled: selectedId !== null,
    queryFn: () => client.get<ConversationDetail>(`/api/conversations/${encodeURIComponent(selectedId ?? "")}`),
    queryKey: ["conversation-detail", client.baseUrl, selectedId]
  });

  const all = list.data?.conversations ?? [];
  const conversations = filterConversations(all, query);

  const resume = () => {
    if (!selectedId) {
      return;
    }
    setStoredConversationId(selectedId);
    onNavigate?.("chat");
  };

  return (
    <div className="content-narrow">
      <p className="eyebrow">{t("group.workspace")}</p>
      <h1 className="page-title">{t("nav.chats")}</h1>
      <p className="muted" style={{ marginTop: 4 }}>
        {t("chats.subtitle")}
      </p>

      <div style={{ marginTop: 16 }}>
        {selectedId ? (
          <Card className="lifted">
            <AsyncBlock loading={detail.isLoading} error={detail.error} empty={false}>
              {detail.data && (
                <TranscriptView conversation={detail.data} t={t} onBack={() => setSelectedId(null)} onResume={resume} />
              )}
            </AsyncBlock>
          </Card>
        ) : (
          <Card title={t("chats.list")} count={conversations.length}>
            {all.length > 0 && (
              <input
                className="input"
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("chats.searchPlaceholder")}
                aria-label={t("chats.searchPlaceholder")}
                style={{ marginBottom: 10 }}
              />
            )}
            <AsyncBlock
              loading={list.isLoading}
              error={list.error}
              empty={conversations.length === 0}
              emptyIcon={<Icon.chat />}
              emptyLabel={t("chats.empty")}
              emptyHint={t("chats.emptyHint")}
              emptyAction={{
                icon: <Icon.plus className="nav-icon" />,
                label: t("chats.startOne"),
                onClick: () => onNavigate?.("chat")
              }}
            >
              <ConversationList conversations={conversations} t={t} onSelect={setSelectedId} />
            </AsyncBlock>
          </Card>
        )}
      </div>
    </div>
  );
}
