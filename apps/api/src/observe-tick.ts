import { readAttunementState } from "@muse/attunement";
import { createObserveRunnerFromEnvironment, type ObserveRunner } from "@muse/attunement/host";
import type { FastifyInstance } from "fastify";

/** Start the opt-in Observe collector for the API daemon composition root. */
export function startObserveDaemonIfConfigured(
  env: Readonly<Record<string, string | undefined>>,
  server: FastifyInstance,
  attunementFile: string,
  dependencies: { readonly createRunner?: typeof createObserveRunnerFromEnvironment } = {}
): void {
  let runner: ObserveRunner | undefined;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  server.addHook("onClose", async () => {
    closed = true;
    if (timer !== undefined) clearInterval(timer);
    await runner?.shutdown();
  });
  void (dependencies.createRunner ?? createObserveRunnerFromEnvironment)({
    assertKnownThread: async (threadId) => {
      if (!(await readAttunementState(attunementFile)).threads.some((thread) => thread.id === threadId)) throw new Error("configured Observe thread does not exist");
    },
    attunementFile,
    env,
  }).then((created) => {
    if (closed) { void created?.shutdown(); return; }
    runner = created;
    if (runner === undefined) return;
    const intervalMs = Number(env.MUSE_OBSERVE_INTERVAL_MS);
    const tick = (): void => { void runner!.tick().catch((cause: unknown) => server.log.warn({ err: cause }, "Observe tick failed")); };
    tick();
    timer = setInterval(tick, intervalMs);
    timer.unref();
  }).catch((cause: unknown) => server.log.warn({ err: cause }, "Observe daemon disabled by invalid configuration"));
}
