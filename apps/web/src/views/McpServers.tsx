import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { AsyncBlock, Badge, Button, Card } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";
import { canConnect, canDisconnect, mcpStatusTone, summarizeMcpServers } from "./mcp-status.js";

import type { ApiClient } from "../api/client.js";
import type { McpServerSummary } from "../api/types.js";

export function McpServersView({ client }: { client: ApiClient }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const servers = useQuery({
    queryFn: () => client.get<readonly McpServerSummary[]>("/api/mcp/servers"),
    queryKey: ["mcp-servers", client.baseUrl]
  });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ["mcp-servers"] });

  const connect = useMutation({
    mutationFn: (name: string) => client.post(`/api/mcp/servers/${encodeURIComponent(name)}/connect`),
    onSuccess: invalidate
  });
  const disconnect = useMutation({
    mutationFn: (name: string) => client.post(`/api/mcp/servers/${encodeURIComponent(name)}/disconnect`),
    onSuccess: invalidate
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
    </div>
  );
}
