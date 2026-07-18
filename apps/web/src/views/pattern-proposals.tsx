import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";

import type { ApiClient } from "../api/client.js";
import type { AutomationProposalsResponse, FlowProposalRow } from "../api/types.js";

/**
 * Builder automation proposals mined from observed patterns
 * ("3주 연속 월요일 오전에 X를 하셨네요 — 흐름으로 만들까요?"). Renders
 * ABOVE the Schedule tab's flow list — zero noise when there is nothing to
 * propose (renders nothing, not an empty-state card).
 *
 * "흐름 초안 열기" hands the suggestion text to the caller, which prefills
 * the Builder copilot composer and opens the create panel — draft-first,
 * the user still clicks 만들기. "사양할게요" persists the rejection
 * server-side; the card disappears and that pattern id never returns.
 */
export function PatternProposalCards({
  client,
  onOpenDraft
}: {
  client: ApiClient;
  onOpenDraft: (suggestionText: string) => void;
}) {
  const qc = useQueryClient();
  const query = useQuery({
    queryFn: () => client.get<AutomationProposalsResponse>("/api/automation/proposals"),
    queryKey: ["automation-proposals", client.baseUrl]
  });
  const reject = useMutation({
    mutationFn: (id: string) => client.post(`/api/automation/proposals/${encodeURIComponent(id)}/reject`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["automation-proposals", client.baseUrl] })
  });

  const proposals = query.data?.proposals ?? [];
  if (proposals.length === 0) {
    return null;
  }

  return (
    <div className="pattern-proposals">
      {proposals.map((proposal) => (
        <PatternProposalCard
          key={proposal.id}
          proposal={proposal}
          busy={reject.isPending}
          onOpenDraft={() => onOpenDraft(proposal.suggestionText)}
          onReject={() => reject.mutate(proposal.id)}
        />
      ))}
    </div>
  );
}

function PatternProposalCard({
  proposal,
  busy,
  onOpenDraft,
  onReject
}: {
  proposal: FlowProposalRow;
  busy: boolean;
  onOpenDraft: () => void;
  onReject: () => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const receipt = proposal.receipt;
  const summaryKey = receipt.distinctUnit === "weeks" ? "auto.proposals.receiptWeeks" : "auto.proposals.receiptDays";

  return (
    <div className="pattern-proposal-card">
      <div className="pattern-proposal-head">
        <span className="pattern-proposal-title">{proposal.title}</span>
        <span className="pattern-proposal-conf">{Math.round(receipt.confidence * 100)}%</span>
      </div>
      <p className="pattern-proposal-line">{proposal.suggestionText}</p>
      <p className="subtle pattern-proposal-summary">
        {t(summaryKey, {
          confidence: Math.round(receipt.confidence * 100),
          count: receipt.observationCount,
          distinct: receipt.distinctCount
        })}
      </p>
      {expanded && receipt.examples.length > 0 && (
        <ul className="pattern-proposal-examples">
          {receipt.examples.map((example) => (
            <li key={example}>{example}</li>
          ))}
        </ul>
      )}
      <div className="pattern-proposal-actions">
        {receipt.examples.length > 0 && (
          <button type="button" className="pattern-proposal-toggle" onClick={() => setExpanded((value) => !value)}>
            {t(expanded ? "auto.proposals.hideEvidence" : "auto.proposals.showEvidence")}
          </button>
        )}
        <span className="ws-spacer" />
        <Button variant="ghost" size="sm" disabled={busy} onClick={onReject}>
          {t("auto.proposals.reject")}
        </Button>
        <Button variant="primary" size="sm" onClick={onOpenDraft}>
          {t("auto.proposals.openDraft")}
        </Button>
      </div>
    </div>
  );
}
