import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

import { createAgentRuntime, groundToolArguments } from "@muse/agent-core";
import { createContactsAddTool } from "@muse/domain-tools";
import { createFsWriteTools } from "@muse/fs";
import { readPendingApprovals } from "@muse/messaging";
import type { ModelProvider, ModelResponse } from "@muse/model";
import { createToolExposureAuthority } from "@muse/policy";
import type { JsonObject } from "@muse/shared";
import { ToolRegistry } from "@muse/tools";
import { afterEach, describe, expect, it } from "vitest";

import { buildActuatorTools, buildCliPendingApprovalStager, buildContactsApprovalGate, buildEmailApprovalGate, buildFsWriteApprovalGate, buildMessagingApprovalGate, buildWebApprovalGate, formatActuatorBanner, summarizeActuators } from "./actuator-tools.js";
import type { ProgramIO } from "./program.js";

describe("buildMessagingApprovalGate — draft-first, fail-closed in non-TTY", () => {
  const draft = { destination: "@me", providerId: "tg", text: "running late" };

  it("DENIES (fail-closed) in a NON-interactive context — the confirm can't be delivered, so the send must not happen", async () => {
    const gate = buildMessagingApprovalGate({ confirmAction: async () => true, io: { stderr: () => {}, stdout: () => {} }, isInteractive: () => false });
    expect(await gate(draft)).toMatchObject({ approved: false });
  });

  it("APPROVES when interactive AND the user confirms", async () => {
    const gate = buildMessagingApprovalGate({ confirmAction: async () => true, io: { stderr: () => {}, stdout: () => {} }, isInteractive: () => true });
    expect(await gate(draft)).toMatchObject({ approved: true });
  });

  it("DENIES when interactive but the user declines", async () => {
    const gate = buildMessagingApprovalGate({ confirmAction: async () => false, io: { stderr: () => {}, stdout: () => {} }, isInteractive: () => true });
    expect(await gate(draft)).toMatchObject({ approved: false });
  });
});

describe("buildContactsApprovalGate — draft-first, fail-closed in non-TTY", () => {
  const draft = { email: "a@b.test", name: "Ada Lovelace", phone: "+1 555 0100" };

  it("DENIES (fail-closed) in a NON-interactive context — the confirm can't be delivered, so the contact must not be written", async () => {
    const gate = buildContactsApprovalGate({ confirmAction: async () => true, io: { stderr: () => {}, stdout: () => {} }, isInteractive: () => false });
    expect(await gate(draft)).toMatchObject({ approved: false });
  });

  it("APPROVES when interactive AND the user confirms", async () => {
    const gate = buildContactsApprovalGate({ confirmAction: async () => true, io: { stderr: () => {}, stdout: () => {} }, isInteractive: () => true });
    expect(await gate(draft)).toMatchObject({ approved: true });
  });

  it("DENIES when interactive but the user declines", async () => {
    const gate = buildContactsApprovalGate({ confirmAction: async () => false, io: { stderr: () => {}, stdout: () => {} }, isInteractive: () => true });
    expect(await gate(draft)).toMatchObject({ approved: false });
  });
});

function fakeIo(): ProgramIO {
  return { stderr: () => {}, stdout: () => {} };
}

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { HOME: mkdtempSync(join(tmpdir(), "muse-actuators-")), ...overrides };
}

function recordingFetch(): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function sequenceProvider(responses: readonly ModelResponse[]): ModelProvider {
  let index = 0;
  return {
    id: "test",
    async generate(request: { model: string }) {
      const response = responses[Math.min(index, responses.length - 1)]!;
      index += 1;
      return { ...response, model: request.model };
    },
    async listModels() {
      return [];
    },
    async *stream() {
      /* unused */
    }
  } as unknown as ModelProvider;
}

