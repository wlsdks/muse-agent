import { useEffect, useState } from "react";

import { Icon } from "../components/ui.js";
import { useI18n } from "../i18n/index.js";
import { formatMetaValue } from "./flow-nodes.js";

import type { FlowProjection } from "../api/types.js";

/** The n8n-style flow switcher: the editor focuses on ONE flow; switching,
 * filtering, and creating live in the flow-name dropdown in the workspace
 * header. The menu stays in the DOM (visibility via the `open` class) so
 * its rows are SSR-testable and the open/close animates. */
export function FlowSwitcher({
  flows,
  selectedId,
  onSelect,
  onCreate
}: {
  flows: readonly FlowProjection[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const selected = flows.find((flow) => flow.id === selectedId);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onDocClick = (event: MouseEvent) => {
      if (!(event.target as HTMLElement | null)?.closest(".flowpick")) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const visible = flows.filter((flow) => flow.name.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <div className={`flowpick${open ? " open" : ""}`}>
      <button
        type="button"
        className="flowpick-btn"
        aria-expanded={open}
        aria-label={t("auto.flows.switcher.label")}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="flowpick-crumb">{t("nav.flows")} ▸</span>
        <span className="flowpick-name">{selected ? selected.name : t("auto.flows.emptyTitle")}</span>
        {selected && <span className={`dot${selected.enabled ? " on" : ""}`} />}
        <span className="flowpick-caret">▾</span>
      </button>
      <div className="flowpick-menu" role="listbox" aria-label={t("auto.flows.listTitle")}>
        <input
          className="input"
          placeholder={t("auto.flows.switcher.filter")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="flowpick-rows">
          {visible.map((flow) => (
            <button
              type="button"
              key={flow.id}
              className={`flowpick-row${flow.id === selectedId ? " active" : ""}`}
              onClick={() => {
                onSelect(flow.id);
                setOpen(false);
              }}
            >
              <span className={`dot${flow.enabled ? " on" : ""}`} />
              <span className="flowpick-row-name">{flow.name}</span>
              <span className="flowpick-row-meta">
                {!flow.enabled
                  ? t("auto.flows.paused")
                  : flow.nextRunAtIso
                    ? formatMetaValue("nextRunAtIso", flow.nextRunAtIso, locale)
                    : ""}
              </span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="flowpick-new"
          onClick={() => {
            onCreate();
            setOpen(false);
          }}
        >
          <Icon.plus className="nav-icon" /> {t("auto.flows.create.button")}
        </button>
      </div>
    </div>
  );
}
