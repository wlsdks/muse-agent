/**
 * `mac_observe` is the tool that answers "what is on my screen", so its most
 * important property is not the happy path — it is that a source it COULD NOT
 * read is never presented as a source that was empty. "You have no windows
 * open" and "I could not read your windows" are different sentences, and only
 * one of them is honest when Accessibility is denied.
 */

import { describe, expect, it } from "vitest";

import { createMacObserveTool, MAC_OBSERVE_SOURCES } from "./macos-observe-tool.js";
import type { MacCommandResult } from "./macos-exec.js";

const ctx = { runId: "r", userId: "u" };
const ok = (stdout: string): MacCommandResult => ({ exitCode: 0, stderr: "", stdout, timedOut: false });

/** A helper stub keyed by subcommand, so a test can make one source fail. */
function helper(responses: Record<string, string>) {
  const calls: string[] = [];
  const run = async (_bin: string, argv: readonly string[]): Promise<MacCommandResult> => {
    const sub = argv[0] ?? "";
    calls.push(sub);
    return ok(responses[sub] ?? '{"ok":true}');
  };
  return { calls, deps: { binaryPath: "/x/muse-mac-helper", run } };
}

describe("mac_observe — schema", () => {
  it("is a read tool that requires `include`", () => {
    const definition = createMacObserveTool().definition;
    expect(definition.name).toBe("mac_observe");
    expect(definition.risk).toBe("read");
    const schema = definition.inputSchema as { required: string[]; properties: { include: { items: { enum: string[] } } } };
    expect(schema.required).toEqual(["include"]);
    expect(schema.properties.include.items.enum).toEqual([...MAC_OBSERVE_SOURCES]);
  });

  it("says when NOT to use it, so it does not steal mac_app_read / mac_screen_read calls", () => {
    // tool-calling.md: confusable descriptions are the top wrong-selection
    // cause, and this tool's keywords deliberately overlap with the screen
    // tools. The negative clause is what keeps them apart.
    const description = createMacObserveTool().definition.description;
    expect(description).toMatch(/NOT to read the CONTENTS/iu);
    expect(description).toContain("mac_app_read");
    expect(description).toContain("mac_screen_read");
    // The running-app list belongs to mac_app_read, which the golden eval set
    // already routes "what apps are open" to. Without this clause the two tools
    // compete for the same request.
    expect(description).toMatch(/NOT use it for the plain list of running apps/iu);
  });

  it("keeps running-app keywords out, so it is not even SHOWN against mac_app_read", () => {
    // Keywords drive the relevance filter that picks the ~6 tools the model
    // sees. Overlapping here regresses selection before the description is
    // ever read.
    const keywords = createMacObserveTool().definition.keywords ?? [];
    for (const stolen of ["apps", "앱", "running", "실행", "open", "열려"]) {
      expect(keywords, `"${stolen}" belongs to mac_app_read`).not.toContain(stolen);
    }
    expect(keywords).toContain("창");
    expect(keywords).toContain("배치");
  });

  it("rejects an unknown source by naming the valid ones", async () => {
    const tool = createMacObserveTool(helper({}).deps);
    const out = await tool.execute({ include: ["windows", "brainwaves"] }, ctx) as { error?: string };
    expect(out.error).toContain("brainwaves");
    expect(out.error).toContain("windows, focus, apps, permissions");
  });

  it("rejects an empty or non-list include", async () => {
    const tool = createMacObserveTool(helper({}).deps);
    for (const include of [[], undefined, 42, [7]]) {
      const out = await tool.execute({ include } as never, ctx) as { error?: string };
      expect(out.error, `include=${JSON.stringify(include)}`).toContain("at least one");
    }
  });

  it("accepts a bare string, because a small model often produces the scalar form", async () => {
    const { calls, deps } = helper({ focus: '{"app":"Safari","ok":true}' });
    const out = await createMacObserveTool(deps).execute({ include: "focus" } as never, ctx) as Record<string, unknown>;
    expect(calls).toEqual(["focus"]);
    expect(out.focus).toMatchObject({ app: "Safari" });
  });
});

describe("mac_observe — one call, several sources", () => {
  it("reads every requested source in a single tool call", async () => {
    const { calls, deps } = helper({
      apps: '{"apps":[{"name":"Safari"}],"ok":true}',
      focus: '{"app":"Safari","ok":true,"windowTitle":"Muse"}',
      windows: '{"ok":true,"windows":[{"app":"Safari","focused":true,"width":1200}]}'
    });
    const out = await createMacObserveTool(deps).execute({ include: ["focus", "windows", "apps"] }, ctx) as Record<string, unknown>;

    expect(calls).toEqual(["focus", "windows", "apps"]);
    expect(out.focus).toMatchObject({ app: "Safari", windowTitle: "Muse" });
    expect(out.windows).toMatchObject({ windows: [{ app: "Safari", width: 1200 }] });
    expect(out.apps).toBeDefined();
    expect(out.unavailable).toBeUndefined();
  });

  it("de-duplicates repeated sources so asking twice costs one read", async () => {
    const { calls, deps } = helper({ focus: '{"app":"Safari","ok":true}' });
    await createMacObserveTool(deps).execute({ include: ["focus", "focus", "focus"] }, ctx);
    expect(calls).toEqual(["focus"]);
  });

  it("strips the transport-level `ok` flag from each payload", async () => {
    // `ok` is the helper's envelope, not state the model should reason about.
    const { deps } = helper({ focus: '{"app":"Safari","ok":true}' });
    const out = await createMacObserveTool(deps).execute({ include: ["focus"] }, ctx) as Record<string, Record<string, unknown>>;
    expect(out.focus).not.toHaveProperty("ok");
    expect(out.focus).toHaveProperty("app");
  });
});

describe("mac_observe — a source it could not read is never reported as empty", () => {
  it("keeps the sources that worked and names the one that did not", async () => {
    const { deps } = helper({
      focus: '{"app":"Safari","ok":true}',
      windows: '{"code":"ax_permission_denied","message":"grant Accessibility","ok":false}'
    });
    const out = await createMacObserveTool(deps).execute({ include: ["focus", "windows"] }, ctx) as Record<string, unknown>;

    expect(out.focus).toMatchObject({ app: "Safari" });
    // The critical assertion: `windows` is absent from the answer AND present
    // in `unavailable` with a reason. If it were simply missing, the model
    // would be free to say the screen is empty.
    expect(out.windows).toBeUndefined();
    expect(out.unavailable).toMatchObject({ windows: { code: "ax_permission_denied" } });
  });

  it("errors with the underlying reason when NOTHING could be read", async () => {
    const { deps } = helper({
      focus: '{"code":"helper_unavailable","message":"not installed","ok":false}',
      windows: '{"code":"helper_unavailable","message":"not installed","ok":false}'
    });
    const out = await createMacObserveTool(deps).execute({ include: ["focus", "windows"] }, ctx) as Record<string, unknown>;
    expect(out.error).toContain("not installed");
    expect(out.code).toBe("helper_unavailable");
    expect(out.unavailable).toBeDefined();
  });

  it("degrades cleanly with no helper installed at all", async () => {
    const out = await createMacObserveTool().execute({ include: ["windows"] }, ctx) as Record<string, unknown>;
    expect(out.error).toContain("not installed");
    expect(out.code).toBe("helper_unavailable");
  });
});