describe("buildActuatorTools — env-driven actuator selection", () => {
  it("exposes only web_action when no provider env is set", () => {
    const tools = buildActuatorTools({ confirmAction: async () => true, env: env(), io: fakeIo(), userId: "stark" });
    expect(tools.map((t) => t.definition.name).sort()).toEqual(["web_action"]);
  });

  it("adds email_send when MUSE_GMAIL_TOKEN is set", () => {
    const tools = buildActuatorTools({
      confirmAction: async () => true,
      env: env({ MUSE_GMAIL_TOKEN: "tok" }),
      io: fakeIo(),
      userId: "stark"
    });
    expect(tools.map((t) => t.definition.name).sort()).toEqual(["email_forward", "email_reply", "email_send", "web_action"]);
  });

  it("drops web_action when MUSE_WEB_EGRESS=false (airplane mode)", () => {
    const tools = buildActuatorTools({ confirmAction: async () => true, env: env({ MUSE_WEB_EGRESS: "false" }), io: fakeIo(), userId: "stark" });
    expect(tools.map((t) => t.definition.name)).not.toContain("web_action");
  });

  it("keeps web_action under local-only (web egress is orthogonal)", () => {
    const tools = buildActuatorTools({ confirmAction: async () => true, env: env({ MUSE_LOCAL_ONLY: "true" }), io: fakeIo(), userId: "stark" });
    expect(tools.map((t) => t.definition.name)).toContain("web_action");
  });

  it("does not read or construct Gmail actuators under injected local-only", () => {
    const localEnv = env({ MUSE_LOCAL_ONLY: "true" });
    Object.defineProperty(localEnv, "MUSE_GMAIL_TOKEN", {
      configurable: true,
      enumerable: true,
      get: () => {
        throw new Error("Gmail token must not be read while local-only");
      }
    });

    const tools = buildActuatorTools({ confirmAction: async () => true, env: localEnv, io: fakeIo(), userId: "stark" });
    const summary = summarizeActuators(localEnv);

    expect(tools.map((tool) => tool.definition.name)).not.toContain("email_send");
    expect(summary.unavailable.find((item) => item.name === "email_send")?.hint).toContain("MUSE_LOCAL_ONLY=true");
  });

  it("adds home_action only when both Home Assistant env vars are set", () => {
    const partial = buildActuatorTools({
      confirmAction: async () => true,
      env: env({ MUSE_HOMEASSISTANT_URL: "http://ha.local:8123" }),
      io: fakeIo(),
      userId: "stark"
    });
    expect(partial.map((t) => t.definition.name)).not.toContain("home_action");

    const full = buildActuatorTools({
      confirmAction: async () => true,
      env: env({ MUSE_HOMEASSISTANT_TOKEN: "ha-tok", MUSE_HOMEASSISTANT_URL: "http://ha.local:8123" }),
      io: fakeIo(),
      userId: "stark"
    });
    expect(full.map((t) => t.definition.name).sort()).toEqual(["home_action", "web_action"]);
  });

  it("does not arm or reflect a remote Home Assistant token under local-only", () => {
    let tokenReads = 0;
    const localEnv = env({ MUSE_HOMEASSISTANT_URL: "http://ha.local:8123", MUSE_LOCAL_ONLY: "true" });
    Object.defineProperty(localEnv, "MUSE_HOMEASSISTANT_TOKEN", {
      configurable: true,
      enumerable: true,
      get: () => {
        tokenReads += 1;
        throw new Error("HA token must not be read while remote local-only is blocked");
      }
    });
    const built = buildActuatorTools({ confirmAction: async () => true, env: localEnv, io: fakeIo(), userId: "stark" });
    const summary = summarizeActuators(localEnv);
    expect(built.map((tool) => tool.definition.name)).not.toContain("home_action");
    expect(summary.armed).not.toContain("home_action");
    expect(summary.unavailable.find((item) => item.name === "home_action")?.hint).toContain("canonical loopback remains available");
    expect(tokenReads).toBe(0);
  });

  it("arms a canonical localhost Home Assistant endpoint under local-only", () => {
    const localEnv = env({
      MUSE_HOMEASSISTANT_TOKEN: "ha-tok",
      MUSE_HOMEASSISTANT_URL: "http://localhost:8123/",
      MUSE_LOCAL_ONLY: "true"
    });
    const built = buildActuatorTools({ confirmAction: async () => true, env: localEnv, io: fakeIo(), userId: "stark" });
    expect(built.map((tool) => tool.definition.name)).toContain("home_action");
    expect(summarizeActuators(localEnv).armed).toContain("home_action");
  });

  it("every actuator tool is execute-risk (gated, local-mode only)", () => {
    const tools = buildActuatorTools({
      confirmAction: async () => true,
      env: env({ MUSE_GMAIL_TOKEN: "tok", MUSE_HOMEASSISTANT_TOKEN: "ha-tok", MUSE_HOMEASSISTANT_URL: "http://ha.local:8123" }),
      io: fakeIo(),
      userId: "stark"
    });
    for (const tool of tools) {
      expect(tool.definition.risk).toBe("execute");
    }
  });
});

