import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { AsyncBlock, Badge, Button, Card, Icon } from "../components/ui.js";
import { errorMessage } from "../lib/error-message.js";
import { useI18n } from "../i18n/index.js";

import type { ApiClient } from "../api/client.js";
import type { InboxResponse, MessagingProvidersResponse } from "../api/types.js";

interface Draft {
  readonly providerId: string;
  readonly destination: string;
  readonly text: string;
}

/**
 * Messaging — inbox read + draft-first send. Sending to a third party is
 * the highest-risk action (outbound-safety.md), so the gate lives in the
 * UX: the user authors the exact recipient + text, then must explicitly
 * confirm a review panel before anything leaves. The agent never picks a
 * recipient or sends on its own here; cancel (or never confirming) sends
 * nothing.
 */
export function MessagingView({ client }: { client: ApiClient }) {
  const { locale, t } = useI18n();
  const [providerId, setProviderId] = useState("");
  const [destination, setDestination] = useState("");
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Draft | null>(null);
  const [sent, setSent] = useState(false);

  const providers = useQuery({
    queryFn: () => client.get<MessagingProvidersResponse>("/api/messaging/providers"),
    queryKey: ["messaging-providers", client.baseUrl]
  });

  // Default to the first provider once loaded.
  useEffect(() => {
    const first = providers.data?.providers[0]?.id;
    if (first && !providerId) {
      setProviderId(first);
    }
  }, [providers.data, providerId]);

  const inbox = useQuery({
    enabled: providerId.length > 0,
    queryFn: () => client.get<InboxResponse>(`/api/messaging/inbox?providerId=${encodeURIComponent(providerId)}`),
    queryKey: ["messaging-inbox", client.baseUrl, providerId],
    retry: false
  });

  // The send mutation fires ONLY from the confirm action below.
  const send = useMutation({
    mutationFn: (draft: Draft) => client.post("/api/messaging/send", { ...draft }),
    onSuccess: () => {
      setPending(null);
      setText("");
      setDestination("");
      setSent(true);
    }
  });

  const canReview = providerId.length > 0 && destination.trim().length > 0 && text.trim().length > 0;

  return (
    <div className="content-narrow">
      <p className="eyebrow">{t("group.workspace")}</p>
      <h1 className="page-title">{t("nav.messaging")}</h1>
      <p className="muted" style={{ marginTop: 4 }}>
        {t("msg.subtitle")}
      </p>

      <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "16px 0" }}>
        <label className="field-label" style={{ margin: 0 }}>
          {t("msg.provider")}
        </label>
        <select className="input" style={{ maxWidth: 240 }} value={providerId} onChange={(e) => setProviderId(e.target.value)}>
          {(providers.data?.providers ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-2">
        <Card
          title={t("msg.inbox")}
          count={inbox.data?.total ?? 0}
          action={
            <Button variant="ghost" size="sm" onClick={() => void inbox.refetch()}>
              {t("msg.poll")}
            </Button>
          }
        >
          <AsyncBlock loading={inbox.isLoading} error={inbox.error} empty={(inbox.data?.inbound.length ?? 0) === 0} emptyLabel={t("msg.inboxEmpty")} emptyHint={t("msg.inboxEmptyHint")} emptyIcon={<Icon.mail />}>
            {(inbox.data?.inbound ?? []).map((m, i) => (
              <div className="row" key={m.id ?? i}>
                <div className="row-main">
                  <div className="row-title">{m.text ?? "—"}</div>
                  <div className="row-meta">
                    {m.from ?? "?"}
                    {m.receivedAt ? ` · ${new Date(m.receivedAt).toLocaleString(locale)}` : ""}
                  </div>
                </div>
              </div>
            ))}
          </AsyncBlock>
        </Card>

        <Card title={t("msg.compose")} className="lifted">
          {pending ? (
            <div className="confirm-send">
              <div className="confirm-head">
                <Icon.shield className="nav-icon" /> {t("msg.confirmTitle")}
              </div>
              <p className="subtle" style={{ fontSize: 13 }}>
                {t("msg.confirmBody")}
              </p>
              <div className="confirm-detail">
                <div>
                  <span className="confirm-label">{t("msg.provider")}</span> <span className="mono">{pending.providerId}</span>
                </div>
                <div>
                  <span className="confirm-label">{t("msg.to")}</span> <span className="mono">{pending.destination}</span>
                </div>
                <div className="confirm-text">{pending.text}</div>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <Button variant="primary" disabled={send.isPending} onClick={() => send.mutate(pending)}>
                  <Icon.send className="nav-icon" /> {t("msg.confirmSend")}
                </Button>
                <Button variant="ghost" onClick={() => setPending(null)}>
                  {t("common.cancel")}
                </Button>
              </div>
              {send.error && <div className="banner err" style={{ marginTop: 10 }}>{errorMessage(send.error)}</div>}
            </div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              <div>
                <label className="field-label" htmlFor="msg-to">{t("msg.to")}</label>
                <input
                  id="msg-to"
                  className="input"
                  value={destination}
                  onChange={(e) => {
                    setDestination(e.target.value);
                    setSent(false);
                  }}
                  placeholder={t("msg.toPlaceholder")}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="msg-message">{t("msg.message")}</label>
                <textarea
                  id="msg-message"
                  className="textarea"
                  style={{ minHeight: 120 }}
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                    setSent(false);
                  }}
                />
              </div>
              <div>
                <Button variant="primary" disabled={!canReview} onClick={() => setPending({ destination: destination.trim(), providerId, text: text.trim() })}>
                  {t("msg.review")}
                </Button>
                {sent && (
                  <span style={{ marginLeft: 10 }}>
                    <Badge tone="ok">{t("msg.sent")}</Badge>
                  </span>
                )}
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
