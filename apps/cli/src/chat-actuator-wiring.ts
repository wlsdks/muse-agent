/**
 * Exposes the actuator tools to the chat REPL's model, gated by the actuator
 * mode. This is the link that was missing: `buildActuatorTools` and
 * `muse approvals approve` both work, but nothing handed the tools to a model,
 * so no draft was ever staged and the worklist was always empty.
 *
 * Step 2 of docs/design/actuator-modes.md. The gate is `ask` for BOTH risk
 * classes here — `auto` resolves to the same confirm until step 4 splits
 * recoverable actions out. So `auto` is currently no more permissive than
 * `ask`, which is the safe direction for a mode whose behaviour has not
 * shipped yet.
 *
 * `muse chat` is the only surface wired: it is interactive, so a human is
 * present to answer the confirm. The non-interactive surfaces (job-worker,
 * brief, scheduled runs) deliberately get nothing — an actuator there would
 * either fail-close on every call or stage drafts nobody asked for.
 */

import { readActuatorConfigSafe, resolveActuatorMode, type ActuatorMode, type MuseEnvironment } from "@muse/autoconfigure";
import type { MuseTool } from "@muse/tools";

import { buildActuatorTools } from "./actuator-tools.js";
import { defaultConfigPath } from "./program-config.js";
import type { ProgramIO } from "./program.js";

export interface ChatActuatorWiring {
  readonly mode: ActuatorMode;
  readonly tools: readonly MuseTool[];
}

/**
 * Resolve the effective mode from env + config. Exported so a caller can show
 * the posture without building the tools.
 */
export async function resolveChatActuatorMode(env: MuseEnvironment, configFile?: string): Promise<ActuatorMode> {
  const file = configFile ?? defaultConfigPath(env.HOME);
  return resolveActuatorMode(env, (await readActuatorConfigSafe(file)).mode);
}

/**
 * The actuator tools for this chat turn, or none.
 *
 * `off` returns an EMPTY list rather than tools-with-a-denying-gate. The
 * difference matters twice over: the model never sees a capability it cannot
 * use (tool-calling.md keeps the exposed set small — every extra tool raises
 * the wrong-selection rate on a local model), and a bug in a gate can never
 * leak a capability the user did not opt into, because the capability is not
 * there to leak.
 */
export async function buildChatActuatorWiring(params: {
  readonly env: MuseEnvironment;
  readonly io: ProgramIO;
  readonly userId: string;
  readonly configFile?: string;
  /** Injectable for tests; production uses the clack confirm inside buildActuatorTools. */
  readonly confirmAction?: (message: string) => Promise<boolean>;
  readonly isInteractive?: () => boolean;
}): Promise<ChatActuatorWiring> {
  const mode = await resolveChatActuatorMode(params.env, params.configFile);
  if (mode === "off") {
    return { mode, tools: [] };
  }

  return {
    mode,
    tools: buildActuatorTools({
      env: params.env,
      io: params.io,
      userId: params.userId,
      ...(params.confirmAction ? { confirmAction: params.confirmAction } : {}),
      ...(params.isInteractive ? { isInteractive: params.isInteractive } : {})
    })
  };
}
