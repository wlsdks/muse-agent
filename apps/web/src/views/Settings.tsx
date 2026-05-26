import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { AsyncBlock, Badge, Button, Card } from "../components/ui.js";

import type { ApiClient } from "../api/client.js";
import type { ModelsResponse } from "../api/types.js";

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

  const sectionOk = (s?: SetupSection) => Boolean(s?.ok ?? s?.ready ?? s?.configured);
  const setupRows: readonly [string, SetupSection | undefined][] = setup.data
    ? (["model", "mcp", "notes", "tasks", "voice", "messaging", "proactive"] as const).map((k) => [
        k,
        setup.data?.[k] as SetupSection | undefined
      ])
    : [];

  return (
    <div className="content-narrow">
      <p className="eyebrow">System</p>
      <h1 className="page-title">Settings</h1>

      <Card title="Connection" className="lifted">
        <div style={{ display: "grid", gap: 12 }}>
          <div>
            <label className="field-label">API server URL</label>
            <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://127.0.0.1:3030" />
          </div>
          <div>
            <label className="field-label">Bearer token (optional)</label>
            <input className="input" value={tok} onChange={(e) => setTok(e.target.value)} placeholder="leave empty for local" />
          </div>
          <div>
            <Button variant="primary" onClick={() => onSave?.(url.trim(), tok.trim())}>
              Save & reconnect
            </Button>
          </div>
        </div>
      </Card>

      <div style={{ marginTop: 16 }}>
        <Card title="Active model">
          <AsyncBlock loading={models.isLoading} error={models.error}>
            <div className="row">
              <div className="row-main">
                <div className="row-title mono">
                  {(setup.data?.model?.muse_model as string) ?? models.data?.active ?? "—"}
                </div>
                <div className="row-meta">{(models.data?.models?.length ?? 0)} models available</div>
              </div>
              <Badge tone="accent" dot={false}>
                local
              </Badge>
            </div>
          </AsyncBlock>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title="Setup status">
          <AsyncBlock loading={setup.isLoading} error={setup.error} empty={setupRows.length === 0}>
            {setupRows.map(([name, section]) => (
              <div className="row" key={name}>
                <div className="row-main">
                  <div className="row-title" style={{ textTransform: "capitalize" }}>
                    {name}
                  </div>
                </div>
                <Badge tone={sectionOk(section) ? "ok" : "neutral"}>{sectionOk(section) ? "ready" : "not set"}</Badge>
              </div>
            ))}
          </AsyncBlock>
        </Card>
      </div>

      <p className="subtle" style={{ marginTop: 24, fontSize: 12 }}>
        Design system derived from Linear via VoltAgent/awesome-design-md (MIT). See apps/web/design/DESIGN.md.
      </p>
    </div>
  );
}
