import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { AsyncBlock, Badge, Button, Card, Icon } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";

import type { ApiClient } from "../api/client.js";
import type { ContactsResponse, DaemonFlagsResponse, ModelsResponse } from "../api/types.js";
import { summarizeFlags } from "./settings-flags.js";

interface SetupSection {
  readonly ok?: boolean;
  readonly ready?: boolean;
  readonly configured?: boolean;
}
type SetupStatus = Record<string, SetupSection & Record<string, unknown>> & {
  readonly model?: { readonly muse_model?: string; readonly providerKeys?: readonly string[] } & SetupSection;
};

export function SettingsView({
  client,
  apiUrl = "",
  token = "",
  onSave
}: {
  client: ApiClient;
  apiUrl?: string;
  token?: string;
  onSave?: (url: string, token: string) => void;
}) {
  const { lang, setLang, t } = useI18n();
  const [url, setUrl] = useState(apiUrl);
  const [tok, setTok] = useState(token);

  const setup = useQuery({
    queryFn: () => client.get<SetupStatus>("/api/setup/status"),
    queryKey: ["setup", client.baseUrl]
  });
  const models = useQuery({
    queryFn: () => client.get<ModelsResponse>("/api/models"),
    queryKey: ["models", client.baseUrl]
  });
  const daemonFlags = useQuery({
    queryFn: () => client.get<DaemonFlagsResponse>("/api/settings/daemon-flags"),
    queryKey: ["daemon-flags", client.baseUrl]
  });

  const sectionOk = (s?: SetupSection) => Boolean(s?.ok ?? s?.ready ?? s?.configured);
  const setupRows: readonly [string, SetupSection | undefined][] = setup.data
    ? (["model", "mcp", "notes", "tasks", "voice", "messaging", "proactive"] as const).map((k) => [
        k,
        setup.data?.[k] as SetupSection | undefined
      ])
    : [];

  return (
    <div className="content-narrow">
      <p className="eyebrow">{t("group.system")}</p>
      <h1 className="page-title">{t("settings.title")}</h1>

      <Card title={t("settings.connection")} className="lifted">
        <div style={{ display: "grid", gap: 12 }}>
          <div>
            <label className="field-label">{t("settings.apiUrl")}</label>
            <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://127.0.0.1:3030" />
          </div>
          <div>
            <label className="field-label">{t("settings.token")}</label>
            <input className="input" value={tok} onChange={(e) => setTok(e.target.value)} placeholder={t("settings.tokenPlaceholder")} />
          </div>
          <div>
            <Button variant="primary" onClick={() => onSave?.(url.trim(), tok.trim())}>
              {t("common.save")}
            </Button>
          </div>
        </div>
      </Card>

      <div style={{ marginTop: 16 }}>
        <Card title={t("settings.language")}>
          <div className="row" style={{ borderBottom: "none" }}>
            <div className="row-main">
              <div className="row-title">{lang === "ko" ? "한국어" : "English"}</div>
            </div>
            <div className="lang-toggle">
              <button className={lang === "en" ? "active" : ""} onClick={() => setLang("en")}>
                English
              </button>
              <button className={lang === "ko" ? "active" : ""} onClick={() => setLang("ko")}>
                한국어
              </button>
            </div>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t("settings.activeModel")}>
          <AsyncBlock loading={models.isLoading} error={models.error}>
            <div className="row">
              <div className="row-main">
                <div className="row-title mono">
                  {(setup.data?.model?.muse_model as string) ?? models.data?.active ?? "—"}
                </div>
                <div className="row-meta">{t("settings.modelsAvailable", { n: models.data?.models?.length ?? 0 })}</div>
              </div>
              <Badge tone="accent" dot={false}>
                local
              </Badge>
            </div>
          </AsyncBlock>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t("settings.setupStatus")}>
          <AsyncBlock loading={setup.isLoading} error={setup.error} empty={setupRows.length === 0}>
            {setupRows.map(([name, section]) => (
              <div className="row" key={name}>
                <div className="row-main">
                  <div className="row-title" style={{ textTransform: "capitalize" }}>
                    {name}
                  </div>
                </div>
                <Badge tone={sectionOk(section) ? "ok" : "neutral"}>
                  {sectionOk(section) ? t("settings.ready") : t("settings.notSet")}
                </Badge>
              </div>
            ))}
          </AsyncBlock>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <ContactsSection client={client} />
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t("settings.daemons")}>
          {(() => {
            const flags = daemonFlags.data?.flags ?? [];
            const sum = summarizeFlags(flags);
            return (
              <>
                <p className="subtle" style={{ marginBottom: 8, fontSize: 12 }}>
                  {t("settings.daemonsSummary", { enabled: sum.enabled, total: sum.total })}
                </p>
                <AsyncBlock loading={daemonFlags.isLoading} error={daemonFlags.error} empty={flags.length === 0}>
                  {flags.map((flag) => (
                    <div className="row" key={flag.key}>
                      <div className="row-main">
                        <div className="row-title">{flag.label}</div>
                      </div>
                      <Badge tone={flag.enabled ? "ok" : "neutral"}>
                        {flag.enabled ? t("settings.on") : t("settings.off")}
                      </Badge>
                    </div>
                  ))}
                </AsyncBlock>
              </>
            );
          })()}
        </Card>
      </div>

      <p className="subtle" style={{ marginTop: 24, fontSize: 12 }}>
        {t("settings.credit")}
      </p>
    </div>
  );
}

