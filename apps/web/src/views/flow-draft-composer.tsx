import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage } from "@muse/shared/browser";

import { Button } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";

import type { ApiClient } from "../api/client.js";
import type { FlowDraftPayloadRow, FlowDraftResponse } from "../api/types.js";

const FLOW_DRAFT_URL = "/api/flows/draft";

/**
 * "코파일럿 초안": a one-line description → `POST /api/flows/draft` → the
 * parsed draft is handed to the caller (which opens `FlowCreatePanel`
 * prefilled). This component NEVER creates a job itself — draft-first,
 * same discipline as every other outbound/mutating surface in this repo.
 */
export function FlowDraftComposer({
  client,
  onDrafted
}: {
  client: ApiClient;
  onDrafted: (draft: FlowDraftPayloadRow) => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState("");

  const draft = useMutation({
    mutationFn: () => client.post<FlowDraftResponse>(FLOW_DRAFT_URL, { text: text.trim() }),
    onSuccess: (response) => {
      setText("");
      onDrafted(response.draft);
    }
  });

  const canDraft = text.trim().length > 0 && !draft.isPending;

  return (
    <div style={{ display: "grid", gap: 6, marginBottom: 10 }}>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          aria-label={t("auto.flows.draft.inputLabel")}
          className="input"
          type="text"
          placeholder={t("auto.flows.draft.placeholder")}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Button variant="secondary" size="sm" disabled={!canDraft} onClick={() => draft.mutate()}>
          {draft.isPending ? t("auto.flows.draft.drafting") : t("auto.flows.draft.button")}
        </Button>
      </div>
      {draft.error && <div className="banner err">{errorMessage(draft.error, t("auto.flows.draft.fallbackFailed"))}</div>}
    </div>
  );
}