describe.sequential("buildActuatorTools — ambient Home Assistant local-only floor", () => {
  const previousLocalOnly = process.env.MUSE_LOCAL_ONLY;

  afterEach(() => {
    if (previousLocalOnly === undefined) delete process.env.MUSE_LOCAL_ONLY;
    else process.env.MUSE_LOCAL_ONLY = previousLocalOnly;
  });

  it("does not let an injected false environment reopen remote Home Assistant", () => {
    process.env.MUSE_LOCAL_ONLY = "true";
    let tokenReads = 0;
    const injectedNormal = env({ MUSE_HOMEASSISTANT_URL: "http://ha.local:8123", MUSE_LOCAL_ONLY: "false" });
    Object.defineProperty(injectedNormal, "MUSE_HOMEASSISTANT_TOKEN", {
      configurable: true,
      get: () => {
        tokenReads += 1;
        throw new Error("HA token must stay unread under ambient strictness");
      }
    });
    expect(buildActuatorTools({ confirmAction: async () => true, env: injectedNormal, io: fakeIo(), userId: "stark" })
      .map((tool) => tool.definition.name)).not.toContain("home_action");
    expect(tokenReads).toBe(0);
  });
});

describe("summarizeActuators — armed-state visibility + config hints", () => {
  it("arms only web_action with no provider env, with hints for the rest", () => {
    const summary = summarizeActuators(env());
    expect(summary.armed).toEqual(["web_action"]);
    expect(summary.unavailable.map((u) => u.name).sort()).toEqual(["email_forward", "email_reply", "email_send", "home_action"]);
    expect(summary.unavailable.find((u) => u.name === "email_send")?.hint).toContain("MUSE_GMAIL_TOKEN");
    expect(summary.unavailable.find((u) => u.name === "home_action")?.hint).toContain("MUSE_HOMEASSISTANT_URL");
  });

  it("arms all three when every provider env is set", () => {
    const summary = summarizeActuators(
      env({ MUSE_GMAIL_TOKEN: "tok", MUSE_HOMEASSISTANT_TOKEN: "ha", MUSE_HOMEASSISTANT_URL: "http://ha.local:8123" })
    );
    expect([...summary.armed].sort()).toEqual(["email_forward", "email_reply", "email_send", "home_action", "web_action"]);
    expect(summary.unavailable).toEqual([]);
  });

  it("requires BOTH Home Assistant vars to arm home_action", () => {
    const summary = summarizeActuators(env({ MUSE_HOMEASSISTANT_URL: "http://ha.local:8123" }));
    expect(summary.armed).not.toContain("home_action");
  });

  it("does not arm web_action when web egress is off, and hints why", () => {
    const summary = summarizeActuators(env({ MUSE_WEB_EGRESS: "off" }));
    expect(summary.armed).not.toContain("web_action");
    expect(summary.unavailable.find((u) => u.name === "web_action")?.hint).toContain("MUSE_WEB_EGRESS");
  });

  it("the armed set always equals the names buildActuatorTools actually constructs (no drift)", () => {
    for (const overrides of [
      {},
      { MUSE_GMAIL_TOKEN: "tok" },
      { MUSE_HOMEASSISTANT_TOKEN: "ha", MUSE_HOMEASSISTANT_URL: "http://ha.local:8123" },
      { MUSE_GMAIL_TOKEN: "tok", MUSE_HOMEASSISTANT_TOKEN: "ha", MUSE_HOMEASSISTANT_URL: "http://ha.local:8123" }
    ]) {
      const e = env(overrides);
      const built = buildActuatorTools({ confirmAction: async () => true, env: e, io: fakeIo(), userId: "stark" })
        .map((t) => t.definition.name)
        .sort();
      expect([...summarizeActuators(e).armed].sort()).toEqual(built);
    }
  });

  it("formats a confirm-safety banner plus one hint line per unavailable actuator", () => {
    const banner = formatActuatorBanner(summarizeActuators(env()));
    expect(banner).toContain("actuators armed: web_action");
    expect(banner).toContain("fires only on your confirm");
    expect(banner).toContain("actuator unavailable: email_send — set MUSE_GMAIL_TOKEN");
    expect(banner.endsWith("\n")).toBe(true);
  });
});

