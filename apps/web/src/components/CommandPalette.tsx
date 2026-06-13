import { useEffect, useMemo, useRef, useState } from "react";

import { useI18n } from "../i18n/index.js";

export interface Command {
  readonly id: string;
  readonly title: string;
  readonly group: string;
  readonly hint?: string;
  readonly run: () => void;
}

export const COMMAND_LIST_ID = "command-palette-listbox";

export function commandOptionId(commandId: string): string {
  return `command-palette-option-${commandId}`;
}

export function CommandPalette({
  open,
  commands,
  onClose
}: {
  open: boolean;
  commands: readonly Command[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return commands;
    }
    return commands.filter((c) => c.title.toLowerCase().includes(q) || c.group.toLowerCase().includes(q));
  }, [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
      // Focus after the element mounts.
      const id = window.setTimeout(() => inputRef.current?.focus(), 10);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [open]);

  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  if (!open) {
    return null;
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = filtered[index];
      if (cmd) {
        cmd.run();
        onClose();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const activeOption = filtered[index];
  return (
    <div className="palette-backdrop" onClick={onClose} role="presentation">
      <div className="palette" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <input
          ref={inputRef}
          className="palette-input"
          placeholder={t("cmd.placeholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={true}
          aria-controls={COMMAND_LIST_ID}
          aria-autocomplete="list"
          aria-activedescendant={activeOption ? commandOptionId(activeOption.id) : undefined}
        />
        <div className="palette-list" id={COMMAND_LIST_ID} role="listbox">
          {filtered.length === 0 && <div className="palette-empty">{t("cmd.empty")}</div>}
          {filtered.map((cmd, i) => (
            <button
              key={cmd.id}
              id={commandOptionId(cmd.id)}
              role="option"
              aria-selected={i === index}
              className={`palette-item${i === index ? " active" : ""}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => {
                cmd.run();
                onClose();
              }}
            >
              <span className="palette-group">{cmd.group}</span>
              <span className="palette-title">{cmd.title}</span>
              {cmd.hint && <span className="palette-hint">{cmd.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
