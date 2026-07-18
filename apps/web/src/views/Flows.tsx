import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { AsyncBlock, Button, Icon } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";
import { safeSessionStorage } from "../lib/safe-storage.js";
import { flowToCanvas } from "./flow-canvas-mapping.js";
import {
  consumeBuilderCopilotSeed,
  consumeBuilderCreateForWorkHint,
  consumeBuilderFocusHint,
  writeBuilderCopilotSeed
} from "./scheduled-logic.js";
import { flowDraftToCopilotPayload, isFlowDraftValid } from "./flow-edit-compile.js";
import { FlowCreatePanel } from "./flow-create-panel.js";
import { ScheduleTable } from "./Scheduled.js";
import { UpcomingTab } from "./Autonomy.js";
import { FlowDraftComposer } from "./flow-draft-composer.js";
import { EditFlowCopilot } from "./flow-edit-copilot.js";
import { FlowNodeEditPanel } from "./flow-edit-panel.js";
import { ExecutionsCard } from "./flow-executions.js";
import { FlowSwitcher } from "./flow-switcher.js";
import { FlowCanvasArea } from "./flow-canvas-area.js";
import { FlowHeaderActions } from "./flow-header-actions.js";
import { PatternProposalCards } from "./pattern-proposals.js";

import type { FlowDraft } from "./flow-edit-compile.js";
import type { ApiClient } from "../api/client.js";
import type { FlowDraftPayloadRow, FlowProjection, FlowsResponse } from "../api/types.js";


export function FlowsView({ client }: { client: ApiClient }) {
  return (
    <div className="builder-ws">
      <FlowsTab client={client} />
    </div>
  );
}

export function FlowsTab({ client }: { client: ApiClient }) {
  const q = useQuery({
    queryFn: () => client.get<FlowsResponse>("/api/flows"),
    queryKey: ["flows", client.baseUrl]
  });
  const flows = q.data?.flows ?? [];

  return (
    <AsyncBlock loading={q.isLoading} error={q.error} empty={false}>
      <FlowsBody client={client} flows={flows} />
    </AsyncBlock>
  );
}

type SideTab = "chat" | "node" | "exec";

