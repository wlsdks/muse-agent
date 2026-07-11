import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { AsyncBlock, Badge, Button, Card } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";
import { groupJourneyEventsByDay } from "./journey-days.js";

import type { ApiClient } from "../api/client.js";
import type { JourneyEventView, JourneyResponse } from "../api/types.js";

type JourneyFilter = "all" | "fact" | "skill" | "strategy";

const FILTERS: readonly JourneyFilter[] = ["all", "fact", "skill", "strategy"];

function badgeTone(storeKind: JourneyEventView["storeKind"]): "accent" | "ok" | "warn" {
  switch (storeKind) {
    case "fact":
      return "accent";
    case "skill":
      return "ok";
    case "strategy":
      return "warn";
  }
}

/**
 * One reverse-chronological "what Muse learned about you" timeline — the
 * web counterpart to `muse journey`. Read-only (this is local self-
 * knowledge, not an outbound action): removal stays on the CLI
 * (`muse journey forget <ref>`), which routes each store to its OWN safe
 * removal path rather than a second deletion implementation here.
 */
export function JourneyView({ client }: { client: ApiClient }) {
  const { locale, t } = useI18n();
  const [filter, setFilter] = useState<JourneyFilter>("all");

  const journey = useQuery({
    queryFn: () => client.get<JourneyResponse>(`/api/journey${filter === "all" ? "" : `?kind=${filter}`}`),
    queryKey: ["journey", client.baseUrl, filter]
  });

  const events = journey.data?.events ?? [];
  const groups = groupJourneyEventsByDay(events);

  return (
    <div className="content-narrow">
      <p className="eyebrow">{t("group.knowledge")}</p>
      <h1 className="page-title">{t("journey.title")}</h1>
      <p className="muted" style={{ marginTop: 4 }}>
        {t("journey.subtitle", { n: journey.data?.total ?? 0 })}
      </p>

      <Card
        action={
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            {FILTERS.map((f) => (
              <Button key={f} variant={filter === f ? "secondary" : "ghost"} size="sm" onClick={() => setFilter(f)}>
                {t(`journey.filter${f === "all" ? "All" : f === "fact" ? "Fact" : f === "skill" ? "Skill" : "Strategy"}`)}
              </Button>
            ))}
          </div>
        }
      >
        <AsyncBlock loading={journey.isLoading} error={journey.error} empty={events.length === 0} emptyLabel={t("journey.empty")}>
          {groups.map((group) => (
            <div key={group.day} style={{ marginBottom: 16 }}>
              <div className="row-meta mono" style={{ marginBottom: 6 }}>
                {new Date(group.day).toLocaleDateString(locale)}
              </div>
              {group.events.map((event, idx) => (
                <div className="row" key={`${event.ref ?? "no-ref"}:${event.eventKind}:${idx}`}>
                  <div className="row-main">
                    <div className="row-title">{event.content}</div>
                    <div className="row-meta">
                      <Badge tone={badgeTone(event.storeKind)}>{event.storeKind}</Badge> {event.eventKind}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </AsyncBlock>
      </Card>

      <p className="muted" style={{ marginTop: 16, fontSize: 12 }}>
        {t("journey.footer")}
      </p>
    </div>
  );
}