function ContactsSection({ client }: { client: ApiClient }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");

  const q = useQuery({
    queryFn: () => client.get<ContactsResponse>("/api/contacts"),
    queryKey: ["contacts", client.baseUrl]
  });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ["contacts"] });
  const add = useMutation({
    mutationFn: (body: Record<string, string>) => client.post("/api/contacts", body),
    onSuccess: () => {
      setName("");
      setPhone("");
      setEmail("");
      invalidate();
    }
  });
  const remove = useMutation({
    mutationFn: (id: string) => client.del(`/api/contacts/${id}`),
    onSuccess: invalidate
  });

  const list = q.data?.contacts ?? [];
  return (
    <Card title={t("auto.tab.contacts")} count={q.data?.total ?? 0}>
      <p className="subtle" style={{ marginTop: -4, marginBottom: 12, fontSize: 12 }}>
        {t("auto.contactsNote")}
      </p>
      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr 1fr auto", alignItems: "end" }}>
        <div>
          <label className="field-label" htmlFor="contact-name">{t("auto.name")}</label>
          <input id="contact-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Dr. Kim" />
        </div>
        <div>
          <label className="field-label" htmlFor="contact-phone">{t("auto.phone")}</label>
          <input id="contact-phone" className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 415 555 0101" />
        </div>
        <div>
          <label className="field-label" htmlFor="contact-email">{t("auto.email")}</label>
          <input id="contact-email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="kim@example.com" />
        </div>
        <Button
          variant="primary"
          disabled={!name.trim() || add.isPending}
          onClick={() => add.mutate({ email: email.trim(), name: name.trim(), phone: phone.trim() })}
        >
          <Icon.plus className="nav-icon" /> {t("common.add")}
        </Button>
      </div>
      <div style={{ marginTop: 16 }}>
        <AsyncBlock loading={q.isLoading} error={q.error} empty={list.length === 0}>
          {list.map((c) => (
            <div className="row" key={c.id}>
              <div className="row-main">
                <div className="row-title">{c.name}</div>
                <div className="row-meta">{[c.phone, c.email, c.handle].filter(Boolean).join(" · ")}</div>
              </div>
              <Button variant="ghost" size="sm" title={t("common.delete")} ariaLabel={t("common.delete")} onClick={() => remove.mutate(c.id)}>
                <Icon.trash className="nav-icon" />
              </Button>
            </div>
          ))}
        </AsyncBlock>
      </div>
    </Card>
  );
}
