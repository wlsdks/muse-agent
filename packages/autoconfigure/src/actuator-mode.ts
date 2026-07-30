/**
 * Actuator mode — how much Muse may act on the world without asking.
 *
 *   off  (default) — actuator tools are not exposed to the model at all
 *   ask            — every actuator call needs an explicit confirm
 *   auto           — recoverable actions run directly; third-party sends
 *                    STILL confirm unless a standing grant covers them
 *
 * `off` by default is the trust floor, matching `dayRhythm`: an untouched
 * config exposes nothing. Opt-in, never opt-out.
 *
 * State lives in the SAME `~/.config/muse/config.json` the CLI reads, under an
 * `actuators` block — reimplemented here rather than imported from apps/cli
 * because apps/api cannot depend on apps/cli (the constraint `day-rhythm-config.ts`
 * and `model-registry.ts` document). Read live per turn so a mode change takes
 * effect without a restart.
 *
 * This module resolves the SETTING only. It does not decide any individual
 * call — that is the approval gate's job, and `auto` never means "send
 * anything to anyone" (see docs/design/platform/actuator-modes.md).
 */

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { isRecord, parseJson } from "@muse/shared";

export const ACTUATOR_MODES = ["off", "ask", "auto"] as const;
export type ActuatorMode = (typeof ACTUATOR_MODES)[number];

export const DEFAULT_ACTUATOR_MODE: ActuatorMode = "off";

export interface ActuatorConfig {
  readonly mode: ActuatorMode;
}

export function isActuatorMode(value: unknown): value is ActuatorMode {
  return typeof value === "string" && (ACTUATOR_MODES as readonly string[]).includes(value);
}

/**
 * Absent/malformed input ⇒ `off` — never throws. An unrecognised mode string
 * is NOT treated as a typo to guess at: it falls back to the closed default,
 * so a config typo can never silently widen what Muse may do.
 */
export function normalizeActuatorConfig(raw: unknown): ActuatorConfig {
  if (!isRecord(raw)) {
    return { mode: DEFAULT_ACTUATOR_MODE };
  }
  return { mode: isActuatorMode(raw.mode) ? raw.mode : DEFAULT_ACTUATOR_MODE };
}

interface MuseCliConfigShape {
  readonly [key: string]: unknown;
}

function isNodeErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value !== null && typeof value === "object" && "code" in value && typeof (value as { code?: unknown }).code === "string";
}

async function readRawConfig(filePath: string): Promise<MuseCliConfigShape> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = parseJson(raw);
    if (parsed === undefined) {
      throw new Error(`config file is not valid JSON: ${filePath} — fix or delete it`);
    }
    if (!isRecord(parsed)) {
      throw new Error(`config file is not a JSON object: ${filePath} — fix or delete it`);
    }
    return parsed;
  } catch (error) {
    if (isNodeErrnoException(error) && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function readActuatorConfig(filePath: string): Promise<ActuatorConfig> {
  return normalizeActuatorConfig((await readRawConfig(filePath)).actuators);
}

export async function writeActuatorConfig(filePath: string, next: ActuatorConfig): Promise<ActuatorConfig> {
  const current = await readRawConfig(filePath);
  const merged: MuseCliConfigShape = { ...current, actuators: next };
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid.toString()}-${randomBytes(8).toString("hex")}`;
  try {
    await writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, filePath);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  await chmod(filePath, 0o600).catch(() => undefined);
  return next;
}

/**
 * Per-turn reader: ANY read/parse failure resolves to `off`. A corrupt
 * config.json must never crash a turn, and must never fail OPEN — an
 * unreadable config means Muse acts on nothing.
 */
export async function readActuatorConfigSafe(filePath: string): Promise<ActuatorConfig> {
  try {
    return await readActuatorConfig(filePath);
  } catch {
    return { mode: DEFAULT_ACTUATOR_MODE };
  }
}

/**
 * The effective mode for a turn. Precedence, highest first:
 *   1. MUSE_ACTUATOR_MODE  — per-invocation override
 *   2. the `actuators.mode` config block
 *   3. off
 *
 * An env value that is not a known mode is IGNORED (falls through to config)
 * rather than treated as `off`: a typo in a shell export should not silently
 * disable a mode the user durably configured, and it cannot widen anything
 * because the config value it falls through to was itself user-chosen.
 */
export function resolveActuatorMode(env: NodeJS.ProcessEnv, configured: ActuatorMode): ActuatorMode {
  const override = env.MUSE_ACTUATOR_MODE?.trim().toLowerCase();
  return isActuatorMode(override) ? override : configured;
}
