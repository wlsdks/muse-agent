import { appendFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { runDueFollowups } from "../../src/followup-firing-loop.js";

interface Input {
  readonly callsFile: string;
  readonly effectFile: string;
  readonly followupsFile: string;
  readonly modelCallsFile: string;
  readonly nowIso: string;
}

const input = JSON.parse(process.argv[2] ?? "") as Input;
const result = await runDueFollowups({
  destination: "@owner",
  effectFile: input.effectFile,
  file: input.followupsFile,
  model: "test-model",
  modelProvider: {
    generate: async () => {
      await appendFile(input.modelCallsFile, `${process.pid.toString()}\n`);
      await sleep(30);
      return { output: "Did the deployment finish?" };
    }
  },
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