describe("macOS actuators — opt-in via MUSE_MACOS_ACTUATORS", () => {
  it("are DARK by default — no mac_* tool is built or armed without the flag", () => {
    const e = env();
    const built = buildActuatorTools({ confirmAction: async () => true, env: e, io: fakeIo(), userId: "stark" }).map((t) => t.definition.name);
    expect(built.some((n) => n.startsWith("mac_"))).toBe(false);
    expect(summarizeActuators(e).armed.some((n) => n.startsWith("mac_"))).toBe(false);
  });

  it("arm all three when the flag is set, and stay in lockstep (armed == built)", () => {
    const e = env({ MUSE_MACOS_ACTUATORS: "1" });
    const built = buildActuatorTools({ confirmAction: async () => true, env: e, io: fakeIo(), userId: "stark" }).map((t) => t.definition.name);
    expect(built).toEqual(expect.arrayContaining(["mac_shortcut_run", "mac_app_read", "mac_message_send"]));
    expect([...summarizeActuators(e).armed].sort()).toEqual([...built].sort());
  });

  it("classify risk correctly: the read is read-risk, the state-changers are execute-risk", () => {
    const tools = buildActuatorTools({ confirmAction: async () => true, env: env({ MUSE_MACOS_ACTUATORS: "true" }), io: fakeIo(), userId: "stark" });
    const byName = new Map(tools.map((t) => [t.definition.name, t.definition.risk]));
    expect(byName.get("mac_app_read")).toBe("read");
    expect(byName.get("mac_shortcut_run")).toBe("execute");
    expect(byName.get("mac_message_send")).toBe("execute");
  });
});

describe("Windows actuators — opt-in via MUSE_WINDOWS_ACTUATORS", () => {
  it("are DARK by default — no win_* tool is built or armed without the flag", () => {
    const e = env();
    const built = buildActuatorTools({ confirmAction: async () => true, env: e, io: fakeIo(), userId: "stark" }).map((t) => t.definition.name);
    expect(built.some((n) => n.startsWith("win_"))).toBe(false);
    expect(summarizeActuators(e).armed.some((n) => n.startsWith("win_"))).toBe(false);
  });

  it("arm all seven when the flag is set, and stay in lockstep (armed == built)", () => {
    const e = env({ MUSE_WINDOWS_ACTUATORS: "1" });
    const built = buildActuatorTools({ confirmAction: async () => true, env: e, io: fakeIo(), userId: "stark" })
      .map((t) => t.definition.name).filter((n) => n.startsWith("win_"));
    expect(built).toEqual(expect.arrayContaining(["win_app_open", "win_app_read", "win_screenshot", "win_system_set"]));
    expect(built).toHaveLength(7);
    const armed = summarizeActuators(e).armed.filter((n) => n.startsWith("win_"));
    expect([...armed].sort()).toEqual([...built].sort());
  });

  it("classify risk correctly: the read is read-risk, openers are execute, the rest write", () => {
    const tools = buildActuatorTools({ confirmAction: async () => true, env: env({ MUSE_WINDOWS_ACTUATORS: "true" }), io: fakeIo(), userId: "stark" });
    const byName = new Map(tools.map((t) => [t.definition.name, t.definition.risk]));
    expect(byName.get("win_app_read")).toBe("read");
    expect(byName.get("win_app_open")).toBe("execute");
    expect(byName.get("win_clipboard_set")).toBe("write");
    expect(byName.get("win_screenshot")).toBe("write");
  });
});

