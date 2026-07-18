import { access, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { createFileBackedActivityTracker } from "../../src/proactive-tick.js";

const [file, readyFile, barrierFile, attemptingFile, candidateRaw] = process.argv.slice(2);
if (!file || !readyFile || !barrierFile || !attemptingFile || !candidateRaw) {
  throw new Error("presence writer requires file, ready, barrier, attempting, and candidate arguments");
}

await writeFile(readyFile, "ready\n", { mode: 0o600 });
for (;;) {
  try {
    await access(barrierFile);
    break;
  } catch {
    await delay(2);
  }
}
await writeFile(attemptingFile, "attempting\n", { mode: 0o600 });
const tracker = createFileBackedActivityTracker({ debounceMs: 0, file, now: () => 2_000 });
await tracker.record(Number(candidateRaw));
