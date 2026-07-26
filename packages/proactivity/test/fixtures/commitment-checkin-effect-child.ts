import { appendFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { runDueCheckins } from "../../src/commitment-checkin.js";

interface Input {
  readonly callsFile: string;
  readonly checkinsFile: string;
  readonly effectFile: string;
  readonly nowIso: string;
}

const input = JSON.parse(process.argv[2] ?? "") as Input;
const result = await runDueCheckins({
  destination: "@owner",
  effectFile: input.effectFile,
  file: input.checkinsFile,
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