describe("buildActuatorTools — the agent invokes a wired tool through its clack-confirm gate", () => {
  const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
  function runWebAction(confirmAction: () => Promise<boolean>, fetchImpl: typeof fetch) {
    const tools = buildActuatorTools({
      isInteractive: () => true, confirmAction, env: env(), fetchImpl, io: fakeIo(), lookup: publicLookup, userId: "stark" });
    return createAgentRuntime({
      maxToolCalls: 1,
      modelProvider: sequenceProvider([
        {
          id: "tool",
          model: "m",
          output: "Acting.",
          toolCalls: [{ arguments: { summary: "Book a table", url: "http://example.test/book" }, id: "tc-1", name: "web_action" }]
        },
        { id: "final", model: "m", output: "Done." }
      ]),
      toolApprovalGate: () => ({ allowed: true }),
      toolRegistry: new ToolRegistry([...tools])
    }).run({
      messages: [{ content: "book a table at http://example.test/book", role: "user" }],
      metadata: { localMode: true },
      model: "provider/model",
      toolExposureAuthority: createToolExposureAuthority({ allowedToolNames: ["web_action"], localMode: true })
    });
  }

  it("CONFIRM: the agent run fires the web request once", async () => {
    const { fetchImpl, calls } = recordingFetch();
    await runWebAction(async () => true, fetchImpl);
    expect(calls).toEqual(["http://example.test/book"]);
  });

  it("DENY: the fail-closed clack gate blocks the agent call — no request fires", async () => {
    const { fetchImpl, calls } = recordingFetch();
    await runWebAction(async () => false, fetchImpl);
    expect(calls).toHaveLength(0);
  });
});

describe("add_contact — phone arg-grounding drops a fabricated number (anti-fabrication floor)", () => {
  // The tool's OWN declared groundedArgs fed through the real runtime grounding
  // function (agent-runtime applies exactly this at the tool boundary). A
  // fabricated phone the user never said is the highest-harm contact fabrication
  // — a wrong number means future "text mom" reaches a stranger.
  const groundedArgs = createContactsAddTool({ save: async () => {} }).definition.groundedArgs ?? [];

  it("DROPS a phone the user never stated — using add_contact's declared groundedArgs", () => {
    const out = groundToolArguments(
      { name: "Bob", phone: "+1 555 123 4567", relationship: "dentist" },
      groundedArgs,
      "save Bob, he's my dentist"
    );
    expect(out.dropped).toContain("phone");
    expect(out.args).not.toHaveProperty("phone");
    // a non-grounded arg (name) and a STATED grounded arg (relationship) survive untouched
    expect(out.args).toMatchObject({ name: "Bob", relationship: "dentist" });
  });

  it("KEEPS a phone the user actually stated — grounded across +country/space reformatting", () => {
    const out = groundToolArguments(
      { name: "Bob", phone: "+1 415 555 0101" },
      groundedArgs,
      "save Bob the dentist, his number is 415-555-0101"
    );
    expect(out.args).toMatchObject({ phone: "+1 415 555 0101" });
    expect(out.dropped).not.toContain("phone");
  });
});

describe("web/email/home approval gates — fail-closed in non-TTY (outbound-safety rule 2 parity)", () => {
  const webAction = { request: { method: "POST", url: "https://example.com/x" }, summary: "post a comment" };
  const emailDraft = { body: "hi", recipientName: "Sam", subject: "hello", to: "sam@example.com" };

  it("web gate DENIES when non-interactive even if confirmAction would return true", async () => {
    const gate = buildWebApprovalGate({ confirmAction: async () => true, io: { stderr: () => {}, stdout: () => {} }, isInteractive: () => false, prompt: "Perform this web action?" });
    expect(await gate(webAction)).toMatchObject({ approved: false });
  });

  it("email gate DENIES when non-interactive even if confirmAction would return true", async () => {
    const gate = buildEmailApprovalGate({ confirmAction: async () => true, io: { stderr: () => {}, stdout: () => {} }, isInteractive: () => false });
    expect(await gate(emailDraft)).toMatchObject({ approved: false });
  });

  it("web gate still approves on interactive confirm and denies on decline", async () => {
    const yes = buildWebApprovalGate({ confirmAction: async () => true, io: { stderr: () => {}, stdout: () => {} }, isInteractive: () => true, prompt: "Perform this web action?" });
    expect(await yes(webAction)).toMatchObject({ approved: true });
    const no = buildWebApprovalGate({ confirmAction: async () => false, io: { stderr: () => {}, stdout: () => {} }, isInteractive: () => true, prompt: "Perform this web action?" });
    expect(await no(webAction)).toMatchObject({ approved: false });
  });
});

