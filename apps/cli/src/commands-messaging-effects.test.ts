import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  prepareOutboundEffect,
  readOutboundEffect,
  reconcileOutboundEffect,
  recordOutboundEffectAccepted,
  recordOutboundEffectUnknown
} from "@muse/messaging";
import { Command } from "commander";
import { describe, expect, it } from "vitest";

import {
  registerMessagingCommands,
  type MessagingCommandHelpers,
  type MessagingSendDeps
} from "./commands-messaging.js";
import type { ProgramIO } from "./program.js";

const CREATED_AT = "2026-07-26T00:00:00.000Z";

function fixture(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-messaging-effects-")), "outbound-effects.json");
}

async function seedUnknown(
  effectFile: string,
  effectId = "effect-unknown-1",
  over: { readonly destination?: string; readonly providerId?: string; readonly detail?: string } = {}
): Promise<void> {
  await prepareOutboundEffect(effectFile, {
    createdAt: CREATED_AT,
    destination: over.destination ?? "destination-1",
    effectId,
    payloadHash: "a".repeat(64),
    providerId: over.providerId ?? "email"
  });
  await recordOutboundEffectUnknown(
    effectFile,
    effectId,
    over.detail ?? "provider acceptance could not be proven",
    CREATED_AT
  );
}

async function seedAccepted(effectFile: string, effectId = "effect-accepted-1"): Promise<void> {
  await prepareOutboundEffect(effectFile, {
    createdAt: CREATED_AT,
    destination: "destination-accepted",
    effectId,
    payloadHash: "b".repeat(64),
    providerId: "email"
  });
  await recordOutboundEffectAccepted(effectFile, effectId, {
    destination: "destination-accepted",
    messageId: "provider-accepted-1",
    providerId: "email",
    receivedAt: CREATED_AT
  }, CREATED_AT);
}

function digest(file: string): string | undefined {
  return existsSync(file)
    ? createHash("sha256").update(readFileSync(file)).digest("hex")
    : undefined;
}

function harness(deps: MessagingSendDeps) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = {
    stderr: (message: string) => stderr.push(message),
    stdout: (message: string) => stdout.push(message)
  } as ProgramIO;
  const helpers: MessagingCommandHelpers = {
    apiRequest: async () => {
      throw new Error("effect commands must never call the API or a provider registry");
    },
    writeOutput: (_output, value) => stdout.push(JSON.stringify(value))
  };
  const program = new Command();
  program.exitOverride();
  registerMessagingCommands(program, io, helpers, deps);
  return { program, stderr, stdout };
}

async function run(effectFile: string, args: readonly string[]) {
  return runWithDeps({ effectFile }, args);
}

async function runWithDeps(deps: MessagingSendDeps, args: readonly string[]) {
  const { program, stderr, stdout } = harness(deps);
  const priorExit = process.exitCode;
  process.exitCode = 0;
  try {
    await program.parseAsync(["node", "muse", "messaging", "effects", ...args]);
  } catch {
    // Commander validation errors are also fail-closed command outcomes.
  }
  const exitCode = process.exitCode === 0 ? undefined : process.exitCode;
  process.exitCode = priorExit;
  return { exitCode, stderr: stderr.join(""), stdout: stdout.join("") };
}

describe("muse messaging effects read-only and preview commands", () => {
  it("list, show, and reconcile preview leave the ledger byte-identical and expose no raw payload", async () => {
    const effectFile = fixture();
    await seedUnknown(effectFile);
    const before = digest(effectFile);

    const list = await run(effectFile, ["list"]);
    const show = await run(effectFile, ["show", "effect-unknown-1"]);
    const preview = await run(effectFile, [
      "reconcile", "effect-unknown-1",
      "--decision", "not-delivered",
      "--actor", "owner",
      "--reason", "provider history  shows no delivery"
    ]);

    expect(list.exitCode).toBeUndefined();
    expect(show.exitCode).toBeUndefined();
    expect(preview.exitCode).toBeUndefined();
    expect(preview.stdout).toContain("\"status\":\"preview\"");
    const shown = JSON.parse(show.stdout) as Record<string, unknown>;
    expect(Object.keys(shown).sort()).toEqual(["binding", "state", "unknownDetail"]);
    const planned = JSON.parse(preview.stdout) as {
      readonly transition: { readonly reason: string };
    };
    expect(planned.transition.reason).toBe("provider history  shows no delivery");
    expect(`${list.stdout}${show.stdout}${preview.stdout}`).not.toContain("raw message body");
    expect(digest(effectFile)).toBe(before);
  });

  it("bounds list output and rejects an invalid limit without mutation", async () => {
    const effectFile = fixture();
    await seedUnknown(effectFile);
    const before = digest(effectFile);
    const invalid = await run(effectFile, ["list", "--limit", "101"]);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr).toContain("limit must be an integer");
    expect(digest(effectFile)).toBe(before);
  });

  it("resolves the canonical effect ledger beside the configured action log", async () => {
    const effectFile = fixture();
    await seedUnknown(effectFile, "effect-canonical-sibling");
    const before = digest(effectFile);
    const result = await runWithDeps(
      { actionLogFile: join(dirname(effectFile), "actions.json") },
      ["show", "effect-canonical-sibling"]
    );
    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain("\"effectId\":\"effect-canonical-sibling\"");
    expect(digest(effectFile)).toBe(before);
  });

  it("sanitizes terminal controls from stored fields and unknown detail", async () => {
    const effectFile = fixture();
    await seedUnknown(effectFile, "effect-terminal", {
      destination: "dest\u001b[31mred",
      detail: "unknown\u0085detail",
      providerId: "email\u0007"
    });
    const shown = await run(effectFile, ["show", "effect-terminal"]);
    expect(shown.exitCode).toBeUndefined();
    expect(shown.stdout).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);
    expect(shown.stdout).toContain("dest[31mred");
  });
});

