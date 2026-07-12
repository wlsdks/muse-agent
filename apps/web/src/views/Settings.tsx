import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { AsyncBlock, Badge, Button, Card, Icon } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";

import { normalizeApiBaseUrl } from "../lib/apiUrl.js";

import type { ApiClient } from "../api/client.js";
import type { StringKey } from "../i18n/strings.js";
import type { ContactsResponse, DaemonFlagsResponse, ModelsResponse } from "../api/types.js";
import { summarizeFlags } from "./settings-flags.js";

interface SetupSection {
  readonly status?: "ok" | "info" | "todo" | string;
}
type SetupStatus = Record<string, (SetupSection & Record<string, unknown>) | undefined>;

interface HealthResponse {
  readonly status?: string;
  readonly version?: string;
}

const SETUP_KEYS = ["model", "mcp", "notes", "tasks", "voice", "messaging", "proactive"] as const;
const SETUP_LABEL_KEYS: Readonly<Record<string, StringKey>> = {
  mcp: "settings.setup.mcp",
  messaging: "settings.setup.messaging",
  model: "settings.setup.model",
  notes: "settings.setup.notes",
  proactive: "settings.setup.proactive",
  tasks: "settings.setup.tasks",
  voice: "settings.setup.voice"
};

/** Section = card + one plain-language line saying WHY it exists. The
 * page reads top-down as: what's running → daily knobs → advanced. */
function Section({ title, explain, count, children }: {
  title: string;
  explain: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginTop: 16 }}>
      <Card title={title} {...(count !== undefined ? { count } : {})}>
        <p className="subtle" style={{ fontSize: 12, marginBottom: 10, marginTop: 0 }}>
          {explain}
        </p>
        {children}
      </Card>
    </div>
  );
}

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

  const health = useQuery({
    queryFn: () => client.get<HealthResponse>("/api/health"),
    queryKey: ["health", client.baseUrl]
  });
  const setup = useQuery({
    queryFn: () => client.get<SetupStatus>("/api/setup/status"),
    queryKey: ["setup", client.baseUrl]
  });
  const models = useQuery({
    queryFn: () => client.get<ModelsResponse>("/api/models"),
    queryKey: ["models", client.baseUrl]
  });

  const setupRows: readonly [string, SetupSection | undefined][] = setup.data
    ? SETUP_KEYS.map((k) => [k, setup.data?.[k]])
    : [];

  return (
    <div className="content-narrow">
      <p className="eyebrow">{t("group.system")}</p>
      <h1 className="page-title">{t("settings.title")}</h1>
      <p className="muted" style={{ marginTop: 4 }}>
        {t("settings.subtitle")}
      </p>
      <div style={{ alignItems: "center", display: "flex", gap: 8, marginTop: 10 }}>
        <Badge tone={health.data?.status === "ok" ? "ok" : "err"}>
          {t(health.data?.status === "ok" ? "settings.serverHealthy" : "settings.serverUnreachable")}
        </Badge>
        {health.data?.version && (
          <span className="subtle mono" style={{ fontSize: 11 }}>
            {t("settings.server")} {health.data.version}
          </span>
        )}
      </div>

      <Section title={t("settings.language")} explain={t("settings.sec.language")}>
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
      </Section>

      <Section title={t("settings.activeModel")} explain={t("settings.sec.model")}>
        <AsyncBlock loading={models.isLoading} error={models.error}>
          <div className="row">
            <div className="row-main">
              <div className="row-title mono">
                {models.data?.defaultModel ?? models.data?.active ?? "—"}
              </div>
              <div className="row-meta">{t("settings.modelsAvailable", { n: models.data?.models?.length ?? 0 })}</div>
            </div>
            <Badge tone="accent" dot={false}>
              local
            </Badge>
          </div>
        </AsyncBlock>
      </Section>

      <Section title={t("settings.setupStatus")} explain={t("settings.sec.setup")}>
        <AsyncBlock loading={setup.isLoading} error={setup.error} empty={setupRows.length === 0}>
          {setupRows.map(([name, section]) => (
            <div className="row" key={name}>
              <div className="row-main">
                <div className="row-title">{t(SETUP_LABEL_KEYS[name] ?? "settings.setup.model")}</div>
              </div>
              <Badge tone={section?.status === "ok" ? "ok" : "neutral"} dot={section?.status === "ok"}>
                {section?.status === "ok" ? t("settings.ready") : section?.status === "info" ? t("settings.optional") : t("settings.notSet")}
              </Badge>
            </div>
          ))}
        </AsyncBlock>
      </Section>

      <DaemonsSection client={client} />

      <div style={{ marginTop: 16 }}>
        <ContactsSection client={client} />
      </div>

      <Section title={t("settings.connectionAdvanced")} explain={t("settings.sec.connection")}>
        {(() => {
          const norm = normalizeApiBaseUrl(url);
          const showError = url.trim().length > 0 && !norm.valid;
          return (
            <div style={{ display: "grid", gap: 12 }}>
              <div>
                <label className="field-label">{t("settings.apiUrl")}</label>
                <input
                  className="input"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="http://127.0.0.1:3030"
                  aria-invalid={showError}
                />
                {showError && (
                  <p className="subtle" style={{ color: "var(--danger)", fontSize: 12, marginTop: 6 }}>
                    {t("settings.apiUrlInvalid")}
                  </p>
                )}
              </div>
              <div>
                <label className="field-label">{t("settings.token")}</label>
                <input className="input" value={tok} onChange={(e) => setTok(e.target.value)} placeholder={t("settings.tokenPlaceholder")} />
              </div>
              <div>
                <Button variant="primary" disabled={!norm.valid} onClick={() => onSave?.(norm.url, tok.trim())}>
                  {t("common.save")}
                </Button>
              </div>
            </div>
          );
        })()}
      </Section>

      <p className="subtle" style={{ marginTop: 24, fontSize: 12 }}>
        {t("settings.credit")}
      </p>
    </div>
  );
}

