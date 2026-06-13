/**
 * P17 conversational actuation: expose the gated Home Assistant
 * smart-home control as an AGENT tool so Muse can act on "turn off the
 * living-room lights" mid-turn — not only via `muse home call`.
 * Execution routes through the proven fail-closed
 * `performHomeActionWithApproval` (approval gate, action-logged), so
 * the agent path inherits the SAME guarantee: deny / absent confirm ⇒
 * no service call. Opt-in via the host base URL + long-lived token.
 */

import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import { listHomeAssistantStates, performHomeActionWithApproval, readHomeAssistantState } from "./smart-home.js";
import type { RetryOptions } from "./http-retry.js";
import type { WebActionApprovalGate } from "./web-action.js";

export interface HomeActionToolDeps {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchImpl: typeof fetch;
  readonly approvalGate: WebActionApprovalGate;
  readonly actionLogFile: string;
  readonly userId: string;
}

export function createHomeActionTool(deps: HomeActionToolDeps): MuseTool {
  return {
    definition: {
      description:
        "Call a Home Assistant service to control a smart-home device (lights, locks, climate/thermostat, fans), OR activate a scene / run a script (a 'routine'). "
        + "Examples: turn a light off — service 'light.turn_off', entity 'light.living_room'; "
        + "set the thermostat to a temperature — service 'climate.set_temperature', entity 'climate.living_room'; "
        + "activate a scene ('movie mode') — service 'scene.turn_on', entity 'scene.movie_mode'; "
        + "run a routine ('good night') — service 'script.turn_on', entity 'script.good_night'. "
        + "The user must confirm the exact action before it fires; absent confirmation nothing happens. Not for payments.",
      domain: "home",
      inputSchema: {
        additionalProperties: false,
        properties: {
          data: { description: "Extra service data (object), merged into the call body.", type: "object" },
          entity: { description: "Target entity_id, e.g. 'light.living_room', 'scene.movie_mode', or 'script.good_night'.", type: "string" },
          service: { description: "Service id as '<domain>.<service>', e.g. 'light.turn_off', 'scene.turn_on', 'script.turn_on'.", type: "string" }
        },
        required: ["service"],
        type: "object"
      },
      keywords: ["home", "smart-home", "light", "lock", "device", "homeassistant", "scene", "scenes", "script", "routine", "activate"],
      name: "home_action",
      risk: "execute"
    },
    execute: async (args): Promise<JsonObject> => {
      const service = typeof args["service"] === "string" ? args["service"].trim() : "";
      const dot = service.indexOf(".");
      if (dot <= 0 || dot === service.length - 1) {
        return { performed: false, reason: `service must be '<domain>.<service>' (e.g. light.turn_off), got '${service}'` };
      }
      const entityId = typeof args["entity"] === "string" ? args["entity"].trim() : undefined;
      const data = args["data"] && typeof args["data"] === "object" && !Array.isArray(args["data"])
        ? args["data"] as Record<string, unknown>
        : undefined;
      // A service call with NO resolved target is Home Assistant's "apply to
      // EVERY entity in the domain" path: a model emitting `light.turn_off` with
      // no entity would turn off the whole house, `lock.unlock` would unlock
      // every lock — and the approval summary shows no target, so the user
      // isn't warned. Fail closed unless an entity arg OR a target key in `data`
      // (entity_id / area_id / device_id / target) resolves a concrete scope.
      // A target key must resolve a CONCRETE scope — an EMPTY one (`target: {}`,
      // `entity_id: []` / `""`) is no target: Home Assistant treats it as the
      // whole-domain path, so a mere key-presence check would let an empty target
      // bypass this fail-close and blast every device.
      const isConcreteTarget = (value: unknown): boolean =>
        (typeof value === "string" && value.trim().length > 0) || (Array.isArray(value) && value.length > 0);
      const nested = data && typeof data["target"] === "object" && data["target"] !== null && !Array.isArray(data["target"])
        ? data["target"] as Record<string, unknown>
        : undefined;
      const dataHasTarget = data !== undefined
        && (isConcreteTarget(data["entity_id"]) || isConcreteTarget(data["area_id"]) || isConcreteTarget(data["device_id"])
          || (nested !== undefined && (isConcreteTarget(nested["entity_id"]) || isConcreteTarget(nested["area_id"]) || isConcreteTarget(nested["device_id"]))));
      if (!entityId && !dataHasTarget) {
        return {
          performed: false,
          reason: `home_action needs a target — pass entity (e.g. 'light.living_room'). Refusing '${service}' with no entity: with no target it would hit EVERY device in the '${service.slice(0, dot)}' domain.`
        };
      }
      const outcome = await performHomeActionWithApproval({
        actionLogFile: deps.actionLogFile,
        approvalGate: deps.approvalGate,
        baseUrl: deps.baseUrl,
        domain: service.slice(0, dot),
        fetchImpl: deps.fetchImpl,
        service: service.slice(dot + 1),
        token: deps.token,
        userId: deps.userId,
        ...(entityId ? { entityId } : {}),
        ...(data ? { data } : {})
      });
      return outcome.performed
        ? { performed: true, status: outcome.status }
        : { detail: outcome.detail, performed: false, reason: outcome.reason };
    }
  };
}

