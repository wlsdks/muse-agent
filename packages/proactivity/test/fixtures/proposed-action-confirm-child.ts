import { appendFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import type { MessagingProviderRegistry } from "@muse/messaging";

import { confirmProposedAction } from "../../src/proposed-action-confirm.js";

interface Input {
  readonly actionLogFile: string;
  readonly callsFile: string;
  readonly effectFile: string;
  readonly file: string;
  readonly id: string;
  readonly payloadHash: string;
}

const input = JSON.parse(process.argv[2] ?? "") as Input;
const registry: Pick<MessagingProviderRegistry, "send"> = {
  send: async (providerId, message) => {
    await appendFile(input.callsFile, `${process.pid.toString()}\n`);
    await sleep(50);
    return {
      destination: message.destination,
      messageId: `message-${process.pid.toString()}`,
      providerId
    };
  }
};

const result = await confirmProposedAction({
  actionLogFile: input.actionLogFile,
  effectFile: input.effectFile,
  file: input.file,
  id: input.id,
  payloadHash: input.payloadHash,
  registry
});
process.stdout.write(`${JSON.stringify(result)}\n`);
