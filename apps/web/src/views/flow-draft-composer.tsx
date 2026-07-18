import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "@muse/shared/browser";

import { useI18n } from "../i18n/index.js";
import { describeDraftRevision } from "./flow-draft-diff.js";

import type { ApiClient } from "../api/client.js";
import type { FlowDraftPayloadRow, FlowDraftResponse } from "../api/types.js";

const FLOW_DRAFT_URL = "/api/flows/draft";

interface ThreadEntry {
  readonly role: "user" | "assistant";
  readonly text: string;
}

interface DraftRequest {
  readonly text: string;
  readonly currentDraft?: FlowDraftPayloadRow;
}

/**
 * "코파일럿 초안", chat-shaped: the thread scrolls above, the composer is
 * pinned at the bottom (Enter sends, Shift+Enter breaks the line) — the
 * conversation grammar every chat surface trains. A first turn fills the
 * create form via `POST /api/flows/draft` and acks it in the thread; once
 * the panel is open every further turn is a REVISION against the panel's
 * LIVE form values, acked with the changed field(s). This component NEVER
 * creates a job itself — draft-first, same discipline as every other
 * mutating surface in this repo.
 */
export function FlowDraftComposer({
  client,
  onDrafted,
  currentDraft,
  initialText
}: {
  client: ApiClient;
  onDrafted: (draft: FlowDraftPayloadRow) => void;
  /** The live create-panel form state, projected into the copilot's payload
   * shape — undefined before any draft exists (first-turn mode), present
   * once the panel is open (every further turn is a revision). */
  currentDraft?: FlowDraftPayloadRow;
  /** A one-shot pre-fill (e.g. from the Chat view's "Create in Builder"
   * handoff, `chat-automation-honesty.ts`'s `builderHint`) — seeds the
   * textarea on FIRST render only; the user still presses send
   * (draft-first stays intact). */
  initialText?: string;
}) {
  const { t } = useI18n();
  const [text, setText] = useState(() => initialText ?? "");
  const [thread, setThread] = useState<readonly ThreadEntry[]>([]);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const isRevision = currentDraft !== undefined;

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [thread.length]);

  const draft = useMutation({
    mutationFn: (request: DraftRequest) =>
      client.post<FlowDraftResponse>(
        FLOW_DRAFT_URL,
        request.currentDraft ? { currentDraft: request.currentDraft, text: request.text } : { text: request.text }
      ),
    onMutate: (request) => {
      setThread((previous) => [...previous, { role: "user", text: request.text }]);
      setText("");
    },
    onSuccess: (response, request) => {
      const priorDraft = request.currentDraft;
      setThread((previous) => [
        ...previous,
        {
          role: "assistant",
          text: priorDraft ? describeDraftRevision(priorDraft, response.draft, t) : t("auto.flows.draft.firstAck")
        }
      ]);
      onDrafted(response.draft);
    },
    onError: (_error, request) => {
      // Keep the failed request in the input so the user can retry/edit it.
      setText(request.text);
    }
  });

  const canDraft = text.trim().length > 0 && !draft.isPending;
  const submit = () => {
    if (canDraft) {
      draft.mutate({ currentDraft, text: text.trim() });
    }
  };

  return (
    <div className="copilot-chat">
      <div className="copilot-thread" ref={threadRef}>
        {thread.length === 0 ? (
          <div className="copilot-empty">
            <div className="copilot-empty-title">{t("auto.flows.draft.emptyTitle")}</div>
            <p className="subtle">{t("auto.flows.draft.placeholder")}</p>
          </div>
        ) : (
          thread.map((entry, index) => (
            <div key={index} className={`chat-bubble ${entry.role}`}>
              {entry.text}
            </div>
          ))
        )}
        {draft.isPending && <div className="chat-bubble assistant pending">…</div>}
        {draft.error && !draft.isPending && (
          <div className="banner err">{errorMessage(draft.error, t("auto.flows.draft.fallbackFailed"))}</div>
        )}
      </div>
      <div className="copilot-composer">
        <textarea
          aria-label={t("auto.flows.draft.inputLabel")}
          className="input"
          rows={1}
          placeholder={isRevision ? t("auto.flows.draft.revisionPlaceholder") : t("auto.flows.draft.placeholder")}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button
          type="button"
          className="copilot-send"
          disabled={!canDraft}
          aria-label={t(isRevision ? "auto.flows.draft.sendButton" : "auto.flows.draft.button")}
          title={t(isRevision ? "auto.flows.draft.sendButton" : "auto.flows.draft.button")}
          onClick={submit}
        >
          ↑
        </button>
      </div>
    </div>
  );
}
