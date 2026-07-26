import { appendFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { MessagingProviderRegistry, type MessagingProvider } from "@muse/messaging";

import { createMessagingObjectiveActuator } from "../../src/objective-evaluator.js";
import { runDueObjectives } from "../../src/objective-evaluation-loop.js";

interface Input {
  readonly callsFile: string;
  readonly effectFile: string;
  readonly nowIso: string;
  readonly objectivesFile: string;
}

const input = JSON.parse(process.argv[2] ?? "") as Input;
const provider: MessagingProvider = {
  describe: () => ({ description: "test", displayName: "Test", id: "telegram" }),
  id: "telegram",
  send: async (message) => {
    await appendFile(input.callsFile, `${process.pid.toString()}\n`);
    await sleep(50);
    return {
      destination: message.destination,
      messageId: `message-${process.pid.toString()}`,
      providerId: "telegram"
    };
  }
};
const actuator = createMessagingObjectiveActuator({
  destination: "@owner",
  effectFile: input.effectFile,
  now: () => new Date(input.nowIso),
  providerId: "telegram",
  registry: new MessagingProviderRegistry([provider])
});
const result = await runDueObjectives({
  act: actuator.act,
  escalate: actuator.escalate,
  evaluate: async () => ({
    evidence: [{ source: "task:release", text: "release completed" }],
    outcome: "met"
  }),
  file: input.objectivesFile,
  now: () => new Date(input.nowIso),
  terminalEffects: actuator
});
process.stdout.write(`${JSON.stringify(result)}\n`);
