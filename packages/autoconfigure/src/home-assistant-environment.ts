/**
 * Narrow Home Assistant environment resolver.
 *
 * The URL is deliberately classified before the bearer token is read. This is
 * both a transport boundary and a credential boundary: under local-only a
 * remote, malformed, absent, or blank endpoint must not make a protected
 * environment reveal its Home Assistant token through a direct get or an
 * object-reflection side effect.
 */

import {
  HOME_ASSISTANT_LOCAL_ONLY_REASON,
  isHomeAssistantLocalOnlyEffective,
  resolveHomeAssistantTransportBaseUrl
} from "@muse/domain-tools";
import { isLocalOnlyEnabled } from "@muse/model";

import type { MuseEnvironment } from "./runtime-assembly.js";

export interface ResolveHomeAssistantEnvironmentOptions {
  /**
   * API composition can freeze a false or true posture. It is still only an
   * input to the monotonic local-only floor; an actually strict process wins.
   */
  readonly localOnlyOverride?: boolean;
}

export type ResolvedHomeAssistantEnvironment =
  | {
      readonly status: "unconfigured";
      readonly localOnly: boolean;
    }
  | {
      readonly status: "blocked";
      readonly localOnly: true;
      readonly reason: typeof HOME_ASSISTANT_LOCAL_ONLY_REASON;
    }
  | {
      readonly status: "configured";
      readonly localOnly: boolean;
      readonly baseUrl: string;
      readonly token: string;
    };

/**
 * Resolve the standard Home Assistant URL/token pair without enumerating the
 * source environment. `localOnlyOverride` is a frozen/injected posture, not a
 * bypass: ambient process strictness is always ORed in before the URL (and,
 * crucially, before the token) is touched.
 */
export function resolveHomeAssistantEnvironment(
  sourceEnv: MuseEnvironment,
  options: ResolveHomeAssistantEnvironmentOptions = {}
): ResolvedHomeAssistantEnvironment {
  const suppliedLocalOnly = options.localOnlyOverride ?? isLocalOnlyEnabled(sourceEnv);
  const localOnly = isHomeAssistantLocalOnlyEffective({ localOnly: suppliedLocalOnly });

  // One direct URL read is enough to classify the endpoint. Do not spread,
  // enumerate, inspect descriptors, or touch the token before this branch.
  const rawBaseUrl = sourceEnv.MUSE_HOMEASSISTANT_URL;
  if (rawBaseUrl === undefined || rawBaseUrl.trim().length === 0) {
    return { localOnly, status: "unconfigured" };
  }
  const transport = resolveHomeAssistantTransportBaseUrl(rawBaseUrl, { localOnly });
  if (!transport.allowed) {
    return { localOnly: true, reason: HOME_ASSISTANT_LOCAL_ONLY_REASON, status: "blocked" };
  }

  // A permitted loopback endpoint (or any normal-mode endpoint) is the only
  // state in which the bearer token may be read.
  const token = sourceEnv.MUSE_HOMEASSISTANT_TOKEN?.trim();
  if (!token) {
    return { localOnly, status: "unconfigured" };
  }
  return { baseUrl: transport.baseUrl, localOnly, status: "configured", token };
}
