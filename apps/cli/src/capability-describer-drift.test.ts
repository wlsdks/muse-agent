import { describeCapabilitiesEn, describeCapabilitiesKo } from "@muse/prompts";
import { describe, expect, it } from "vitest";

import { COMMAND_STUBS } from "./command-manifest.js";

// The shared describer (in @muse/prompts) can't import COMMAND_STUBS (that lives
// here in the CLI), so this drift test enforces the "sourced from COMMAND_STUBS"
// contract from the CLI side: every `muse <cmd>` the describer names must be a
// REAL top-level command. If a command is renamed/removed, this goes RED — the
// describer can never quietly advertise a command that no longer exists.
const COMMAND_TOKEN_RE = /`muse ([a-z-]+)/gu;

function referencedCommands(text: string): Set<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(COMMAND_TOKEN_RE)) {
    if (match[1]) {
      names.add(match[1]);
    }
  }
  return names;
}

describe("capability describer stays drift-locked to real commands", () => {
  const known = new Set(COMMAND_STUBS.map((stub) => stub.name));

  it("every command the KO describer names is a real command", () => {
    const referenced = referencedCommands(describeCapabilitiesKo({}));
    expect(referenced.size).toBeGreaterThan(0);
    for (const name of referenced) {
      expect(known, `describer references \`muse ${name}\` which is not a real command`).toContain(name);
    }
  });

  it("every command the EN describer names is a real command", () => {
    const referenced = referencedCommands(describeCapabilitiesEn({}));
    expect(referenced.size).toBeGreaterThan(0);
    for (const name of referenced) {
      expect(known, `describer references \`muse ${name}\` which is not a real command`).toContain(name);
    }
  });
});