export interface HomeStateToolDeps {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  readonly retryOptions?: RetryOptions;
}

export function createHomeStateTool(deps: HomeStateToolDeps): MuseTool {
  return {
    definition: {
      description:
        "Read the current state of a Home Assistant entity, e.g. is 'lock.front_door' locked, or the temperature of 'sensor.living_room'. Read-only — never changes anything.",
      domain: "home",
      inputSchema: {
        additionalProperties: false,
        properties: {
          entity: { description: "Target entity_id, e.g. 'lock.front_door' or 'sensor.living_room_temperature'.", type: "string" }
        },
        required: ["entity"],
        type: "object"
      },
      keywords: ["home", "smart-home", "state", "status", "temperature", "lock", "sensor", "homeassistant"],
      name: "home_state",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const entityId = typeof args["entity"] === "string" ? args["entity"].trim() : "";
      if (entityId.length === 0) {
        return { found: false, reason: "entity is required (e.g. lock.front_door)" };
      }
      const state = await readHomeAssistantState({
        baseUrl: deps.baseUrl,
        entityId,
        token: deps.token,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.retryOptions ? { retryOptions: deps.retryOptions } : {})
      });
      if (state === undefined) {
        return { entity: entityId, found: false, reason: "no state returned (unknown entity or Home Assistant unreachable)" };
      }
      return { attributes: state.attributes as JsonObject, entity: state.entityId, found: true, state: state.state };
    }
  };
}

export function createHomeEntitiesTool(deps: HomeStateToolDeps): MuseTool {
  return {
    definition: {
      description:
        "List the user's Home Assistant entities (id + current state) to discover what devices exist and find the exact entity_id for home_state / home_action. Read-only. Optionally filter to one `domain` ('light'/'lock'/'sensor') AND/OR a `state` — pass `state` to answer 'what lights are ON?' ('light'+'on') or 'is anything unlocked / left open?' ('unlocked'/'open').",
      domain: "home",
      inputSchema: {
        additionalProperties: false,
        properties: {
          domain: { description: "Optional device type to filter to, e.g. 'light', 'lock', 'sensor' (omit for all).", type: "string" },
          state: { description: "Optional current-state filter (case-insensitive), e.g. 'on', 'unlocked', 'open' — returns only entities in that state.", type: "string" }
        },
        type: "object"
      },
      keywords: ["home", "smart-home", "devices", "entities", "list", "discover", "on", "off", "unlocked", "open", "homeassistant"],
      name: "home_entities",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const domain = typeof args["domain"] === "string" ? args["domain"].trim() : undefined;
      const stateFilter = typeof args["state"] === "string" ? args["state"].trim().toLowerCase() : undefined;
      const all = await listHomeAssistantStates({
        baseUrl: deps.baseUrl,
        token: deps.token,
        ...(domain ? { domain } : {}),
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.retryOptions ? { retryOptions: deps.retryOptions } : {})
      });
      const entities = stateFilter && stateFilter.length > 0
        ? all.filter((e) => e.state.toLowerCase() === stateFilter)
        : all;
      return {
        count: entities.length,
        entities: entities.map((e) => ({ entity: e.entityId, state: e.state })) as JsonObject[]
      };
    }
  };
}
