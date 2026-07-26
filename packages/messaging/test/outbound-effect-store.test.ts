import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import {
  computeOutboundEffectPayloadHash,
  OutboundEffectStoreError,
  prepareOutboundEffect,
  readOutboundEffect,
  readOutboundEffects,
  reconcileOutboundEffect,
  recordOutboundEffectAccepted,
  recordOutboundEffectUnknown,
  type OutboundEffectBinding,
  type OutboundEffectReceipt
} from "../src/outbound-effect-store.js";

const CREATED_AT = "2026-07-26T12:00:00.000Z";
const RECORDED_AT = "2026-07-26T12:01:00.000Z";

let file: string;

beforeEach(async () => {
  file = join(await mkdtemp(join(tmpdir(), "muse-outbound-effects-")), "effects.json");
});

function binding(effectId = "effect-1", overrides: Partial<OutboundEffectBinding> = {}): OutboundEffectBinding {
  const providerId = overrides.providerId ?? "slack";
  const destination = overrides.destination ?? "C123";
  return {
    createdAt: CREATED_AT,
    destination,
    effectId,
    payloadHash: computeOutboundEffectPayloadHash({ destination, providerId, text: "hello" }),
    providerId,
    ...overrides
  };
}

function receipt(overrides: Partial<OutboundEffectReceipt> = {}): OutboundEffectReceipt {
  return {
    destination: "C123",
    messageId: "m-1",
    providerId: "slack",
    receivedAt: RECORDED_AT,
    ...overrides
  };
}

