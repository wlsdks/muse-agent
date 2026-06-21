import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { AsyncBlock, Badge, Button, Card } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";
import { addToAllowlist, canConnect, canDisconnect, mcpStatusTone, removeFromAllowlist, summarizeAllowlist, summarizeMcpServers } from "./mcp-status.js";

import type { ApiClient } from "../api/client.js";
import type { McpSecurityResponse, McpServerSummary } from "../api/types.js";

export function McpServersView({ client }: { client: ApiClient }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [addInput, setAddInput] = useState("");

  const servers = useQuery({
    queryFn: () => client.get<readonly McpServerSummary[]>("/api/mcp/servers"),
    queryKey: ["mcp-servers", client.baseUrl]
  });
  const security = useQuery({
    queryFn: () => client.get<McpSecurityResponse>("/api/mcp/security"),
    queryKey: ["mcp-security", client.baseUrl]
  });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ["mcp-servers"] });
  const invalidateSecurity = () => void qc.invalidateQueries({ queryKey: ["mcp-security"] });

  const connect = useMutation({
    mutationFn: (name: string) => client.post(`/api/mcp/servers/${encodeURIComponent(name)}/connect`),
    onSuccess: invalidate
  });
  const disconnect = useMutation({
    mutationFn: (name: string) => client.post(`/api/mcp/servers/${encodeURIComponent(name)}/disconnect`),
    onSuccess: invalidate
  });
  const updateAllowlist = useMutation({
    mutationFn: (allowedServerNames: string[]) => {
      const policy = security.data?.effective;
      return client.put("/api/mcp/security", {
        allowedServerNames,
        allowedStdioCommands: policy?.allowedStdioCommands ?? [],
        maxToolOutputLength: policy?.maxToolOutputLength ?? 0
      });
    },
    onSuccess: invalidateSecurity
  });
  const busy = connect.isPending || disconnect.isPending;

  const list = servers.data ?? [];
  const counts = summarizeMcpServers(list);

  return (
    <div className="content-narrow">
      <p className="eyebrow">{t("group.system")}</p>
      <h1 className="page-title">{t("mcp.title")}</h1>
      <p className="muted" style={{ marginTop: 4 }}>
        {t("mcp.subtitle", { n: counts.total, c: counts.connected })}
      </p>

      <div style={{ marginTop: 16 }}>
        <AsyncBlock loading={servers.isLoading} error={servers.error} empty={list.length === 0}>
          {list.map((server) => (
            <div key={server.id} style={{ marginBottom: 10 }}>
              <Card className="lifted">
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <strong>{server.name}</strong>
                    <Badge tone={mcpStatusTone(server.status)}>{server.status}</Badge>
                    <span className="muted" style={{ fontSize: 13 }}>
                      {t("mcp.toolCount", { n: server.toolCount })}
                    </span>
                  </div>
                  {server.description ? (
                    <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
                      {server.description}
                    </p>
                  ) : null}
                </div>
                {canDisconnect(server.status) ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => disconnect.mutate(server.name)}
                  >
                    {t("mcp.disconnect")}
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busy || !canConnect(server.status)}
                    onClick={() => connect.mutate(server.name)}
                  >
                    {t("mcp.connect")}
                  </Button>
                )}
              </div>
              </Card>
            </div>
          ))}
        </AsyncBlock>
      </div>

      <div style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>{t("mcp.securityTitle")}</h2>
        <AsyncBlock loading={security.isLoading} error={security.error}>
          <Card>
            {(() => {
              const effective = security.data?.effective ?? { allowedServerNames: [], maxToolOutputLength: 0 };
              const allowlist = summarizeAllowlist(effective);
              const allowlistBusy = updateAllowlist.isPending;
              return (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div>
                    {allowlist.unrestricted ? (
                      <Badge tone="warn">{t("mcp.allowlistUnrestricted")}</Badge>
                    ) : (
                      <>
                        <p style={{ margin: "0 0 6px", fontSize: 13 }}>
                          {t("mcp.allowlistRestricted", { n: allowlist.allowedCount })}
                        </p>
                        <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, listStyle: "none" }}>
                          {effective.allowedServerNames.map((name) => (
                            <li key={name} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                              <Badge tone="ok">{name}</Badge>
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={allowlistBusy}
                                onClick={() => updateAllowlist.mutate(removeFromAllowlist(effective.allowedServerNames, name))}
                              >
                                {t("mcp.allowlistRemove")}
                              </Button>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                  {allowlist.unrestricted ? (
                    <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                      {t("mcp.allowlistAddHint")}
                    </p>
                  ) : null}
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input
                      className="input"
                      value={addInput}
                      onChange={(e) => setAddInput(e.target.value)}
                      placeholder={t("mcp.allowlistAddPlaceholder")}
                      style={{ flex: 1 }}
                    />
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={allowlistBusy}
                      onClick={() => {
                        updateAllowlist.mutate(addToAllowlist(effective.allowedServerNames, addInput));
                        setAddInput("");
                      }}
                    >
                      {t("mcp.allowlistAdd")}
                    </Button>
                  </div>
                  <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                    {t("mcp.toolOutputCap", { n: effective.maxToolOutputLength })}
                  </p>
                </div>
              );
            })()}
          </Card>
        </AsyncBlock>
      </div>
    </div>
  );
}