/** Daemon toggles — same PATCH seam as the Integrations tab. Channel
 * daemons apply live; the rest persist and note the pending restart. */
function DaemonsSection({ client }: { client: ApiClient }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [restartNote, setRestartNote] = useState<string | null>(null);

  const daemonFlags = useQuery({
    queryFn: () => client.get<DaemonFlagsResponse>("/api/settings/daemon-flags"),
    queryKey: ["daemon-flags", client.baseUrl]
  });
  const toggle = useMutation({
    mutationFn: (input: { key: string; enabled: boolean }) =>
      client.patch<{ appliedLive: boolean }>("/api/settings/daemon-flags", { enabled: input.enabled, key: input.key }),
    onSuccess: (result, input) => {
      setRestartNote(result.appliedLive ? null : input.key);
      void queryClient.invalidateQueries({ queryKey: ["daemon-flags", client.baseUrl] });
    }
  });

  const flags = daemonFlags.data?.flags ?? [];
  const sum = summarizeFlags(flags);

  return (
    <Section title={t("settings.daemons")} explain={t("settings.sec.daemons")}>
      <p className="subtle" style={{ fontSize: 12, marginBottom: 8 }}>
        {t("settings.daemonsSummary", { enabled: sum.enabled, total: sum.total })}
      </p>
      <AsyncBlock loading={daemonFlags.isLoading} error={daemonFlags.error} empty={flags.length === 0}>
        {flags.map((flag) => (
          <div className="row" key={flag.key}>
            <div className="row-main">
              <div className="row-title">{flag.label}</div>
              {restartNote === flag.key && (
                <div className="row-meta">{t("settings.daemon.appliedRestart")}</div>
              )}
            </div>
            <div style={{ alignItems: "center", display: "flex", gap: 8 }}>
              <Badge tone={flag.enabled ? "ok" : "neutral"}>
                {flag.enabled ? t("settings.on") : t("settings.off")}
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                disabled={toggle.isPending}
                onClick={() => toggle.mutate({ enabled: !flag.enabled, key: flag.key })}
              >
                {flag.enabled ? t("int.daemon.turnOff") : t("int.daemon.turnOn")}
              </Button>
            </div>
          </div>
        ))}
      </AsyncBlock>
    </Section>
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
