import { readFileSync } from "node:fs";

import { MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import {
  DAEMON_PROVIDER_LOCK_MISMATCH_REASON,
  lockDaemonMessagingRegistry,
  reconcileDaemonProviderLock,
  resolveDaemonProviderLock
} from "./daemon-messaging-safety.js";

function provider(id: string, send: (message: OutboundMessage) => Promise<OutboundReceipt>): MessagingProvider {
  return {
    describe: () => ({ description: id, displayName: id, id }),
    id,
    send
  };
}

function parseSource(relativePath: string): ts.SourceFile {
  return ts.createSourceFile(
    relativePath,
    readFileSync(new URL(relativePath, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
}

function callsNamed(source: ts.SourceFile, name: string): readonly ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

function objectPropertyExpression(
  source: ts.SourceFile,
  object: ts.ObjectLiteralExpression,
  propertyName: string
): string | undefined {
  for (const property of object.properties) {
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === propertyName) return property.name.text;
    if (ts.isPropertyAssignment(property) && property.name.getText(source).replaceAll(/["']/gu, "") === propertyName) {
      return property.initializer.getText(source);
    }
  }
  return undefined;
}

function registryTickConsumers(): readonly { readonly factory: string; readonly properties: readonly string[] }[] {
  const consumers: { factory: string; properties: readonly string[] }[] = [];
  for (const relativePath of ["./daemon-delivery-ticks.ts", "./daemon-selflearn-ticks.ts", "./daemon-watch-ticks.ts"]) {
    const source = parseSource(relativePath);
    const dependencyInterfaces = new Map<string, readonly string[]>();
    for (const statement of source.statements) {
      if (!ts.isInterfaceDeclaration(statement)) continue;
      const properties = statement.members.flatMap((member): string[] => {
        if (!ts.isPropertySignature(member) || !member.type || member.type.getText(source) !== "MessagingProviderRegistry") return [];
        return ts.isIdentifier(member.name) ? [member.name.text] : [];
      });
      if (properties.length > 0) dependencyInterfaces.set(statement.name.text, properties);
    }
    for (const statement of source.statements) {
      if (!ts.isFunctionDeclaration(statement) || !statement.name || statement.parameters.length !== 1) continue;
      const type = statement.parameters[0]?.type;
      if (!type || !ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName)) continue;
      const properties = dependencyInterfaces.get(type.typeName.text);
      if (properties) consumers.push({ factory: statement.name.text, properties });
    }
  }
  return consumers;
}

describe("daemon messaging provider lock", () => {
  it("allows log sends and rejects every non-log override before provider dispatch", async () => {
    const logSend = vi.fn(async (message: OutboundMessage): Promise<OutboundReceipt> => ({
      destination: message.destination,
      messageId: "log-1",
      providerId: "log"
    }));
    const telegramSend = vi.fn(async (message: OutboundMessage): Promise<OutboundReceipt> => ({
      destination: message.destination,
      messageId: "telegram-1",
      providerId: "telegram"
    }));
    const registry = new MessagingProviderRegistry([
      provider("log", logSend),
      provider("telegram", telegramSend)
    ]);
    const locked = lockDaemonMessagingRegistry(registry, "log");

    await expect(locked.send("log", { destination: "local", text: "safe" })).resolves.toMatchObject({ providerId: "log" });
    await expect(locked.send("telegram", { destination: "external", text: "blocked" })).rejects.toThrow(/provider lock/iu);
    expect(logSend).toHaveBeenCalledOnce();
    expect(telegramSend).not.toHaveBeenCalled();
  });

  it("keeps an unset lock byte-compatible and rejects unsupported lock values", () => {
    const registry = new MessagingProviderRegistry();

    expect(resolveDaemonProviderLock({})).toBeUndefined();
    expect(lockDaemonMessagingRegistry(registry, undefined)).toBe(registry);
    expect(() => resolveDaemonProviderLock({ MUSE_DAEMON_PROVIDER_LOCK: "telegram" })).toThrow(/only supports 'log'/iu);
  });

  it("reports the explicit allowed set, resolved adapter, and deterministic mismatch reason", () => {
    expect(reconcileDaemonProviderLock("log", "log")).toEqual({
      allowedProviderIds: ["log"],
      mismatchReason: null,
      resolvedAdapterId: "log"
    });
    expect(reconcileDaemonProviderLock("log", "telegram")).toEqual({
      allowedProviderIds: ["log"],
      mismatchReason: DAEMON_PROVIDER_LOCK_MISMATCH_REASON,
      resolvedAdapterId: "telegram"
    });
    expect(reconcileDaemonProviderLock(undefined, "telegram")).toEqual({
      allowedProviderIds: null,
      mismatchReason: null,
      resolvedAdapterId: "telegram"
    });
  });

  it("structurally wires every registry-capable daemon tick through the one locked registry", () => {
    const source = parseSource("./commands-daemon-register.ts");
    const consumers = [...registryTickConsumers()].sort((left, right) => left.factory.localeCompare(right.factory));
    expect(consumers.map(({ factory }) => factory)).toEqual([
      "makeBackgroundExitNoticeTick",
      "makeBriefingTick",
      "makeCheckinsTick",
      "makeConflictWatchTick",
      "makeDailyBriefTick",
      "makeDigestFlushTick",
      "makeFollowupTick",
      "makePatternTick",
      "makeProactiveTick",
      "makeRecapTick",
      "makeRemindersTick",
      "makeSchedulerTick"
    ]);

    const lockCalls = callsNamed(source, "lockDaemonMessagingRegistry");
    expect(lockCalls).toHaveLength(1);
    let lockDeclaration: ts.VariableDeclaration | undefined;
    const findLockDeclaration = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "messagingRegistry") {
        lockDeclaration = node;
      }
      ts.forEachChild(node, findLockDeclaration);
    };
    findLockDeclaration(source);
    expect(lockDeclaration?.initializer).toBe(lockCalls[0]);
    expect(lockCalls[0]?.arguments.map((argument) => argument.getText(source))).toEqual([
      "observableMessagingRegistry",
      "providerLock"
    ]);

    for (const consumer of consumers) {
      const calls = callsNamed(source, consumer.factory);
      expect(calls, consumer.factory).toHaveLength(1);
      const argument = calls[0]?.arguments[0];
      expect(argument !== undefined && ts.isObjectLiteralExpression(argument), consumer.factory).toBe(true);
      if (!argument || !ts.isObjectLiteralExpression(argument)) continue;
      for (const property of consumer.properties) {
        expect(objectPropertyExpression(source, argument, property), `${consumer.factory}.${property}`).toBe("messagingRegistry");
      }
    }

    const objectiveCalls = callsNamed(source, "createMessagingObjectiveActuator");
    expect(objectiveCalls).toHaveLength(1);
    const objectiveOptions = objectiveCalls[0]?.arguments[0];
    expect(objectiveOptions !== undefined && ts.isObjectLiteralExpression(objectiveOptions)).toBe(true);
    if (objectiveOptions && ts.isObjectLiteralExpression(objectiveOptions)) {
      expect(objectPropertyExpression(source, objectiveOptions, "registry")).toBe("messagingRegistry");
    }
    expect(callsNamed(source, "createMessagingPollDispatchers")[0]?.arguments[1]?.getText(source)).toBe("messagingRegistry");

    const sendReceivers: string[] = [];
    const lockEnd = lockDeclaration?.end ?? 0;
    const findDirectSends = (node: ts.Node): void => {
      if (node.getStart(source) > lockEnd && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "send") {
        sendReceivers.push(node.expression.expression.getText(source));
      }
      ts.forEachChild(node, findDirectSends);
    };
    findDirectSends(source);
    expect([...new Set(sendReceivers)]).toEqual(["messagingRegistry"]);
  });

  it("wires objectives to the canonical outbound-effect ledger and forwards its inspector", () => {
    const registerSource = parseSource("./commands-daemon-register.ts");
    const actuatorCalls = callsNamed(registerSource, "createMessagingObjectiveActuator");
    expect(actuatorCalls).toHaveLength(1);
    const actuatorOptions = actuatorCalls[0]?.arguments[0];
    expect(actuatorOptions !== undefined && ts.isObjectLiteralExpression(actuatorOptions)).toBe(true);
    if (!actuatorOptions || !ts.isObjectLiteralExpression(actuatorOptions)) return;
    expect(objectPropertyExpression(registerSource, actuatorOptions, "effectFile"))
      .toBe('join(dirname(objectivesActionLogFile), "outbound-effects.json")');

    const tickSource = parseSource("./daemon-watch-ticks.ts");
    const objectiveRuns = callsNamed(tickSource, "runDueObjectives");
    expect(objectiveRuns).toHaveLength(1);
    const runOptions = objectiveRuns[0]?.arguments[0];
    expect(runOptions !== undefined && ts.isObjectLiteralExpression(runOptions)).toBe(true);
    if (!runOptions || !ts.isObjectLiteralExpression(runOptions)) return;
    expect(runOptions.getText(tickSource)).toContain(
      "terminalEffects: { inspect: actuator.inspect }"
    );
  });

  it("wires proactive imminent tasks to the canonical outbound-effect ledger", () => {
    const registerSource = parseSource("./commands-daemon-register.ts");
    const proactiveCalls = callsNamed(registerSource, "makeProactiveTick");
    expect(proactiveCalls).toHaveLength(1);
    const proactiveOptions = proactiveCalls[0]?.arguments[0];
    expect(proactiveOptions !== undefined && ts.isObjectLiteralExpression(proactiveOptions)).toBe(true);
    if (!proactiveOptions || !ts.isObjectLiteralExpression(proactiveOptions)) return;
    expect(objectPropertyExpression(registerSource, proactiveOptions, "effectFile"))
      .toBe('join(dirname(resolveActionLogFile(e)), "outbound-effects.json")');

    const tickSource = parseSource("./daemon-delivery-ticks.ts");
    const runCalls = callsNamed(tickSource, "runDueProactiveNotices");
    expect(runCalls).toHaveLength(1);
    const runOptions = runCalls[0]?.arguments[0];
    expect(runOptions !== undefined && ts.isObjectLiteralExpression(runOptions)).toBe(true);
    if (!runOptions || !ts.isObjectLiteralExpression(runOptions)) return;
    expect(objectPropertyExpression(tickSource, runOptions, "effectFile")).toBe("effectFile");

    expect(objectPropertyExpression(registerSource, proactiveOptions, "env")).toBe("e");
    expect(objectPropertyExpression(registerSource, proactiveOptions, "channelOwnersFile")).toBe("channelOwnersFile");
    expect(objectPropertyExpression(registerSource, proactiveOptions, "dayRhythmConfigFile")).toBe("dayRhythmConfigFile");
  });

  it("wires the digest production factory to live route inputs", () => {
    const registerSource = parseSource("./commands-daemon-register.ts");
    const digestCalls = callsNamed(registerSource, "makeDigestFlushTick");
    expect(digestCalls).toHaveLength(1);
    const digestOptions = digestCalls[0]?.arguments[0];
    expect(digestOptions !== undefined && ts.isObjectLiteralExpression(digestOptions)).toBe(true);
    if (!digestOptions || !ts.isObjectLiteralExpression(digestOptions)) return;
    expect(objectPropertyExpression(registerSource, digestOptions, "env")).toBe("e");
    expect(objectPropertyExpression(registerSource, digestOptions, "channelOwnersFile")).toBe("channelOwnersFile");
    expect(objectPropertyExpression(registerSource, digestOptions, "dayRhythmConfigFile")).toBe("dayRhythmConfigFile");
  });
});
