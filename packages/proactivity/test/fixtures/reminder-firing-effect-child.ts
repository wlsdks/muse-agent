import { appendFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { runDueReminders } from "../../src/reminder-firing-loop.js";

interface Input {
  readonly callsFile: string;
  readonly effectFile: string;
  readonly historyFile: string;
  readonly nowIso: string;
  readonly remindersFile: string;
}

const input = JSON.parse(process.argv[2] ?? "") as Input;
const result = await runDueReminders({
  destination: "@owner",
  effectFile: input.effectFile,
  file: input.remindersFile,
  historyFile: input.historyFile,
  now: () => new Date(input.nowIso),
  providerId: "telegram",
  registry: {
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
  }
});
process.stdout.write(`${JSON.stringify(result)}\n`);
