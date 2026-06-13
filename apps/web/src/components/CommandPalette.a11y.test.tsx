import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CommandPalette, COMMAND_LIST_ID, commandOptionId, type Command } from "./CommandPalette.js";
import { I18nProvider } from "../i18n/index.js";

const noop = () => {};

function cmd(id: string, title: string, group = "Nav"): Command {
  return { id, title, group, run: noop };
}

function render(commands: readonly Command[]): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <CommandPalette open commands={commands} onClose={noop} />
    </I18nProvider>
  );
}

describe("CommandPalette — WAI-ARIA combobox pattern", () => {
  const commands = [cmd("today", "Go to Today"), cmd("tasks", "Go to Tasks"), cmd("notes", "Open Notes")];

  it("the input is a combobox controlling the listbox", () => {
    const html = render(commands);
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain(`aria-controls="${COMMAND_LIST_ID}"`);
  });

  it("the list is a listbox and each command is an option with a unique id", () => {
    const html = render(commands);
    expect(html).toContain(`role="listbox"`);
    expect(html).toContain(`id="${COMMAND_LIST_ID}"`);
    expect((html.match(/role="option"/g) ?? []).length).toBe(commands.length);
    for (const c of commands) {
      expect(html).toContain(`id="${commandOptionId(c.id)}"`);
    }
  });

  it("exactly the first option is selected and the combobox points at it via aria-activedescendant", () => {
    const html = render(commands);
    expect((html.match(/aria-selected="true"/g) ?? []).length).toBe(1);
    expect((html.match(/aria-selected="false"/g) ?? []).length).toBe(commands.length - 1);
    expect(html).toContain(`aria-activedescendant="${commandOptionId(commands[0]!.id)}"`);
  });

  it("with no commands there is no active descendant (empty listbox, nothing selected)", () => {
    const html = render([]);
    expect(html).toContain('role="listbox"');
    expect(html).not.toContain("aria-selected");
    expect(html).not.toContain("aria-activedescendant=");
  });
});