describe("muse messaging effects reconcile apply", () => {
  it("applies accepted using the binding route and exact receipt metadata", async () => {
    const effectFile = fixture();
    await seedUnknown(effectFile, "effect-accept");
    const result = await run(effectFile, [
      "reconcile", "effect-accept",
      "--decision", "accepted",
      "--actor", "owner",
      "--reason", "verified in provider sent history",
      "--message-id", "provider-message-9",
      "--received-at", CREATED_AT,
      "--apply"
    ]);
    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain("\"status\":\"applying\"");
    expect(result.stdout).toContain("\"status\":\"applied\"");
    expect(await readOutboundEffect(effectFile, "effect-accept")).toMatchObject({
      receipt: {
        destination: "destination-1",
        messageId: "provider-message-9",
        providerId: "email",
        receivedAt: CREATED_AT
      },
      state: "reconciled-accepted"
    });
  });

  it("applies not-delivered without receipt metadata", async () => {
    const effectFile = fixture();
    await seedUnknown(effectFile, "effect-not-delivered");
    const result = await run(effectFile, [
      "reconcile", "effect-not-delivered",
      "--decision", "not-delivered",
      "--actor", "owner",
      "--reason", "provider search found no message",
      "--apply"
    ]);
    expect(result.exitCode).toBeUndefined();
    expect(await readOutboundEffect(effectFile, "effect-not-delivered")).toMatchObject({
      state: "reconciled-not-delivered"
    });
    expect((await readOutboundEffect(effectFile, "effect-not-delivered"))?.receipt).toBeUndefined();
  });

  it.each([
    [
      "accepted missing receipt",
      ["--decision", "accepted", "--actor", "owner", "--reason", "checked"]
    ],
    [
      "not-delivered with receipt flags",
      [
        "--decision", "not-delivered", "--actor", "owner", "--reason", "checked",
        "--message-id", "m1", "--received-at", CREATED_AT
      ]
    ],
    [
      "invalid decision",
      ["--decision", "maybe", "--actor", "owner", "--reason", "checked"]
    ],
    [
      "noncanonical timestamp",
      [
        "--decision", "accepted", "--actor", "owner", "--reason", "checked",
        "--message-id", "m1", "--received-at", "2026-07-26"
      ]
    ]
  ] as const)("%s fails closed without mutation", async (_name, optionArgs) => {
    const effectFile = fixture();
    await seedUnknown(effectFile, "effect-invalid");
    const before = digest(effectFile);
    const result = await run(effectFile, [
      "reconcile", "effect-invalid", ...optionArgs, "--apply"
    ]);
    expect(result.exitCode).toBe(1);
    expect(digest(effectFile)).toBe(before);
    expect((await readOutboundEffect(effectFile, "effect-invalid"))?.state).toBe("unknown");
  });

  it("rejects terminal and replayed effects without changing bytes", async () => {
    const effectFile = fixture();
    await seedAccepted(effectFile);
    const beforeAccepted = digest(effectFile);
    const accepted = await run(effectFile, [
      "reconcile", "effect-accepted-1",
      "--decision", "not-delivered",
      "--actor", "owner",
      "--reason", "stale operator view",
      "--apply"
    ]);
    expect(accepted.exitCode).toBe(1);
    expect(digest(effectFile)).toBe(beforeAccepted);

    await seedUnknown(effectFile, "effect-replay");
    await reconcileOutboundEffect(effectFile, {
      actor: "other-process",
      decision: "not-delivered",
      effectId: "effect-replay",
      reason: "won the race",
      recordedAt: new Date().toISOString()
    });
    const beforeReplay = digest(effectFile);
    const replay = await run(effectFile, [
      "reconcile", "effect-replay",
      "--decision", "accepted",
      "--actor", "owner",
      "--reason", "stale retry",
      "--message-id", "late-message",
      "--received-at", CREATED_AT,
      "--apply"
    ]);
    expect(replay.exitCode).toBe(1);
    expect(digest(effectFile)).toBe(beforeReplay);
  });
});

describe("muse messaging effects strict store failures", () => {
  it("fails closed on corrupt ledger bytes", async () => {
    const effectFile = fixture();
    writeFileSync(effectFile, "{not-json", { mode: 0o600 });
    const before = digest(effectFile);
    const result = await run(effectFile, ["list"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("ledger is corrupt");
    expect(digest(effectFile)).toBe(before);
  });

  it.skipIf(process.platform === "win32")("fails closed on loose ledger permissions", async () => {
    const effectFile = fixture();
    await seedUnknown(effectFile);
    chmodSync(effectFile, 0o644);
    const before = digest(effectFile);
    const result = await run(effectFile, ["show", "effect-unknown-1"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("permissions are not private");
    expect(digest(effectFile)).toBe(before);
  });
});