describe("outbound effect ledger", () => {
  it("persists a stable prepared effect, replays without appending, and survives restart reads", async () => {
    const expected = { binding: binding(), state: "prepared" };
    expect(await prepareOutboundEffect(file, binding())).toEqual(expected);
    const firstBytes = await readFile(file, "utf8");

    expect(await prepareOutboundEffect(file, binding())).toEqual(expected);
    expect(await readFile(file, "utf8")).toBe(firstBytes);
    expect(await readOutboundEffect(file, "effect-1")).toEqual(expected);
    expect(await readOutboundEffects(file)).toEqual([expected]);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("rejects effect-id binding drift with zero ledger mutation", async () => {
    await prepareOutboundEffect(file, binding());
    const before = await readFile(file, "utf8");

    await expect(prepareOutboundEffect(file, binding("effect-1", {
      destination: "C999",
      payloadHash: computeOutboundEffectPayloadHash({
        destination: "C999",
        providerId: "slack",
        text: "hello"
      })
    }))).rejects.toThrow(/different payload/iu);
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("records an immutable accepted provider receipt and blocks later ambiguity", async () => {
    await prepareOutboundEffect(file, binding());
    const accepted = await recordOutboundEffectAccepted(file, "effect-1", receipt(), RECORDED_AT);
    expect(accepted).toEqual({ binding: binding(), receipt: receipt(), state: "accepted" });
    const acceptedBytes = await readFile(file, "utf8");

    expect(await recordOutboundEffectAccepted(file, "effect-1", receipt(), RECORDED_AT)).toEqual(accepted);
    expect(await readFile(file, "utf8")).toBe(acceptedBytes);
    await expect(recordOutboundEffectAccepted(
      file,
      "effect-1",
      receipt(),
      "2026-07-26T12:02:00.000Z"
    )).rejects.toThrow(/timestamp drift/iu);
    await expect(recordOutboundEffectAccepted(
      file,
      "effect-1",
      receipt({ messageId: "m-2" }),
      RECORDED_AT
    )).rejects.toThrow(/receipt drift/iu);
    await expect(recordOutboundEffectUnknown(file, "effect-1", "timeout after dispatch", RECORDED_AT))
      .rejects.toThrow(/terminal/iu);
    expect(await readFile(file, "utf8")).toBe(acceptedBytes);
  });

  it("makes an ambiguous dispatch terminal until an explicit manual reconciliation", async () => {
    await prepareOutboundEffect(file, binding());
    const unknown = await recordOutboundEffectUnknown(file, "effect-1", "timeout after request body", RECORDED_AT);
    expect(unknown).toEqual({
      binding: binding(),
      state: "unknown",
      unknownDetail: "timeout after request body"
    });
    const unknownBytes = await readFile(file, "utf8");

    expect(await recordOutboundEffectUnknown(file, "effect-1", "timeout after request body", RECORDED_AT)).toEqual(unknown);
    expect(await readFile(file, "utf8")).toBe(unknownBytes);
    await expect(recordOutboundEffectUnknown(
      file,
      "effect-1",
      "timeout after request body",
      "2026-07-26T12:02:00.000Z"
    )).rejects.toThrow(/timestamp drift/iu);
    await expect(recordOutboundEffectAccepted(file, "effect-1", receipt(), RECORDED_AT))
      .rejects.toThrow(/terminal/iu);

    const reconciled = await reconcileOutboundEffect(file, {
      actor: "owner",
      decision: "accepted",
      effectId: "effect-1",
      reason: "confirmed in Slack history",
      receipt: receipt(),
      recordedAt: "2026-07-26T12:05:00.000Z"
    });
    expect(reconciled).toMatchObject({
      reconciliation: {
        actor: "owner",
        decision: "accepted",
        reason: "confirmed in Slack history"
      },
      receipt: receipt(),
      state: "reconciled-accepted"
    });
    const reconciledBytes = await readFile(file, "utf8");
    expect(await reconcileOutboundEffect(file, {
      actor: "owner",
      decision: "accepted",
      effectId: "effect-1",
      reason: "confirmed in Slack history",
      receipt: receipt(),
      recordedAt: "2026-07-26T12:05:00.000Z"
    })).toEqual(reconciled);
    expect(await readFile(file, "utf8")).toBe(reconciledBytes);
  });

  it("records not-delivered reconciliation without inventing a provider receipt", async () => {
    await prepareOutboundEffect(file, binding());
    await recordOutboundEffectUnknown(file, "effect-1", "connection reset", RECORDED_AT);

    const view = await reconcileOutboundEffect(file, {
      actor: "owner",
      decision: "not-delivered",
      effectId: "effect-1",
      reason: "provider history has no matching message",
      recordedAt: "2026-07-26T12:06:00.000Z"
    });
    expect(view.state).toBe("reconciled-not-delivered");
    expect(view.receipt).toBeUndefined();
    const bytes = await readFile(file, "utf8");
    expect(await reconcileOutboundEffect(file, {
      actor: "owner",
      decision: "not-delivered",
      effectId: "effect-1",
      reason: "provider history has no matching message",
      recordedAt: "2026-07-26T12:06:00.000Z"
    })).toEqual(view);
    expect(await readFile(file, "utf8")).toBe(bytes);
    await expect(reconcileOutboundEffect(file, {
      actor: "owner",
      decision: "not-delivered",
      effectId: "effect-1",
      reason: "provider history has no matching message",
      receipt: receipt(),
      recordedAt: "2026-07-26T12:06:00.000Z"
    })).rejects.toThrow(/must not include/iu);
  });

  it("refuses reconciliation without an unknown state or explicit actor/reason", async () => {
    await prepareOutboundEffect(file, binding());
    const before = await readFile(file, "utf8");

    await expect(reconcileOutboundEffect(file, {
      actor: "owner",
      decision: "not-delivered",
      effectId: "effect-1",
      reason: "checked provider history",
      recordedAt: RECORDED_AT
    })).rejects.toThrow(/not awaiting/iu);
    await expect(reconcileOutboundEffect(file, {
      actor: "",
      decision: "not-delivered",
      effectId: "effect-1",
      reason: "checked provider history",
      recordedAt: RECORDED_AT
    })).rejects.toThrow(/actor/iu);
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("rejects receipt route drift with zero mutation", async () => {
    await prepareOutboundEffect(file, binding());
    const before = await readFile(file, "utf8");

    await expect(recordOutboundEffectAccepted(
      file,
      "effect-1",
      receipt({ providerId: "discord" }),
      RECORDED_AT
    )).rejects.toThrow(/route drift/iu);
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("rejects non-monotonic terminal timestamps with zero mutation", async () => {
    await prepareOutboundEffect(file, binding());
    const before = await readFile(file, "utf8");

    await expect(recordOutboundEffectUnknown(
      file,
      "effect-1",
      "timeout",
      "2026-07-26T11:59:59.000Z"
    )).rejects.toThrow(/must not precede/iu);
    await expect(recordOutboundEffectAccepted(
      file,
      "effect-1",
      receipt({ receivedAt: "2026-07-26T11:59:59.000Z" }),
      RECORDED_AT
    )).rejects.toThrow(/must not precede/iu);
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("fails closed on corrupt or hash-drifted state and never overwrites it", async () => {
    await prepareOutboundEffect(file, binding());
    const parsed = JSON.parse(await readFile(file, "utf8")) as {
      events: Array<{ binding: { destination: string } }>;
    };
    parsed.events[0]!.binding.destination = "C999";
    await writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    const tampered = await readFile(file, "utf8");

    await expect(readOutboundEffects(file)).rejects.toThrow(/integrity/iu);
    await expect(prepareOutboundEffect(file, binding("effect-2"))).rejects.toThrow(/integrity/iu);
    expect(await readFile(file, "utf8")).toBe(tampered);
  });

  it("serializes concurrent prepares without losing effects or duplicating a replay", async () => {
    const unique = Array.from({ length: 25 }, (_unused, index) => binding(`effect-${index.toString()}`));
    await Promise.all(unique.map((entry) => prepareOutboundEffect(file, entry)));
    await Promise.all(Array.from({ length: 10 }, () => prepareOutboundEffect(file, unique[0]!)));

    expect(await readOutboundEffects(file)).toHaveLength(25);
    const persisted = JSON.parse(await readFile(file, "utf8")) as { events: unknown[] };
    expect(persisted.events).toHaveLength(25);
  });

  it("allows only one terminal winner under an accepted-vs-unknown race", async () => {
    await prepareOutboundEffect(file, binding());
    const results = await Promise.allSettled([
      recordOutboundEffectAccepted(file, "effect-1", receipt(), RECORDED_AT),
      recordOutboundEffectUnknown(file, "effect-1", "timeout after dispatch", RECORDED_AT)
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(["accepted", "unknown"]).toContain((await readOutboundEffect(file, "effect-1"))?.state);
  });

  it("rejects malformed hashes, timestamps, and unknown schema keys", async () => {
    await expect(prepareOutboundEffect(file, binding("bad-hash", { payloadHash: "nope" })))
      .rejects.toBeInstanceOf(OutboundEffectStoreError);
    await expect(prepareOutboundEffect(file, binding("bad-time", { createdAt: "not-a-time" })))
      .rejects.toBeInstanceOf(OutboundEffectStoreError);
    await expect(prepareOutboundEffect(file, {
      ...binding("extra-binding"),
      extra: true
    } as OutboundEffectBinding)).rejects.toThrow(/unsupported fields/iu);

    await prepareOutboundEffect(file, binding("bad-receipt"));
    await expect(recordOutboundEffectAccepted(file, "bad-receipt", {
      ...receipt(),
      extra: true
    } as OutboundEffectReceipt, RECORDED_AT)).rejects.toThrow(/unsupported fields/iu);

    await writeFile(file, `${JSON.stringify({ events: [], extra: true, schemaVersion: "muse.outbound-effect-ledger/v1" })}\n`, "utf8");
    await expect(readOutboundEffects(file)).rejects.toThrow(/unsupported schema/iu);
  });

  it("snapshots mutable caller inputs before awaiting the serialized mutation", async () => {
    const mutableBinding = { ...binding("stable-input") };
    const preparePromise = prepareOutboundEffect(file, mutableBinding);
    mutableBinding.destination = "mutated-after-call";
    await preparePromise;

    const mutableReceipt = { ...receipt() };
    const acceptedPromise = recordOutboundEffectAccepted(
      file,
      "stable-input",
      mutableReceipt,
      RECORDED_AT
    );
    mutableReceipt.destination = "mutated-after-call";
    await acceptedPromise;

    expect(await readOutboundEffect(file, "stable-input")).toEqual({
      binding: binding("stable-input"),
      receipt: receipt(),
      state: "accepted"
    });
  });

  it("rejects unsupported reconciliation decisions before mutating the ledger", async () => {
    await prepareOutboundEffect(file, binding());
    await recordOutboundEffectUnknown(file, "effect-1", "timeout", RECORDED_AT);
    const before = await readFile(file, "utf8");

    await expect(reconcileOutboundEffect(file, {
      actor: "owner",
      decision: "invented-terminal",
      effectId: "effect-1",
      reason: "invalid runtime input",
      recordedAt: "2026-07-26T12:02:00.000Z"
    } as never)).rejects.toThrow(/decision is unsupported/iu);
    expect(await readFile(file, "utf8")).toBe(before);
    expect((await readOutboundEffect(file, "effect-1"))?.state).toBe("unknown");
  });

  it("fails closed when an existing ledger is no longer private", async () => {
    if (process.platform === "win32") return;
    await prepareOutboundEffect(file, binding());
    await chmod(file, 0o644);
    const exposed = await readFile(file, "utf8");

    await expect(readOutboundEffects(file)).rejects.toThrow(/permissions are not private/iu);
    await expect(prepareOutboundEffect(file, binding("effect-2"))).rejects.toThrow(/permissions are not private/iu);
    expect(await readFile(file, "utf8")).toBe(exposed);
  });

  it("rejects oversized events before persisting an unreadable ledger", async () => {
    await prepareOutboundEffect(file, binding());
    const before = await readFile(file, "utf8");

    await expect(prepareOutboundEffect(file, binding("oversized", {
      destination: "x".repeat(40_000),
      payloadHash: computeOutboundEffectPayloadHash({
        destination: "x".repeat(40_000),
        providerId: "slack",
        text: "hello"
      })
    }))).rejects.toThrow(/size limit/iu);
    expect(await readFile(file, "utf8")).toBe(before);
    expect(await readOutboundEffect(file, "effect-1")).toEqual({
      binding: binding(),
      state: "prepared"
    });
  });
});
