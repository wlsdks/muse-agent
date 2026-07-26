import { appendFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import {
  MessagingProviderRegistry,
  type MessagingProvider
} from "@muse/messaging";

import { runDueProactiveNotices } from "../../src/proactive-notice-loop.js";

interface Input {
  readonly callsFile: string;
  readonly effectFile: string;
  readonly nowIso: string;
  readonly sidecarFile: string;
  readonly tasksFile: string;
}

const input = JSON.parse(process.argv[2] ?? "") as Input;
const provider: MessagingProvider = {
  describe: () => ({ description: "test", displayName: "Test", id: "telegram" }),
  id: "telegram",
  send: async (message) => {
    await appendFile(input.callsFile, `${process.pid.toString()}\n`);
    await sleep(75);
    return {
      destination: message.destination,
      messageId: `message-${process.pid.toString()}`,
      providerId: "telegram"
    };
  }
};
const result = await runDueProactiveNotices({
  destination: "@owner",
  effectFile: input.effectFile,
  heartbeatDir: null,
  messagingRegistry: new MessagingProviderRegistry([provider]),
  now: () => new Date(input.nowIso),
  providerId: "telegram",
  sidecarFile: input.sidecarFile,
  tasksFile: input.tasksFile
});
process.stdout.write(`${JSON.stringify(result)}\n`);
