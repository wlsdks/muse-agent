import { appendFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { runDuePatternNotices } from "../../src/pattern-firing-loop.js";

interface Input {
  readonly callsFile: string;
  readonly effectFile: string;
  readonly notesDir: string;
  readonly nowIso: string;
  readonly patternsFiredFile: string;
}

const input = JSON.parse(process.argv[2] ?? "") as Input;
const result = await runDuePatternNotices({
  destination: "@owner",
  effectFile: input.effectFile,
  now: () => new Date(input.nowIso),
  patternsFiredFile: input.patternsFiredFile,
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
  },
  signals: { notesDir: input.notesDir }
});
process.stdout.write(`${JSON.stringify(result)}\n`);