function FlowsBody({ client, flows }: { client: ApiClient; flows: readonly FlowProjection[] }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [selectedFlowId, setSelectedFlowId] = useState<string | undefined>(() =>
    // A one-shot handoff from Scheduled's "open in Builder" — consumed (and
    // cleared) here so a later manual visit doesn't snap back to it.
    consumeBuilderFocusHint(safeSessionStorage()) ?? flows[0]?.id
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [initialDraft, setInitialDraft] = useState<FlowDraftPayloadRow | undefined>(undefined);
  const [initialBase, setInitialBase] = useState<FlowDraft | undefined>(undefined);
  const [draftVersion, setDraftVersion] = useState(0);
  const [sideTab, setSideTab] = useState<SideTab>("chat");
  const [zen, setZen] = useState(false);
  // Builder workspace mode: the canvas editor, or the operational schedule
  // list (the former standalone Scheduled view, folded in as a tab).
  const [wsMode, setWsMode] = useState<"canvas" | "list">("canvas");
  // Work → Builder handoff: arrive with the create panel open and, once the
  // flow is created, link it back to that Work automatically (one-shot).
  const [createForWorkId, setCreateForWorkId] = useState<string | undefined>(() =>
    consumeBuilderCreateForWorkHint(safeSessionStorage())
  );
  const [workLinkFailed, setWorkLinkFailed] = useState(false);
  // Chat → Builder handoff: chat-automation-honesty.ts's `builderHint`
  // (a recurring-automation ask chat could not register itself) seeds the
  // copilot composer's first turn — one-shot, same discipline as the other
  // Builder hints above.
  const [copilotSeed, setCopilotSeed] = useState<string | undefined>(() => consumeBuilderCopilotSeed(safeSessionStorage()));
  useEffect(() => {
    if (createForWorkId || copilotSeed) {
      setCreating(true);
    }
    // mount-only: the hint is consumed exactly once by the state initializer
  }, []);

  // Full-workspace mode: the builder hides the app chrome (sidebar + topbar)
  // via a root attribute so the CSS can reach OUTSIDE this subtree. Cleaned
  // up on unmount so leaving the Builder view always restores the chrome.
  useEffect(() => {
    const root = document.documentElement;
    if (zen) {
      root.setAttribute("data-builder-zen", "true");
    } else {
      root.removeAttribute("data-builder-zen");
    }
    return () => root.removeAttribute("data-builder-zen");
  }, [zen]);
  useEffect(() => {
    if (!zen) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      // The canvas's own fullscreen overlay owns Escape while it's open —
      // one Escape should peel one layer, not both.
      if (event.key === "Escape" && !document.querySelector(".flow-canvas-fullscreen")) {
        setZen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zen]);
  // The create panel's LIVE form values, mirrored up via `onDraftChange` —
  // this (not the last server-returned draft) is what a follow-up
  // conversational revision turn sends as `currentDraft`, so a manual form
  // edit between turns is respected.
  const [liveDraft, setLiveDraft] = useState<FlowDraft | undefined>(undefined);

  const selectedFlow = flows.find((flow) => flow.id === selectedFlowId) ?? flows[0];

  useEffect(() => {
    setSelectedNodeId(undefined);
  }, [selectedFlow?.id]);

  const openCreatePanel = () => {
    setInitialDraft(undefined);
    setLiveDraft(undefined);
    // A MANUAL open is never Work-bound — only the hint-opened panel is.
    setCreateForWorkId(undefined);
    setCreating(true);
  };
  // Pattern-proposal "흐름 초안 열기": the SAME write→consume seed pair the
  // Chat → Builder handoff uses, just triggered explicitly instead of at
  // mount — this component is already mounted (list mode, not a fresh
  // navigation), so the mount-time `copilotSeed` initializer won't re-fire.
  const openProposalDraft = (suggestionText: string) => {
    writeBuilderCopilotSeed(safeSessionStorage(), suggestionText);
    setCopilotSeed(consumeBuilderCopilotSeed(safeSessionStorage()));
    setInitialDraft(undefined);
    setLiveDraft(undefined);
    setCreateForWorkId(undefined);
    setCreating(true);
    setWsMode("canvas");
  };
  const handleDrafted = (draft: FlowDraftPayloadRow) => {
    setInitialDraft(draft);
    // On a revision turn the remounted panel re-seeds from the payload —
    // hand it the live form so model/system-prompt/retry-count edits the
    // payload can't express survive the turn.
    setInitialBase(creating && liveDraft ? liveDraft : undefined);
    setDraftVersion((version) => version + 1);
    setCreating(true);
  };
  const closeCreatePanel = () => {
    setCreating(false);
    setLiveDraft(undefined);
    // Cancelling ends the Work binding — a flow created LATER in this
    // session must not silently link back to that Work.
    setCreateForWorkId(undefined);
  };
  // The copilot drafts BOTH kinds (agent prompts and read-risk tool flows),
  // so a revision turn carries the live form state — but ONLY once the form
  // is actually a valid draft. A blank/half-filled panel projected as
  // `currentDraft` fails the server's revision validation (400), so an
  // incomplete form sends a FRESH first turn instead.
  const currentDraft = creating && liveDraft && isFlowDraftValid(liveDraft)
    ? flowDraftToCopilotPayload(liveDraft)
    : undefined;

  return (
    <>
      <header className="ws-head">
        <FlowSwitcher
          flows={flows}
          selectedId={selectedFlow?.id}
          onSelect={(id) => {
            setSelectedFlowId(id);
            closeCreatePanel();
          }}
          onCreate={openCreatePanel}
        />
        <div className="ws-mode" role="tablist">
          <button type="button" role="tab" aria-selected={wsMode === "canvas"} className={wsMode === "canvas" ? "on" : ""} onClick={() => setWsMode("canvas")}>
            {t("auto.flows.mode.canvas")}
          </button>
          <button type="button" role="tab" aria-selected={wsMode === "list"} className={wsMode === "list" ? "on" : ""} onClick={() => setWsMode("list")}>
            {t("auto.flows.mode.list")}
          </button>
        </div>
        <span className="ws-spacer" />
        <button
          type="button"
          className="ws-zen-btn"
          aria-pressed={zen}
          aria-label={t(zen ? "auto.flows.zen.exit" : "auto.flows.zen.enter")}
          title={t(zen ? "auto.flows.zen.exit" : "auto.flows.zen.enter")}
          onClick={() => setZen((value) => !value)}
        >
          {zen ? <Icon.shrink /> : <Icon.expand />}
        </button>
      </header>

      {wsMode === "list" ? (
        <div className="ws-list">
          <PatternProposalCards client={client} onOpenDraft={openProposalDraft} />
          <ScheduleTable
            client={client}
            onOpenFlow={(id) => {
              setSelectedFlowId(id);
              setWsMode("canvas");
            }}
            onNavigate={undefined}
          />
          <div style={{ marginTop: 24 }}>
            <UpcomingTab client={client} />
          </div>
        </div>
      ) : (
      <div className="ws-body">
        <div className="ws-main">
          {workLinkFailed && (
            <div className="banner err" style={{ margin: "10px 12px 0" }}>
              {t("auto.flows.workLinkFailed")}
              <button type="button" className="banner-dismiss" onClick={() => setWorkLinkFailed(false)} aria-label={t("common.cancel")}>
                ×
              </button>
            </div>
          )}
          {creating ? (
            <div className="ws-create">
              <FlowCreatePanel
                key={initialDraft ? `draft-${draftVersion.toString()}` : "empty"}
                client={client}
                initialDraft={initialDraft}
                initialBase={initialBase}
                onDraftChange={setLiveDraft}
                onCancel={closeCreatePanel}
                onCreated={(jobId) => {
                  closeCreatePanel();
                  setSelectedFlowId(jobId);
                  if (createForWorkId) {
                    const workId = createForWorkId;
                    setCreateForWorkId(undefined);
                    setWorkLinkFailed(false);
                    void client
                      .post(`/api/works/${workId}/link`, { id: jobId, kind: "flow" })
                      .then(() => void qc.invalidateQueries({ queryKey: ["works"] }))
                      .catch(() => {
                        // The flow itself was created — surface the miss so the
                        // user knows to link it manually from the Work view.
                        setWorkLinkFailed(true);
                      });
                  }
                }}
              />
            </div>
          ) : !selectedFlow ? (
            // Zero flows must still offer the create entry point; the copilot
            // stays available in the side panel.
            <div className="empty-block" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "40px 0" }}>
              <Icon.activity className="nav-icon" />
              <div style={{ fontWeight: 600 }}>{t("auto.flows.emptyTitle")}</div>
              <div className="muted" style={{ fontSize: 13, maxWidth: 420, textAlign: "center" }}>{t("auto.flows.emptyHint")}</div>
              <Button variant="primary" size="sm" onClick={openCreatePanel}>
                <Icon.plus className="nav-icon" /> {t("auto.flows.create.button")}
              </Button>
            </div>
          ) : (
            <>
              <FlowHeaderActions
                client={client}
                flow={selectedFlow}
                onDeleted={() => {
                  setSelectedFlowId(flows.find((flow) => flow.id !== selectedFlow.id)?.id);
                }}
                onDuplicated={(jobId) => setSelectedFlowId(jobId)}
              />
              <div className="ws-main-canvas">
                <FlowCanvasArea
                  client={client}
                  flow={selectedFlow}
                  onSelectNode={(id) => {
                    setSelectedNodeId(id);
                    setSideTab("node");
                  }}
                  onDeselectNode={() => setSelectedNodeId(undefined)}
                />
              </div>
            </>
          )}
        </div>

        <aside className="ws-side">
          <div className="ws-side-tabs" role="tablist">
            <button role="tab" aria-selected={sideTab === "chat"} className={sideTab === "chat" ? "on" : ""} onClick={() => setSideTab("chat")}>
              ✦ {t("auto.flows.side.copilot")}
            </button>
            <button role="tab" aria-selected={sideTab === "node"} className={sideTab === "node" ? "on" : ""} onClick={() => setSideTab("node")}>
              {t("auto.flows.detailTitle")}
            </button>
            <button role="tab" aria-selected={sideTab === "exec"} className={sideTab === "exec" ? "on" : ""} onClick={() => setSideTab("exec")}>
              {t("auto.flows.executions.title")}
            </button>
          </div>
          <div className={`ws-side-body${sideTab === "chat" ? " chat" : ""}`}>
            {sideTab === "chat" && (
              creating || !selectedFlow ? (
                <FlowDraftComposer
                  client={client}
                  onDrafted={handleDrafted}
                  currentDraft={currentDraft}
                  initialText={currentDraft === undefined ? copilotSeed : undefined}
                />
              ) : (
                <EditFlowCopilot client={client} flowId={selectedFlow.id} />
              )
            )}
            {sideTab === "node" && (
              selectedFlow && selectedNodeId ? (
                <FlowNodeDetailHost
                  client={client}
                  flow={selectedFlow}
                  nodeId={selectedNodeId}
                  // invalidation is owned by the edit panel's own onSuccess
                  onSaved={() => undefined}
                />
              ) : (
                <p className="subtle">{t("auto.flows.detailEmpty")}</p>
              )
            )}
            {sideTab === "exec" && (
              selectedFlow ? (
                <ExecutionsCard client={client} jobId={selectedFlow.id} />
              ) : (
                <p className="subtle">{t("auto.flows.detailEmpty")}</p>
              )
            )}
          </div>
        </aside>
      </div>
      )}
    </>
  );
}

function FlowNodeDetailHost({
  client,
  flow,
  nodeId,
  onSaved
}: {
  client: ApiClient;
  flow: FlowProjection;
  nodeId: string;
  onSaved: () => void;
}) {
  const canvas = flowToCanvas(flow);
  const node = canvas.nodes.find((candidate) => candidate.id === nodeId);
  const { t } = useI18n();

  if (!node) {
    return <p className="subtle">{t("auto.flows.detailEmpty")}</p>;
  }

  return <FlowNodeEditPanel client={client} jobId={flow.id} node={node} onSaved={onSaved} />;
}