describe("fs-write approval gate — non-interactive staging (no-external-effect contract)", () => {
  function fsWorkDir(): string {
    return mkdtempSync(join(tmpdir(), "muse-fs-write-"));
  }

  function pendingFile(dir: string): string {
    return join(dir, "pending-approvals.json");
  }

  it("STAGES a non-interactive file_write and writes NOTHING to disk — end-to-end through the real fs-write tool", async () => {
    const dir = fsWorkDir();
    // A macOS temp dir resolves through a /private symlink — `resolveSafePath`
    // canonicalizes it, so the recorded path must be compared post-realpath too.
    const target = join(realpathSync(dir), "notes.md");
    const pending = pendingFile(dir);
    const [fsWriteTool] = createFsWriteTools({
      approvalGate: buildFsWriteApprovalGate({
        confirmAction: async () => true,
        io: { stderr: () => {}, stdout: () => {} },
        isInteractive: () => false,
        stagePendingApproval: buildCliPendingApprovalStager({ file: pending })
      }),
      roots: [dir]
    });

    const result = (await fsWriteTool!.execute({ content: "hello", path: target }, { runId: "t1" })) as JsonObject;

    expect(result["written"]).toBe(false);
    expect(existsSync(target)).toBe(false);

    const entries = await readPendingApprovals(pending);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ risk: "write", tool: "file_write" });
    const staged = entries[0]!.arguments as { action?: string; path?: string };
    expect(staged.action).toBe("write");
    // Canonical form differs across win32 8.3/long names — the leaf is the contract.
    expect(basename(staged.path ?? "")).toBe("notes.md");
    expect(entries[0]!.draft.length).toBeGreaterThan(0);
  });

  it("back-compat: no stagePendingApproval + non-interactive → plain deny, nothing recorded anywhere", async () => {
    const dir = fsWorkDir();
    const target = join(dir, "notes.md");
    const pending = pendingFile(dir);
    const [fsWriteTool] = createFsWriteTools({
      approvalGate: buildFsWriteApprovalGate({
        confirmAction: async () => true,
        io: { stderr: () => {}, stdout: () => {} },
        isInteractive: () => false
      }),
      roots: [dir]
    });

    const result = (await fsWriteTool!.execute({ content: "hello", path: target }, { runId: "t2" })) as JsonObject;

    expect(result["written"]).toBe(false);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(pending)).toBe(false);
  });

  it("a throwing stagePendingApproval is fail-safe — the gate still denies, and nothing is written", async () => {
    const dir = fsWorkDir();
    const target = join(dir, "notes.md");
    const gate = buildFsWriteApprovalGate({
      confirmAction: async () => true,
      io: { stderr: () => {}, stdout: () => {} },
      isInteractive: () => false,
      stagePendingApproval: async () => {
        throw new Error("disk full");
      }
    });

    const decision = await gate({ action: "write", path: target, preview: "hello", summary: "Create notes.md" });
    expect(decision.approved).toBe(false);

    const [fsWriteTool] = createFsWriteTools({ approvalGate: gate, roots: [dir] });
    const result = (await fsWriteTool!.execute({ content: "hello", path: target }, { runId: "t3" })) as JsonObject;
    expect(result["written"]).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  it("interactive + confirm still approves (unchanged) — no staging on the approved path", async () => {
    const dir = fsWorkDir();
    const pending = pendingFile(dir);
    let staged = false;
    const gate = buildFsWriteApprovalGate({
      confirmAction: async () => true,
      io: { stderr: () => {}, stdout: () => {} },
      isInteractive: () => true,
      stagePendingApproval: async () => {
        staged = true;
      }
    });

    const decision = await gate({ action: "write", path: join(dir, "notes.md"), preview: "hello", summary: "Create notes.md" });
    expect(decision.approved).toBe(true);
    expect(staged).toBe(false);
    expect(existsSync(pending)).toBe(false);
  });
});
