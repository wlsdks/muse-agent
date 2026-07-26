import { appendFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { runDueBackgroundExitNotices } from "../../src/background-exit-notice-loop.js";

interface Input {
  readonly callsFile: string;
  readonly effectFile: string;
  readonly notifiedFile: string;
  readonly nowIso: string;
  readonly storeFile: string;
}

const input = JSON.parse(process.argv[2] ?? "") as Input;
const result = await runDueBackgroundExitNotices({
  destination: "@owner",
  effectFile: input.effectFile,
  messagingRegistry: {
    has: (providerId: string) => providerId === "telegram",
    send: async (providerId, message) => {
      await appendFile(input.callsFile, `${process.pid.toString()}\n`);
      await sleep(50);
      return {
        destination: message.destination,
        messageId: `message-${process.pid.toString()}`,
        providerId
      };
    }
  },
  notifiedFile: input.notifiedFile,
  now: () => new Date(input.nowIso),
  providerId: "telegram",
  storeFile: input.storeFile
});
process.stdout.write(`${JSON.stringify(result)}\n`);
