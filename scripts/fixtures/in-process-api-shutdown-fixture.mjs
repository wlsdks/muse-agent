import { writeFile } from "node:fs/promises";

import {
  finishInProcessApiSmoke,
  startInProcessApi
} from "../lib/in-process-api.mjs";

const [, , mode, marker] = process.argv;
if ((mode !== "normal" && mode !== "hung") || !marker) {
  process.exit(64);
}

// A pending Promise alone does not keep Node alive. The active interval makes
// this fixture prove that the driver's deferred force-exit path terminates a
// genuinely live event-loop handle after cleanup.
const lingeringHandle = mode === "hung" ? setInterval(() => undefined, 1_000) : undefined;

const api = await startInProcessApi({
  env: { HOME: "/fixture", MUSE_MODEL_PROVIDER_ID: "diagnostic" },
  loadDependencies: async () => ({
    buildServer: () => ({
      close: async () => undefined,
      listen: async () => "http://127.0.0.1:43212"
    }),
    createApiServerOptions: ({ env }) => ({
      env,
      scheduler: {
        service: {
          shutdown: mode === "hung"
            ? () => Promise.withResolvers().promise
            : async () => "drained"
        }
      }
    })
  })
});

let forceExitRequested = false;
const result = await finishInProcessApiSmoke({
  cleanup: () => writeFile(marker, "cleanup-before-exit\n", "utf8"),
  forceExit: () => { forceExitRequested = true; },
  restoreEnvironment: () => undefined,
  stop: api.stop,
  timeoutMs: 25
});
process.exitCode = result.exitCode;
if (forceExitRequested) process.exit(1);
if (lingeringHandle) clearInterval(lingeringHandle);
