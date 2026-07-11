import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { AsyncBlock, Badge, Button, Card } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";
import { buildPersonaRaw, layerLabelKey, splitPersonaBody, type PersonaFieldValues } from "./prompt-lab-logic.js";

import type { ApiClient } from "../api/client.js";
import type {
  PromptExperimentResponse,
  PromptPersonaResponse,
  PromptPersonaSaveResponse,
  PromptPreviewResponse
} from "../api/types.js";

const PREVIEW_SURFACES = ["chat", "ask"] as const;
type PreviewSurface = (typeof PREVIEW_SURFACES)[number];

const EMPTY_FIELDS: PersonaFieldValues = { language: "", maxWords: "", register: "" };

/**
 * S3 admin surface (docs/strategy/prompt-architecture.md §S3): edit the
 * user-manageable personality layer, preview the EFFECTIVE composed system
 * prompt per surface, and A/B a draft against the saved version before
 * committing to it. Every write goes through the server's own
 * validate+injection-scan (`@muse/recall`'s `parsePersonaContent`) — this
 * view never trusts client-side validation as the source of truth.
 */
export function PromptLab({ client }: { client: ApiClient }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const persona = useQuery({
    queryFn: () => client.get<PromptPersonaResponse>("/api/prompt/persona"),
    queryKey: ["prompt-persona", client.baseUrl]
  });

  const [fields, setFields] = useState<PersonaFieldValues>(EMPTY_FIELDS);
  const [bodyText, setBodyText] = useState("");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!persona.data || dirty) return;
    setFields({
      language: persona.data.frontmatter.language ?? "",
      maxWords: persona.data.frontmatter.maxWords !== undefined ? String(persona.data.frontmatter.maxWords) : "",
      register: persona.data.frontmatter.register ?? ""
    });
    setBodyText(splitPersonaBody(persona.data.raw));
    // Deliberately keyed on persona.data only — re-seed on a FRESH server read, never on local edits.
  }, [persona.data]);

  const save = useMutation({
    mutationFn: () => client.put<PromptPersonaSaveResponse>("/api/prompt/persona", { raw: buildPersonaRaw(fields, bodyText) }),
    onSuccess: (result) => {
      setDirty(false);
      setBodyText(splitPersonaBody(result.raw));
      void queryClient.invalidateQueries({ queryKey: ["prompt-persona", client.baseUrl] });
      void queryClient.invalidateQueries({ queryKey: ["prompt-preview", client.baseUrl] });
    }
  });

  const [previewSurface, setPreviewSurface] = useState<PreviewSurface>("chat");
  const preview = useQuery({
    queryFn: () => client.get<PromptPreviewResponse>(`/api/prompt/preview?surface=${previewSurface}`),
    queryKey: ["prompt-preview", client.baseUrl, previewSurface]
  });

  const [question, setQuestion] = useState("");
  const experiment = useMutation({
    mutationFn: () =>
      client.post<PromptExperimentResponse>("/api/prompt/experiment", {
        draftPersonaRaw: buildPersonaRaw(fields, bodyText),
        question: question.trim()
      })
  });

  return (
    <div className="content-narrow">
      <p className="eyebrow">{t("group.system")}</p>
      <h1 className="page-title">{t("nav.promptLab")}</h1>
      <p className="muted" style={{ marginTop: 4 }}>
        {t("pl.subtitle")}
      </p>

      <div style={{ marginTop: 16 }}>
        <Card title={t("pl.editor.title")} className="lifted">
          <p className="subtle" style={{ fontSize: 13, marginTop: 0 }}>
            {t("pl.editor.sub")}
          </p>
          <AsyncBlock loading={persona.isLoading} error={persona.error} empty={false}>
            {persona.data?.parseError && (
              <div className="banner err" style={{ marginBottom: 10 }}>
                {t("pl.editor.invalid", { reason: persona.data.parseError })}
              </div>
            )}
            {persona.data?.defaultInEffect && !persona.data.parseError && (
              <div className="banner" style={{ marginBottom: 10 }}>
                {t("pl.editor.empty")}
              </div>
            )}

            <div style={{ display: "grid", gap: 8, gridTemplateColumns: "1fr 1fr 1fr" }}>
              <label style={{ display: "grid", gap: 4 }}>
                <span className="field-label">{t("pl.editor.register")}</span>
                <select
                  className="input"
                  value={fields.register}
                  onChange={(event) => {
                    setDirty(true);
                    setFields({ ...fields, register: event.target.value });
                  }}
                >
                  <option value="">{t("pl.editor.registerNone")}</option>
                  <option value="반말">{t("pl.editor.registerBanmal")}</option>
                  <option value="존댓말">{t("pl.editor.registerJondaemal")}</option>
                </select>
              </label>
              <label style={{ display: "grid", gap: 4 }}>
                <span className="field-label">{t("pl.editor.maxWords")}</span>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={500}
                  value={fields.maxWords}
                  onChange={(event) => {
                    setDirty(true);
                    setFields({ ...fields, maxWords: event.target.value });
                  }}
                />
              </label>
              <label style={{ display: "grid", gap: 4 }}>
                <span className="field-label">{t("pl.editor.language")}</span>
                <input
                  className="input"
                  type="text"
                  placeholder={t("pl.editor.languagePlaceholder")}
                  value={fields.language}
                  onChange={(event) => {
                    setDirty(true);
                    setFields({ ...fields, language: event.target.value });
                  }}
                />
              </label>
            </div>

            <label style={{ display: "grid", gap: 4, marginTop: 10 }}>
              <span className="field-label">{t("pl.editor.body")}</span>
              <textarea
                className="input"
                rows={5}
                placeholder={t("pl.editor.bodyPlaceholder")}
                value={bodyText}
                onChange={(event) => {
                  setDirty(true);
                  setBodyText(event.target.value);
                }}
              />
            </label>

            <div style={{ alignItems: "center", display: "flex", gap: 10, marginTop: 10 }}>
              <Button variant="primary" size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
                {save.isPending ? t("pl.editor.saving") : t("pl.editor.save")}
              </Button>
              {save.isSuccess && !save.data.sanitized && <Badge tone="ok">{t("pl.editor.saved")}</Badge>}
              {save.isSuccess && save.data.sanitized && <Badge tone="warn">{t("pl.editor.sanitized")}</Badge>}
            </div>
            {save.error && <div className="banner err" style={{ marginTop: 8 }}>{(save.error as Error).message}</div>}
          </AsyncBlock>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t("pl.preview.title")}>
          <p className="subtle" style={{ fontSize: 13, marginTop: 0 }}>
            {t("pl.preview.sub")}
          </p>
          <label style={{ display: "grid", gap: 4, marginBottom: 10, maxWidth: 220 }}>
            <span className="field-label">{t("pl.preview.surface")}</span>
            <select
              className="input"
              value={previewSurface}
              onChange={(event) => setPreviewSurface(event.target.value as PreviewSurface)}
            >
              {PREVIEW_SURFACES.map((surface) => (
                <option key={surface} value={surface}>
                  {surface}
                </option>
              ))}
            </select>
          </label>
          <AsyncBlock loading={preview.isLoading} error={preview.error} empty={false}>
            <div style={{ display: "grid", gap: 8 }}>
              {(preview.data?.layers ?? []).map((segment, index) => {
                const labelKey = layerLabelKey(segment.layer);
                return (
                  <div
                    key={`${segment.layer}-${index.toString()}`}
                    className="card"
                    style={{ borderLeft: segment.readOnly ? "3px solid var(--accent)" : "3px solid var(--border)", padding: 10 }}
                  >
                    <div style={{ alignItems: "center", display: "flex", gap: 8, marginBottom: 4 }}>
                      <Badge tone={segment.readOnly ? "accent" : "neutral"}>
                        {labelKey ? t(labelKey) : segment.layer}
                      </Badge>
                      {segment.readOnly && <span className="subtle" style={{ fontSize: 12 }}>🔒 {t("pl.preview.locked")}</span>}
                    </div>
                    <pre className="mono" style={{ fontSize: 12, margin: 0, whiteSpace: "pre-wrap" }}>
                      {segment.text}
                    </pre>
                  </div>
                );
              })}
            </div>
          </AsyncBlock>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t("pl.experiment.title")}>
          <p className="subtle" style={{ fontSize: 13, marginTop: 0 }}>
            {t("pl.experiment.sub")}
          </p>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="field-label">{t("pl.experiment.question")}</span>
            <textarea
              className="input"
              rows={2}
              placeholder={t("pl.experiment.questionPlaceholder")}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
            />
          </label>
          <div style={{ marginTop: 8 }}>
            <Button
              variant="primary"
              size="sm"
              disabled={question.trim().length === 0 || experiment.isPending}
              onClick={() => experiment.mutate()}
            >
              {experiment.isPending ? t("pl.experiment.running") : t("pl.experiment.run")}
            </Button>
          </div>
          {experiment.error && (
            <div className="banner err" style={{ marginTop: 8 }}>
              {(experiment.error as Error).message.includes("503") ? t("pl.experiment.unavailable") : (experiment.error as Error).message}
            </div>
          )}
          {experiment.data && (
            <div className="grid grid-2" style={{ gap: 10, marginTop: 10 }}>
              <Card title={t("pl.experiment.current")}>
                <p style={{ fontSize: 13, margin: 0, whiteSpace: "pre-wrap" }}>{experiment.data.current.answer}</p>
              </Card>
              <Card title={t("pl.experiment.draft")}>
                <p style={{ fontSize: 13, margin: 0, whiteSpace: "pre-wrap" }}>{experiment.data.draft.answer}</p>
              </Card>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
